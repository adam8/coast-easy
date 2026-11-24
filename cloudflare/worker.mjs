import { DurableObject } from 'cloudflare:workers';
import { aisStreamUrl, eventFrame, recordPosition, subscription } from '../ais-feed.mjs';
import fleet from '../data/fleet.json';

const vesselsByMmsi = new Map(fleet.filter(({ mmsi }) => mmsi).map((vessel) => [vessel.mmsi, vessel]));
const decoder = new TextDecoder();
const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const streamHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform' };

function bootstrap(method, mode, feed, reports) {
  const body = method === 'HEAD' ? null : JSON.stringify({ mode, feed, fleet, reports });
  return new Response(body, { headers: jsonHeaders });
}

export class FleetFeed extends DurableObject {
  reports = new Map();
  clients = new Set();
  feed = 'connecting';
  socket = null;
  watchdog;
  heartbeat;
  retryTimer;
  retryDelay = 1000;
  savedAt = 0;

  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('positions');
      for (const [id, position] of saved ?? []) {
        this.reports.set(id, { id, position, trail: [position] });
      }
    });
  }

  fetch(request) {
    if (new URL(request.url).pathname === '/api/bootstrap') {
      return bootstrap(request.method, 'live', this.feed, [...this.reports.values()]);
    }
    const [browser, client] = Object.values(new WebSocketPair());
    client.accept();
    this.clients.add(client);
    const disconnected = () => this.removeClient(client);
    client.addEventListener('error', disconnected);
    client.addEventListener('close', disconnected);
    client.send(JSON.stringify({
      event: 'snapshot',
      value: { mode: 'live', feed: this.feed, fleet, reports: [...this.reports.values()] },
    }));
    if (this.clients.size === 1) {
      this.heartbeat = setInterval(() => this.broadcast('heartbeat', null), 15_000);
      this.connect();
    }
    return new Response(null, { status: 101, webSocket: browser });
  }

  broadcast(event, value) {
    const frame = JSON.stringify({ event, value });
    for (const client of this.clients) {
      try {
        client.send(frame);
      } catch {
        this.removeClient(client);
      }
    }
  }

  removeClient(client) {
    if (!this.clients.delete(client)) return;
    if (client.readyState < WebSocket.CLOSING) client.close(1000);
    if (this.clients.size) return;
    clearInterval(this.heartbeat);
    clearTimeout(this.retryTimer);
    this.closeSocket();
    this.feed = 'connecting';
    this.retryDelay = 1000;
  }

  closeSocket() {
    const socket = this.socket;
    this.socket = null;
    clearTimeout(this.watchdog);
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000);
  }

  setFeed(feed) {
    if (feed === this.feed) return;
    this.feed = feed;
    this.broadcast('feed', { feed });
  }

  retry(feed) {
    this.closeSocket();
    this.setFeed(feed);
    if (!this.clients.size) return;
    const delay = this.retryDelay + Math.random() * 400;
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  watch(socket, delay) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (socket === this.socket) this.retry('reconnecting');
    }, delay);
  }

  connect() {
    if (this.socket || !this.clients.size) return;
    let socket;
    try {
      socket = new WebSocket(aisStreamUrl);
      socket.binaryType = 'arraybuffer';
    } catch {
      this.retry('reconnecting');
      return;
    }
    this.socket = socket;
    this.watch(socket, 30_000);

    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.watch(socket, 20_000);
      socket.send(subscription(this.env.AISSTREAM_API_KEY.trim(), vesselsByMmsi));
    });
    socket.addEventListener('message', ({ data }) => {
      if (socket === this.socket) this.handleMessage(socket, data);
    });
    const disconnected = () => {
      if (socket === this.socket) this.retry('reconnecting');
    };
    socket.addEventListener('error', disconnected);
    socket.addEventListener('close', disconnected);
  }

  handleMessage(socket, data) {
    let event;
    try {
      event = JSON.parse(typeof data === 'string' ? data : decoder.decode(data));
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (event.error || event.Error) {
      this.retry('subscription-error');
      return;
    }
    const now = Date.now();
    this.watch(socket, 120_000);
    this.retryDelay = 1000;
    this.setFeed('connected');
    const report = recordPosition(event, vesselsByMmsi, this.reports, now);
    if (!report) return;
    this.broadcast('position', { id: report.id, position: report.position });
    if (now - this.savedAt < 60_000) return;
    this.savedAt = now;
    const positions = [...this.reports.values()].map(({ id, position }) => [id, position]);
    this.ctx.waitUntil(this.ctx.storage.put('positions', positions).catch(() => {
      this.savedAt = 0;
      console.warn('Coast Easy could not save the last known AIS positions.');
    }));
  }
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const live = Boolean(env.AISSTREAM_API_KEY?.trim());
    if (pathname === '/api/bootstrap' && !live) return bootstrap(request.method, 'replay', 'replay', []);
    if (live && pathname === '/api/events' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      const body = request.method === 'HEAD' ? null : eventFrame('transport', 'websocket');
      return new Response(body, { headers: streamHeaders });
    }
    if (live && (pathname === '/api/bootstrap' || pathname === '/api/events')) {
      return env.FLEET_FEED.getByName('bc-ferries').fetch(request);
    }
    return new Response(null, { status: 404 });
  },
};
