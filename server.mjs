import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Agent } from 'node:https';
import WebSocket from 'ws';
import { aisStreamUrl, eventFrame, recordPosition, subscription } from './ais-feed.mjs';
import { collectSailings } from './sailings-server.mjs';
import { salishMapPath, salishPartBytes, salishPartsPath } from './public/salish-map.js';

const apiKey = process.env.AISSTREAM_API_KEY?.trim();
const mode = apiKey ? 'live' : 'replay';
const fleet = JSON.parse(await readFile(new URL('./data/fleet.json', import.meta.url), 'utf8'));
const replayBootstrap = JSON.stringify({ mode: 'replay', feed: 'replay', fleet, reports: [] });
const vesselsByMmsi = new Map(fleet.filter(({ mmsi }) => mmsi).map((vessel) => [vessel.mmsi, vessel]));
const lastReports = new Map();
const streams = new Set();
let feed = apiKey ? 'connecting' : 'replay';
let retryDelay = 1000;
let sailingSnapshot = () => ({ conditions: null, history: [] });

const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/demo.js', ['public/demo.js', 'text/javascript; charset=utf-8']],
  ['/icons.js', ['public/icons.js', 'text/javascript; charset=utf-8']],
  ['/report-cache.js', ['public/report-cache.js', 'text/javascript; charset=utf-8']],
  ['/sw.js', ['public/sw.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/sailings.css', ['public/sailings.css', 'text/css; charset=utf-8']],
  ['/sailings.js', ['public/sailings.js', 'text/javascript; charset=utf-8']],
  ['/sailings-view.js', ['public/sailings-view.js', 'text/javascript; charset=utf-8']],
  ['/sailings-schedule.json', ['public/sailings-schedule.json', 'application/json']],
  ['/manifest.webmanifest', ['public/manifest.webmanifest', 'application/manifest+json']],
  ['/icons/coast-easy-192.png', ['public/icons/coast-easy-192.png', 'image/png']],
  ['/icons/coast-easy-512.png', ['public/icons/coast-easy-512.png', 'image/png']],
  ['/icons/coast-easy-maskable.png', ['public/icons/coast-easy-maskable.png', 'image/png']],
  ['/icons/apple-touch-icon.png', ['public/icons/apple-touch-icon.png', 'image/png']],
  ['/fonts/dm-sans.ttf', ['public/fonts/dm-sans.ttf', 'font/ttf']],
  ['/fonts/manrope.ttf', ['public/fonts/manrope.ttf', 'font/ttf']],
  ['/geography.json', ['public/geography.json', 'application/json']],
  ['/basemap.json', ['public/basemap.json', 'application/json']],
  ['/salish-map.js', ['public/salish-map.js', 'text/javascript; charset=utf-8']],
  ['/coast.json', ['public/coast.json', 'application/json']],
  ['/vendor/maplibre.js', ['node_modules/maplibre-gl/dist/maplibre-gl.js', 'text/javascript; charset=utf-8']],
  ['/vendor/maplibre.css', ['node_modules/maplibre-gl/dist/maplibre-gl.css', 'text/css; charset=utf-8']],
  ['/vendor/pmtiles.js', ['node_modules/pmtiles/dist/pmtiles.js', 'text/javascript; charset=utf-8']],
]);

const salishArchive = new URL('./public' + salishMapPath, import.meta.url);

async function serveSalishPart(request, response, part) {
  const { size } = await stat(salishArchive);
  const start = part * salishPartBytes;
  const end = Math.min(start + salishPartBytes, size) - 1;
  if (start > end || !Number.isSafeInteger(start)) {
    response.writeHead(404).end();
    return;
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable, no-transform',
    'Content-Length': end - start + 1,
  };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(salishArchive, { start, end });
  response.once('close', () => stream.destroy());
  stream.on('error', (error) => response.destroy(error));
  stream.pipe(response);
}

function broadcast(event, value) {
  const frame = eventFrame(event, value);
  for (const stream of streams) {
    if (stream.writableLength > 256 * 1024) stream.destroy();
    else stream.write(frame);
  }
}

function snapshot() {
  return { mode, feed, fleet, reports: [...lastReports.values()] };
}

function setFeed(next) {
  if (feed === next) return;
  feed = next;
  broadcast('feed', { feed });
}

function connectAis() {
  const socket = new WebSocket(aisStreamUrl, {
    agent: new Agent({ proxyEnv: process.env }),
    handshakeTimeout: 12_000,
    perMessageDeflate: true,
    maxPayload: 256 * 1024,
  });
  let receivedMessage = false;
  let watchdog = setTimeout(() => socket.terminate(), 20_000);

  function markTraffic() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => socket.terminate(), 120_000);
  }

  socket.on('open', () => {
    socket.send(subscription(apiKey, vesselsByMmsi));
  });

  socket.on('ping', () => {
    if (receivedMessage) markTraffic();
  });

  socket.on('message', (buffer) => {
    let event;
    try {
      event = JSON.parse(buffer.toString('utf8'));
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (event.error || event.Error) {
      setFeed('subscription-error');
      socket.terminate();
      return;
    }
    markTraffic();
    if (!receivedMessage) {
      receivedMessage = true;
      retryDelay = 1000;
      setFeed('connected');
    }
    const report = recordPosition(event, vesselsByMmsi, lastReports);
    if (report) broadcast('position', { id: report.id, position: report.position });
  });

  socket.on('error', () => {
    if (feed !== 'subscription-error') setFeed('reconnecting');
  });
  socket.on('close', () => {
    clearTimeout(watchdog);
    if (feed !== 'subscription-error') setFeed('reconnecting');
    const delay = retryDelay + Math.random() * 400;
    retryDelay = Math.min(retryDelay * 2, 30_000);
    setTimeout(connectAis, delay);
  });
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const mapPart = path.startsWith(salishPartsPath) && /^(\d+)\.bin$/.exec(path.slice(salishPartsPath.length));
  if (mapPart) {
    try { await serveSalishPart(request, response, Number(mapPart[1])); }
    catch { response.writeHead(404).end(); }
    return;
  }
  if (path === '/api/bootstrap') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(snapshot()));
    return;
  }
  if (path === '/api/sailings') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(sailingSnapshot()));
    return;
  }
  if (path === '/bootstrap.json') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : replayBootstrap);
    return;
  }
  if (path === '/api/events') {
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    response.write(eventFrame('snapshot', snapshot()));
    streams.add(response);
    response.on('close', () => streams.delete(response));
    return;
  }
  const file = staticFiles.get(path);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL('./' + file[0], import.meta.url));
    response.writeHead(200, {
      'Content-Type': file[1],
      'Cache-Control': path.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
      'Content-Length': body.length,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
});

setInterval(() => {
  broadcast('heartbeat', null);
}, 15_000).unref();

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
  console.log('Coast Easy listening on port %d (%s)', port, mode);
  if (apiKey) connectAis();
  try {
    sailingSnapshot = collectSailings();
  } catch (error) {
    console.warn('Coast Easy sailing collector unavailable:', error.message);
  }
});
