import { createReplay } from './demo.js';
import { icon } from './icons.js';
import { loadReports, mergeReport, recentTrail, saveReports, trailWindow } from './report-cache.js';
import { hasSavedSalishMap, salishBasemap, salishMapBounds, saveSalishMap } from './salish-map.js';
import { terminals } from './sailings.js';
import { showSailings } from './sailings-view.js';

const byId = (id) => document.getElementById(id);
const fleetList = byId('fleet-list');
const fleetPanel = byId('fleet-panel');
const appDrawer = byId('app-drawer');
const menuToggle = byId('menu-toggle');
const drawerClose = byId('drawer-close');
const drawerBack = byId('drawer-back');
const drawerMenu = byId('drawer-menu');
const drawerPanel = byId('drawer-panel');
const drawerTitle = byId('drawer-title');
const drawerEntries = Array.from(drawerMenu.querySelectorAll('button[aria-controls]'), (button) => {
  const content = byId(button.getAttribute('aria-controls'));
  const home = content.parentElement;
  const summary = home.querySelector(':scope > summary');
  return { button, content, home, next: content.nextElementSibling, summary, caption: summary?.lastElementChild };
});
const feedBadge = byId('feed-badge');
const masthead = document.querySelector('.masthead');
const planner = byId('sailings');
const plannerLayout = planner.querySelector('.sailings-layout');
const mapContainer = byId('map');
const mapToolbar = byId('map-toolbar');
const mapViewActions = byId('map-view-actions');
const mapSectionHeader = byId('map-view').querySelector('.map-section-header');
const sailingSummary = byId('map-sailing');
const mapMessage = byId('map-message');
const mapOptions = byId('map-options');
const mapOptionsToggle = byId('map-options-toggle');
const mapRegion = byId('map-region');
const mapBasemap = byId('map-basemap');
const mapDownload = byId('map-download');
const mapDownloadStatus = byId('map-download-status');
const speedChart = byId('speed-chart');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const compactLayout = matchMedia('(max-width: 710px), (max-width: 950px) and (max-height: 500px)');
const sidePlanner = matchMedia('(min-width: 640px) and (max-width: 950px) and (max-height: 500px)');
const minute = 60_000;
const mapTerminalNames = { CMX: 'Little River', PWR: 'Westview' };
const regions = {
  salish: salishMapBounds,
  coast: [[-132.60, 48.26], [-122.42, 54.63]],
  north: [[-132.60, 51.64], [-126.80, 54.58]],
};
const feedLabels = {
  replay: 'Demo replay',
  offline: 'Offline',
  connecting: 'Connecting',
  connected: 'AIS connected',
  reconnecting: 'Feed disconnected',
  'subscription-error': 'AIS key or feed error',
};
const compactFeedLabels = {
  replay: 'Demo',
  offline: 'Offline',
  connecting: 'Syncing',
  connected: 'Live',
  reconnecting: 'No signal',
  'subscription-error': 'Feed error',
};

const state = {
  mode: 'replay',
  feed: 'connecting',
  offline: !navigator.onLine,
  fleet: [],
  reports: new Map(),
  now: Date.now(),
  selected: null,
  filter: 'all',
  search: '',
  region: 'salish',
  routesVisible: true,
  elapsed: 0,
  paused: false,
};
const markers = new Map();
const emptyFeatures = { type: 'FeatureCollection', features: [] };
let map;
let geography;
let mapReady = false;
let activeBasemap = 'standard';
let basemapRequest = 0;
let prefersSalish = false;
let salishSaved = false;
let savingSalish = false;
let mapLoadTimer;
let tileErrors = 0;
let eventStream;
let useLiveWebSocket = false;
let heartbeatTimer;
let saveTimer;
let listSignature = '';
let renderQueued = false;
let tripPorts;
let plannedCrossing;
let cameraFocus = 'region';
let layoutFrame = 0;
let drawerExit;
let drawerEntry;
let drawerDrag;

try { prefersSalish = localStorage.getItem('coast-easy:basemap') === 'salish'; } catch { /* The map also works without storage. */ }

for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon);

if (navigator.maxTouchPoints > 0) {
  // Safari also reports viewport pinches as gesture events, separate from the map's touch events.
  const preventPageZoom = (event) => event.preventDefault();
  document.addEventListener('gesturestart', preventPageZoom, { passive: false });
  document.addEventListener('gesturechange', preventPageZoom, { passive: false });
}

const installButton = byId('install-toggle');
let installPrompt;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = undefined;
  installButton.hidden = true;
  await prompt.prompt().catch(() => {});
});
window.addEventListener('appinstalled', () => {
  installPrompt = undefined;
  installButton.hidden = true;
});

function statusFor(position) {
  if (!position) return 'waiting';
  if (state.mode === 'live' && state.now - position.time > 5 * minute) return 'stale';
  if (position.speed === null) return 'reporting';
  return position.speed > 1 ? 'underway' : 'still';
}

function statusLabel(status) {
  return { waiting: 'Awaiting report', reporting: 'Reporting', underway: 'Underway', still: 'Still', stale: 'Last seen' }[status];
}

function elapsedLabel(time) {
  const seconds = Math.max(0, Math.floor((state.now - time) / 1000));
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
  return Math.floor(seconds / 86400) + ' d ago';
}

function direction(course) {
  if (typeof course !== 'number') return '—';
  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return Math.round(course) % 360 + '° ' + compass[Math.round(course / 45) % compass.length];
}

function renderFleet() {
  const vessels = state.fleet.map((vessel) => {
    const report = state.reports.get(vessel.id);
    return { ...vessel, report, status: statusFor(report?.position) };
  });
  const tracked = vessels.filter(({ status }) => ['underway', 'still', 'reporting'].includes(status)).length;
  const underway = vessels.filter(({ status }) => status === 'underway').length;
  const still = vessels.filter(({ status }) => status === 'still').length;
  byId('tracked-count').textContent = tracked;
  byId('underway-count').textContent = underway;
  byId('still-count').textContent = still;
  byId('fleet-caption').textContent = state.fleet.length + ' vessels in the fleet roster';

  const visible = vessels.filter((vessel) => {
    const matchesFilter = state.filter === 'all' || vessel.status === state.filter;
    const searchable = [vessel.name, vessel.mmsi, vessel.report?.route?.name].join(' ').toLowerCase();
    return matchesFilter && searchable.includes(state.search);
  }).sort((a, b) => {
    const rank = (vessel) => vessel.id === state.selected ? 0 : vessel.report ? 1 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  const signature = JSON.stringify(visible.map(({ id, status }) => [id, status, id === state.selected]));
  if (signature === listSignature) return;
  listSignature = signature;
  const scroll = fleetList.scrollTop;
  const focusedId = document.activeElement?.dataset?.vesselId;
  const fragment = document.createDocumentFragment();
  if (!visible.length) {
    const message = document.createElement('p');
    message.className = 'empty-list';
    message.textContent = 'No vessels match this view.';
    fragment.append(message);
  }
  for (const vessel of visible) {
    const button = document.createElement('button');
    button.className = 'fleet-row';
    button.type = 'button';
    button.dataset.vesselId = vessel.id;
    button.setAttribute('aria-pressed', String(vessel.id === state.selected));
    button.innerHTML = '<span class="fleet-avatar">' + icon('ship') + '</span>'
      + '<span><span class="row-name"></span><span class="row-secondary"></span></span>'
      + '<span class="row-state"><i class="dot"></i><span></span></span>';
    button.querySelector('.row-name').textContent = vessel.name;
    button.querySelector('.row-secondary').textContent = vessel.report?.route?.name
      ?? (vessel.mmsi ? 'MMSI ' + vessel.mmsi : 'BC Ferries roster');
    const status = button.querySelector('.row-state');
    status.dataset.status = vessel.status;
    status.lastElementChild.textContent = statusLabel(vessel.status);
    status.firstElementChild.classList.add(vessel.status);
    button.addEventListener('click', () => {
      selectVessel(vessel.id, true);
      closeDrawer();
    });
    fragment.append(button);
  }
  fleetList.replaceChildren(fragment);
  fleetList.scrollTop = scroll;
  if (focusedId) {
    fleetList.querySelector('[data-vessel-id="' + CSS.escape(focusedId) + '"]')?.focus({ preventScroll: true });
  }
}

function renderFeed() {
  const status = state.offline ? 'offline' : state.feed;
  feedBadge.dataset.feed = status;
  byId('feed-label').textContent = feedLabels[status] ?? 'Connecting';
  byId('compact-feed-label').textContent = compactFeedLabels[status] ?? 'Syncing';
  const toggle = byId('replay-toggle');
  toggle.hidden = state.mode !== 'replay';
  toggle.firstElementChild.innerHTML = icon(state.paused ? 'play' : 'pause');
  byId('replay-label').textContent = state.paused ? 'Play' : 'Pause';
  if (state.mode === 'replay') {
    byId('fleet-source').textContent = 'Simulated positions along BC Ferries routes';
  } else if (state.offline || state.feed !== 'connected') {
    byId('fleet-source').textContent = state.reports.size ? 'Showing last known AIS positions' : 'Waiting for an AIS connection';
  } else {
    byId('fleet-source').textContent = 'Vessel positions via AIS Stream';
  }
}

function renderSpeed(report) {
  const width = Math.max(1, Math.round(speedChart.clientWidth));
  const height = 37;
  const ratio = devicePixelRatio || 1;
  speedChart.width = width * ratio;
  speedChart.height = height * ratio;
  const ctx = speedChart.getContext('2d');
  ctx.scale(ratio, ratio);
  const end = report?.position.time ?? state.now;
  const points = recentTrail(report?.trail ?? [], end).filter((point) => Number.isFinite(point.speed));
  ctx.strokeStyle = '#dce7f0';
  ctx.beginPath();
  ctx.moveTo(0, height - 3);
  ctx.lineTo(width, height - 3);
  ctx.stroke();
  if (points.length < 2) {
    ctx.font = '12px DM Sans, Arial, sans-serif';
    ctx.fillStyle = '#576f84';
    ctx.fillText('Awaiting speed history', 0, 22);
    return;
  }
  const maxSpeed = Math.max(8, ...points.map(({ speed }) => speed)) * 1.12;
  let previous = null;
  ctx.strokeStyle = '#17558f';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const point of points) {
    const x = Math.max(1, Math.min(width - 1, (1 - (end - point.time) / trailWindow) * width));
    const y = height - 4 - (point.speed / maxSpeed) * (height - 8);
    if (!previous || point.time - previous.time > 2 * minute) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    previous = point;
  }
  ctx.stroke();
}

function renderDetails() {
  const vessel = state.fleet.find(({ id }) => id === state.selected);
  const card = byId('vessel-card');
  card.hidden = !vessel;
  if (!vessel) return;
  const report = state.reports.get(vessel.id);
  const position = report?.position;
  byId('vessel-name').textContent = vessel.name;
  byId('vessel-route').textContent = report?.route
    ? 'Route ' + report.route.number + ' · ' + report.route.name
    : (vessel.mmsi ? 'MMSI ' + vessel.mmsi : 'BC Ferries roster');
  byId('vessel-speed').textContent = Number.isFinite(position?.speed) ? position.speed.toFixed(1) + ' kn' : '—';
  byId('vessel-course').textContent = direction(position?.course ?? position?.heading);
  byId('vessel-seen').textContent = position ? elapsedLabel(position.time) : 'Awaiting';
  byId('chart-window').textContent = state.mode === 'live' ? '15 min before last report' : '15 min';
  renderSpeed(report);
}

function filteredMarkers(vessel, report) {
  const filter = state.filter === 'all' || state.filter === statusFor(report?.position);
  const search = [vessel.name, vessel.mmsi, report?.route?.name].join(' ').toLowerCase().includes(state.search);
  return filter && search;
}

function updateVesselMarkerScale() {
  const progress = Math.max(0, Math.min(1, (map.getZoom() - 5) / (12 - 5)));
  const scale = .4 + progress * (1.45 - .4);
  map.getCanvasContainer().style.setProperty('--vessel-marker-scale', String(scale));
}

function positionMarker(vessel, position, status) {
  let item = markers.get(vessel.id);
  if (!item) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'marker';
    element.title = vessel.name;
    element.setAttribute('aria-label', 'Select ' + vessel.name);
    const symbol = document.createElement('span');
    symbol.className = 'marker-symbol';
    symbol.setAttribute('aria-hidden', 'true');
    element.append(symbol);
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      selectVessel(vessel.id, false);
    });
    const marker = new maplibregl.Marker({ element, rotationAlignment: 'map' });
    item = { marker, element, symbol };
    markers.set(vessel.id, item);
  }
  if (item.element.dataset.status !== status) {
    item.element.dataset.status = status;
    item.symbol.innerHTML = status === 'still' ? icon('anchor') : '<span class="pointer"></span>';
  }
  item.element.classList.toggle('is-selected', state.selected === vessel.id);
  item.marker.setLngLat([position.lon, position.lat]).setRotation(status === 'still' ? 0 : (position.course ?? position.heading ?? 0));
  if (!item.element.isConnected) item.marker.addTo(map);
}

function wakeFeatures() {
  const features = [];
  for (const vessel of state.fleet) {
    const report = state.reports.get(vessel.id);
    if (!report?.trail || !filteredMarkers(vessel, report)) continue;
    if (statusFor(report.position) === 'still') continue;
    const end = report.position.time;
    const points = recentTrail(report.trail, end);
    const strength = statusFor(report.position) === 'stale' ? .4 : 1;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (b.time - a.time > 2 * minute || (a.lon === b.lon && a.lat === b.lat)) continue;
      features.push({
        type: 'Feature',
        properties: { selected: vessel.id === state.selected, freshness: strength * (1 - (end - b.time) / trailWindow) },
        geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function renderMap() {
  if (!mapReady) return;
  for (const vessel of state.fleet) {
    const report = state.reports.get(vessel.id);
    if (report?.position && filteredMarkers(vessel, report)) {
      positionMarker(vessel, report.position, statusFor(report.position));
    } else {
      markers.get(vessel.id)?.marker.remove();
    }
  }
  map.getSource('wakes')?.setData(wakeFeatures());
  const route = state.reports.get(state.selected)?.route;
  map.setFilter('route-selected', ['==', ['get', 'id'], route?.id ?? '']);
}

function render() {
  renderQueued = false;
  renderFleet();
  renderDetails();
  renderMap();
}

function queueRender() {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(render);
  }
}

function selectVessel(id, moveMap) {
  state.selected = id;
  const pos = state.reports.get(id)?.position;
  if (moveMap && mapReady && pos) {
    cameraFocus = null;
    const padding = compactLayout.matches ? compactMapPadding() : null;
    map.easeTo({
      center: [pos.lon, pos.lat],
      zoom: Math.max(8.2, map.getZoom()),
      offset: padding ? [(padding.left - padding.right) / 2, (padding.top - padding.bottom) / 2 - 35] : [0, -45],
      duration: reducedMotion.matches ? 0 : 650,
    });
  }
  queueRender();
}

function compactMapPadding() {
  const view = mapContainer.getBoundingClientRect();
  const card = planner.getBoundingClientRect();
  const topOverlay = sidePlanner.matches ? masthead.getBoundingClientRect() : card;
  const attribution = mapContainer.querySelector('.maplibregl-ctrl-attrib');
  const attributionTop = attribution?.getBoundingClientRect().top ?? view.bottom;
  const bottom = Math.min(Math.max(24, view.bottom - attributionTop + 10), view.height * .32);
  return {
    top: Math.max(16, Math.min(topOverlay.bottom - view.top + 20, view.height - bottom - 48)),
    right: 54,
    bottom,
    left: sidePlanner.matches ? card.right - view.left + 54 : 54,
  };
}

function fitRegion(animated = false) {
  if (!map) return;
  cameraFocus = 'region';
  map.fitBounds(regions[state.region], {
    padding: compactLayout.matches ? compactMapPadding() : { top: 50, left: 25, right: 25, bottom: 75 },
    duration: animated && !reducedMotion.matches ? 650 : 0,
    maxZoom: 9.4,
  });
}

function findPlannedCrossing() {
  if (!geography || !tripPorts) return null;
  const { from, to } = tripPorts;
  const route = geography.routes.features.find(({ properties }) =>
    (properties.from === from && properties.to === to) || (properties.from === to && properties.to === from));
  if (!route) return null;
  const [origin, destination] = [from, to].map((name) =>
    geography.terminals.features.find(({ properties }) => properties.name === name)?.geometry.coordinates);
  const lines = route.geometry.coordinates;
  if (!origin || !destination || lines.length === 1) return { type: 'LineString', coordinates: lines[0] };
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const endpointDistance = (line) => Math.min(
    distance(origin, line[0]) + distance(destination, line.at(-1)),
    distance(destination, line[0]) + distance(origin, line.at(-1)),
  );
  const [coordinates] = [...lines].sort((a, b) => endpointDistance(a) - endpointDistance(b));
  return { type: 'LineString', coordinates };
}

function fitPlannedCrossing() {
  if (!map || !plannedCrossing) return;
  cameraFocus = 'crossing';
  const bounds = new maplibregl.LngLatBounds();
  for (const point of plannedCrossing.coordinates) bounds.extend(point);
  map.fitBounds(bounds, {
    padding: compactLayout.matches ? compactMapPadding() : { top: 82, right: 56, bottom: 69, left: 38 },
    duration: 0,
    maxZoom: 10,
  });
}

function fitMap() {
  if (plannedCrossing) fitPlannedCrossing();
  else fitRegion();
}

function updateMapLayout() {
  if (!compactLayout.matches || layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    if (!compactLayout.matches) return;
    const overlay = sidePlanner.matches ? masthead : planner;
    const depth = overlay.getBoundingClientRect().bottom - mapContainer.getBoundingClientRect().top;
    mapContainer.parentElement.style.setProperty('--planner-depth', Math.max(0, depth) + 'px');
    if (!map || !cameraFocus) return;
    map.resize();
    if (cameraFocus === 'crossing' && plannedCrossing) fitPlannedCrossing();
    else fitRegion();
  });
}

function updateSailingMap({ from, to, summary }) {
  if (sailingSummary.textContent !== summary) sailingSummary.textContent = summary;
  sailingSummary.hidden = !summary;
  const [origin, destination] = [from, to].map((port) => mapTerminalNames[port] ?? terminals[port]);
  if (origin !== tripPorts?.from || destination !== tripPorts?.to) {
    tripPorts = { from: origin, to: destination };
    plannedCrossing = findPlannedCrossing();
    const crossing = byId('map-crossing');
    crossing.textContent = from && to ? `${terminals[from]} → ${terminals[to]}` : '';
    crossing.hidden = !from || !to;
    updateCrossingLayers();
    if (compactLayout.matches) {
      cameraFocus = plannedCrossing ? 'crossing' : 'region';
      updateMapLayout();
    } else if (plannedCrossing) fitPlannedCrossing();
  }
}

function updateCrossingLayers() {
  if (!map?.getSource('planned-crossing')) return;
  map.getSource('planned-crossing').setData(plannedCrossing ?? emptyFeatures);
  const names = [tripPorts?.from, tripPorts?.to].filter(Boolean);
  const isPlanned = ['in', ['get', 'name'], ['literal', names]];
  map.setFilter('terminal-points', ['!', isPlanned]);
  map.setFilter('terminal-labels', ['!', isPlanned]);
  map.setFilter('planned-terminal-points', isPlanned);
  map.setFilter('planned-terminal-labels', isPlanned);
}

function addMarineLayers() {
  map.addSource('routes', { type: 'geojson', data: geography.routes });
  map.addSource('terminals', { type: 'geojson', data: geography.terminals });
  map.addSource('wakes', { type: 'geojson', data: emptyFeatures });
  map.addSource('planned-crossing', { type: 'geojson', data: plannedCrossing ?? emptyFeatures });
  map.addLayer({
    id: 'route-lines', source: 'routes', type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#527796', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 9, 1.4, 14, 2], 'line-dasharray': [2, 2.7], 'line-opacity': .38 },
  });
  map.addLayer({
    id: 'route-selected', source: 'routes', type: 'line',
    filter: ['==', ['get', 'id'], ''],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#527796', 'line-width': 2.5, 'line-opacity': .76, 'line-dasharray': [1.6, 2] },
  });
  map.addLayer({
    id: 'route-planned-outline', source: 'planned-crossing', type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f6faff', 'line-width': 6, 'line-opacity': .9 },
  });
  map.addLayer({
    id: 'route-planned', source: 'planned-crossing', type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#17558f', 'line-width': 3.5 },
  });
  map.addLayer({
    id: 'wakes', source: 'wakes', type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['get', 'selected'], '#104477', '#397eae'],
      'line-width': ['case', ['get', 'selected'], 4, 2.8],
      'line-opacity': ['interpolate', ['linear'], ['get', 'freshness'], 0, .07, 1, .95],
    },
  });
  map.addLayer({
    id: 'terminal-points', source: 'terminals', type: 'circle',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.75, 8, 2.75, 12, 4.5, 16, 5.25],
      'circle-color': '#f5faff', 'circle-stroke-color': '#527796', 'circle-stroke-width': 1.25, 'circle-stroke-opacity': .75,
    },
  });
  const terminalText = {
    'text-field': ['get', 'name'],
    'text-font': map.getStyle().glyphs ? ['Noto Sans Regular'] : ['Arial'],
    'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
    'text-radial-offset': .68, 'text-padding': 4, 'text-max-width': 14,
  };
  map.addLayer({
    id: 'terminal-labels', source: 'terminals', type: 'symbol',
    layout: {
      ...terminalText,
      'text-size': ['interpolate', ['linear'], ['zoom'], 5, 9, 9, 10, 13, 13.5, 16, 14.5],
      'text-variable-anchor': ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
      'text-padding': 2,
      'symbol-sort-key': ['case', ['==', ['get', 'label'], true], 0, 1],
    },
    paint: { 'text-color': '#36546f', 'text-halo-color': '#eef2f5', 'text-halo-width': 1.4 },
  });
  map.addLayer({
    id: 'planned-terminal-points', source: 'terminals', type: 'circle',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4.5, 12, 5.75, 16, 6.5],
      'circle-color': '#f5faff', 'circle-stroke-color': '#17558f', 'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'planned-terminal-labels', source: 'terminals', type: 'symbol',
    layout: {
      ...terminalText,
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 13, 13, 15, 16, 16.5],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#163d63', 'text-halo-color': '#f6faff', 'text-halo-width': 2 },
  });
  updateCrossingLayers();
  setRoutesVisibility();
  mapReady = true;
  queueRender();
}

function setRoutesVisibility() {
  const visibility = state.routesVisible ? 'visible' : 'none';
  for (const layer of ['route-lines', 'route-selected', 'terminal-points', 'terminal-labels']) {
    if (map?.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visibility);
  }
}

function coastStyle() {
  return {
    version: 8,
    sources: { coastline: { type: 'geojson', data: '/coast.json', attribution: 'Natural Earth' } },
    layers: [
      { id: 'water', type: 'background', paint: { 'background-color': '#c8dff0' } },
      { id: 'land', type: 'fill', source: 'coastline', paint: { 'fill-color': '#eef2f5', 'fill-outline-color': '#bccbd6' } },
    ],
  };
}

function updateMapMessage() {
  const message = activeBasemap === 'coast'
    ? (state.offline ? 'Offline map · Coastline and ferry routes' : 'Using the built-in coastline while basemap tiles are unavailable.')
    : activeBasemap === 'salish-saved' && state.offline ? 'Offline map · Saved Salish Sea' : '';
  if (mapMessage.textContent !== message) mapMessage.textContent = message;
  mapMessage.hidden = !message;
}

function watchBasemap() {
  clearTimeout(mapLoadTimer);
  tileErrors = 0;
  if (activeBasemap !== 'coast') {
    mapLoadTimer = setTimeout(() => {
      if (!mapReady) useFallbackMap();
    }, 9000);
  }
  updateMapMessage();
}

async function setBasemap(next) {
  const request = ++basemapRequest;
  if (!map || activeBasemap === next) return;
  let style;
  try {
    if (next === 'standard') style = '/basemap.json';
    else if (next === 'coast') style = coastStyle();
    else style = await salishBasemap(next === 'salish-saved');
  } catch {
    if (request === basemapRequest) useFallbackMap(next);
    return;
  }
  if (request !== basemapRequest) return;
  activeBasemap = next;
  mapReady = false;
  map.setMaxBounds(next.startsWith('salish') ? salishMapBounds : null);
  map.setStyle(style, { diff: false });
  watchBasemap();
}

function useFallbackMap(failed = activeBasemap) {
  if (failed.startsWith('salish')) {
    mapDownloadStatus.textContent = 'The Salish Sea map could not load.';
    void setBasemap(state.offline ? 'coast' : 'standard');
  } else void setBasemap('coast');
}

function syncMapOptions() {
  mapBasemap.value = prefersSalish ? 'salish' : 'standard';
  mapDownload.hidden = !prefersSalish && !salishSaved;
  mapDownload.disabled = savingSalish || salishSaved || state.offline;
  mapDownload.textContent = salishSaved ? 'Salish Sea map saved' : savingSalish ? 'Downloading Salish Sea map…' : 'Download Salish Sea map · 15.4 MB';
}

function refreshBasemap() {
  syncMapOptions();
  if (prefersSalish && state.region === 'salish' && salishSaved) void setBasemap('salish-saved');
  else if (prefersSalish && state.region === 'salish' && !state.offline) void setBasemap('salish');
  else void setBasemap(state.offline ? 'coast' : 'standard');
  if (map) updateMapMessage();
}

function selectBasemap(salish) {
  prefersSalish = salish;
  if (salish) state.region = mapRegion.value = 'salish';
  mapDownloadStatus.textContent = salish && state.offline && !salishSaved ? 'Connect to download the Salish Sea map.' : '';
  try { localStorage.setItem('coast-easy:basemap', salish ? 'salish' : 'standard'); } catch { /* Keep the selection for this session. */ }
  refreshBasemap();
}

function initMap() {
  activeBasemap = state.offline ? 'coast' : 'standard';
  try {
    map = new maplibregl.Map({
      container: 'map', style: state.offline ? coastStyle() : '/basemap.json',
      center: [-123.78, 49.2], zoom: 7.6, minZoom: 4, maxZoom: 16,
      attributionControl: { compact: false },
      dragRotate: false, pitchWithRotate: false,
      cooperativeGestures: !compactLayout.matches,
    });
  } catch {
    mapMessage.textContent = 'This browser could not open the interactive map.';
    mapMessage.hidden = false;
    return;
  }
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('zoom', updateVesselMarkerScale);
  fitMap();
  updateVesselMarkerScale();
  map.on('movestart', (event) => { if (event.originalEvent) cameraFocus = null; });
  map.on('error', (event) => {
    if (activeBasemap.startsWith('salish') && event.sourceId === 'salish') useFallbackMap();
    else if (activeBasemap !== 'coast' && ++tileErrors >= 4) useFallbackMap();
  });
  map.on('style.load', addMarineLayers);
  watchBasemap();
  const terminalLayers = ['terminal-points', 'planned-terminal-points'];
  map.on('click', terminalLayers, (event) => {
    const terminal = event.features?.[0];
    if (!terminal) return;
    new maplibregl.Popup({ offset: 6, closeButton: false })
      .setLngLat(terminal.geometry.coordinates)
      .setText(terminal.properties.name + ' ferry terminal')
      .addTo(map);
  });
  map.on('mouseenter', terminalLayers, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', terminalLayers, () => { map.getCanvas().style.cursor = ''; });
  if (prefersSalish) refreshBasemap();
}

showSailings(updateSailingMap);

function loadSnapshot(snapshot) {
  state.feed = snapshot.feed;
  state.fleet = snapshot.fleet;
  const vesselIds = new Set(state.fleet.map(({ id }) => id));
  const reports = new Map([...state.reports].filter(([id]) => vesselIds.has(id)));
  for (const report of snapshot.reports) {
    if (vesselIds.has(report.id)) reports.set(report.id, mergeReport(reports.get(report.id), report));
  }
  state.reports = reports;
}

function flushReports() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  saveReports(state.reports);
}

function scheduleSave() {
  saveTimer ??= setTimeout(flushReports, 1200);
}

function markFeedInterrupted() {
  state.feed = 'reconnecting';
  flushReports();
  renderFeed();
}

function watchFeed(delay = 45_000) {
  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    markFeedInterrupted();
    connectLive();
  }, delay);
}

function connectLive() {
  eventStream?.close();
  eventStream = null;
  clearTimeout(heartbeatTimer);
  if (state.offline) return;
  const handlers = {
    heartbeat() {},
    transport(transport) {
      if (transport === 'websocket' && !useLiveWebSocket) {
        useLiveWebSocket = true;
        connectLive();
      }
    },
    snapshot(snapshot) {
      if (snapshot.mode !== 'live') {
        markFeedInterrupted();
        return;
      }
      loadSnapshot(snapshot);
      scheduleSave();
      renderFeed();
      queueRender();
    },
    feed({ feed }) {
      state.feed = feed;
      renderFeed();
    },
    position({ id, position }) {
      const prior = state.reports.get(id);
      if (prior && prior.position.time >= position.time) return;
      state.now = Date.now();
      state.reports.set(id, {
        id, position, trail: recentTrail([...(prior?.trail ?? []), position], position.time),
      });
      scheduleSave();
      queueRender();
    },
  };
  const receive = (event, value) => {
    if (!Object.hasOwn(handlers, event)) return;
    watchFeed();
    handlers[event](value);
  };
  watchFeed();

  if (useLiveWebSocket) {
    const url = new URL('/api/events', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    eventStream = socket;
    socket.addEventListener('message', ({ data }) => {
      if (eventStream !== socket) return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message) receive(message.event, message.value);
    });
    socket.addEventListener('close', () => {
      if (eventStream !== socket) return;
      markFeedInterrupted();
      watchFeed(2000);
    });
    return;
  }

  const events = new EventSource('/api/events');
  eventStream = events;
  for (const event of Object.keys(handlers)) {
    events.addEventListener(event, ({ data }) => {
      if (eventStream === events) receive(event, JSON.parse(data));
    });
  }
  events.addEventListener('error', () => {
    if (eventStream === events) markFeedInterrupted();
  });
}

function startLive() {
  saveReports(state.reports);
  connectLive();
  setInterval(() => {
    state.now = Date.now();
    queueRender();
  }, 5000);
  window.addEventListener('pagehide', flushReports);
}

function startReplay() {
  const replay = createReplay(geography);
  const update = () => {
    const { now, reports } = replay(state.elapsed);
    state.now = now;
    state.reports = new Map(reports.map((report) => [report.id, report]));
    queueRender();
  };

  update();
  setInterval(() => {
    if (state.paused) return;
    state.elapsed += 12_000;
    update();
  }, 1000);
}

function closeDrawer(velocity = 0, distance = 0) {
  if (!appDrawer.open || drawerExit) return;
  drawerDrag = undefined;
  if (reducedMotion.matches) {
    appDrawer.close();
    return;
  }
  const transform = getComputedStyle(appDrawer).transform;
  for (const animation of appDrawer.getAnimations()) animation.cancel();
  appDrawer.style.removeProperty('transform');
  const duration = velocity > 0
    ? Math.max(90, Math.min(220, (appDrawer.offsetWidth - distance) / (velocity + .8)))
    : 220;
  const exit = appDrawer.animate([
    { transform },
    { transform: 'translateX(100%)' },
  ], { duration, easing: velocity > 0 ? 'ease-out' : 'ease-in', fill: 'forwards' });
  drawerExit = exit;
  exit.finished.then(() => { if (drawerExit === exit) appDrawer.close(); }, () => {});
}

function returnDrawerDrag() {
  if (drawerDrag?.active && appDrawer.open && !reducedMotion.matches) {
    appDrawer.animate([
      { transform: appDrawer.style.transform },
      { transform: 'none' },
    ], { duration: 180, easing: 'ease-out' });
  }
  drawerDrag = undefined;
  appDrawer.style.removeProperty('transform');
}

function showDrawerView(entry) {
  drawerEntry = entry;
  drawerMenu.hidden = Boolean(entry);
  drawerPanel.hidden = !entry;
  drawerBack.hidden = !entry;
  drawerTitle.textContent = entry?.button.textContent.trim() ?? 'Menu';
  for (const { content, caption, summary } of drawerEntries) {
    const active = content === entry?.content;
    content.hidden = !active;
    if (caption) (active ? drawerTitle.parentElement : summary).append(caption);
  }
  byId('drawer-record-empty').hidden = !entry || entry.content === fleetPanel || entry.content.hasChildNodes();
  drawerPanel.scrollTop = 0;
}

function syncDrawerLayout() {
  const regionControl = byId('map-region-control');
  if (compactLayout.matches) {
    drawerPanel.append(...drawerEntries.map(({ content }) => content));
    showDrawerView();
    byId('compact-map-controls').append(regionControl);
    menuToggle.before(mapViewActions);
    byId('trip-service').before(sailingSummary);
    plannerLayout.append(mapMessage);
  } else {
    if (appDrawer.open) appDrawer.close();
    showDrawerView();
    for (const { content, home, next } of drawerEntries) {
      home.insertBefore(content, next);
      content.hidden = false;
    }
    byId('desktop-map-controls').append(regionControl);
    mapToolbar.append(mapViewActions);
    mapSectionHeader.append(sailingSummary);
    mapToolbar.after(mapMessage);
  }
  if (!map) return;
  if (compactLayout.matches) map.cooperativeGestures.disable();
  else map.cooperativeGestures.enable();
  map.resize();
  fitMap();
}

menuToggle.addEventListener('click', () => {
  if (!compactLayout.matches || appDrawer.open) return;
  showDrawerView();
  appDrawer.showModal();
  menuToggle.setAttribute('aria-expanded', 'true');
  drawerClose.focus({ preventScroll: true });
});
mapOptionsToggle.addEventListener('click', () => {
  mapOptions.showModal();
  mapOptionsToggle.setAttribute('aria-expanded', 'true');
});
byId('map-options-close').addEventListener('click', () => mapOptions.close());
mapOptions.addEventListener('click', (event) => {
  if (event.target === mapOptions) {
    const box = mapOptions.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) mapOptions.close();
  }
});
mapOptions.addEventListener('close', () => {
  mapOptionsToggle.setAttribute('aria-expanded', 'false');
  mapOptionsToggle.focus({ preventScroll: true });
});
for (const entry of drawerEntries) entry.button.addEventListener('click', () => {
  showDrawerView(entry);
  drawerBack.focus({ preventScroll: true });
});
drawerBack.addEventListener('click', () => {
  const previous = drawerEntry;
  showDrawerView();
  previous?.button.focus({ preventScroll: true });
});
drawerClose.addEventListener('click', () => closeDrawer());
appDrawer.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1) {
    returnDrawerDrag();
    return;
  }
  if (drawerExit || appDrawer.getAnimations().some((animation) => animation.playState === 'running')) return;
  const { identifier, clientX, clientY } = event.touches[0];
  const target = document.elementFromPoint(clientX, clientY);
  if (!target || target === appDrawer || !appDrawer.contains(target) ||
    target.closest('input, select, textarea, [contenteditable]')) return;
  const table = target.closest('.trip-table-wrap');
  if (table && table.scrollWidth > table.clientWidth) return;
  drawerDrag = {
    identifier, clientX, clientY, active: false,
    samples: [{ x: clientX, time: event.timeStamp }],
  };
}, { passive: true });
appDrawer.addEventListener('touchmove', (event) => {
  const drag = drawerDrag;
  if (!drag) return;
  const touch = event.touches[0];
  if (event.touches.length !== 1 || touch.identifier !== drag.identifier || !event.cancelable) {
    returnDrawerDrag();
    return;
  }
  const horizontal = touch.clientX - drag.clientX;
  const vertical = Math.abs(touch.clientY - drag.clientY);
  if (!drag.active) {
    if (Math.max(Math.abs(horizontal), vertical) < 8) return;
    if (horizontal < 8 || horizontal < vertical * 1.5) {
      drawerDrag = undefined;
      return;
    }
    drag.active = true;
  }
  event.preventDefault();
  const distance = Math.max(0, Math.min(appDrawer.offsetWidth, horizontal));
  appDrawer.style.transform = `translateX(${distance}px)`;
  drag.samples = drag.samples.filter(({ time }) => time >= event.timeStamp - 100);
  drag.samples.push({ x: touch.clientX, time: event.timeStamp });
}, { passive: false });
appDrawer.addEventListener('touchcancel', returnDrawerDrag);
appDrawer.addEventListener('touchend', (event) => {
  const drag = drawerDrag;
  if (!drag) return;
  const touch = event.changedTouches[0];
  if (!drag.active || event.touches.length || touch?.identifier !== drag.identifier) {
    returnDrawerDrag();
    return;
  }
  if (event.cancelable) event.preventDefault();
  const distance = Math.max(0, Math.min(appDrawer.offsetWidth, touch.clientX - drag.clientX));
  const recent = drag.samples.find(({ time }) => event.timeStamp - time <= 100 && event.timeStamp > time);
  const velocity = recent ? (touch.clientX - recent.x) / (event.timeStamp - recent.time) : 0;
  const flicked = velocity >= .5 && distance >= 12;
  if (distance >= 36 || flicked) {
    appDrawer.style.transform = `translateX(${distance}px)`;
    closeDrawer(flicked ? velocity : 0, distance);
  } else {
    returnDrawerDrag();
  }
}, { passive: false });
appDrawer.addEventListener('click', (event) => {
  if (event.target === appDrawer) closeDrawer();
});
appDrawer.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDrawer();
});
appDrawer.addEventListener('close', () => {
  for (const animation of appDrawer.getAnimations()) animation.cancel();
  drawerExit = undefined;
  drawerDrag = undefined;
  appDrawer.style.removeProperty('transform');
  menuToggle.setAttribute('aria-expanded', 'false');
  if (compactLayout.matches) menuToggle.focus({ preventScroll: true });
});
compactLayout.addEventListener('change', syncDrawerLayout);
syncDrawerLayout();
const mapLayoutObserver = new ResizeObserver(updateMapLayout);
mapLayoutObserver.observe(planner);
mapLayoutObserver.observe(mapContainer);
sidePlanner.addEventListener('change', updateMapLayout);

byId('fleet-search').addEventListener('input', (event) => {
  state.search = event.target.value.trim().toLowerCase();
  queueRender();
});
for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    for (const item of document.querySelectorAll('[data-filter]')) {
      item.setAttribute('aria-pressed', String(item === button));
    }
    queueRender();
  });
}
byId('replay-toggle').addEventListener('click', () => {
  state.paused = !state.paused;
  renderFeed();
});
mapRegion.addEventListener('change', (event) => {
  state.region = event.target.value;
  if (state.region !== 'salish' && prefersSalish) selectBasemap(false);
  mapOptions.close();
  fitRegion(true);
});
mapBasemap.addEventListener('change', () => {
  selectBasemap(mapBasemap.value === 'salish');
  fitMap();
});
mapDownload.addEventListener('click', async () => {
  if (savingSalish || salishSaved || state.offline) return;
  savingSalish = true;
  mapDownloadStatus.textContent = '';
  syncMapOptions();
  try {
    await saveSalishMap();
    salishSaved = true;
    mapDownloadStatus.textContent = 'The detailed map is ready for offline use.';
  } catch {
    mapDownloadStatus.textContent = 'The map could not be saved. Try again when connected.';
  } finally {
    savingSalish = false;
    refreshBasemap();
  }
});
byId('reset-view').addEventListener('click', fitMap);
for (const [id, zoom] of [['zoom-in', 1], ['zoom-out', -1]]) {
  byId(id).addEventListener('click', () => {
    if (!map) return;
    cameraFocus = null;
    map.zoomTo(map.getZoom() + zoom, { duration: reducedMotion.matches ? 0 : 220 });
    mapOptions.close();
  });
}
byId('routes-toggle').addEventListener('click', (event) => {
  state.routesVisible = !state.routesVisible;
  event.currentTarget.setAttribute('aria-pressed', String(state.routesVisible));
  setRoutesVisibility();
});
byId('dismiss-vessel').addEventListener('click', () => selectVessel(null, false));
window.addEventListener('resize', queueRender);

function setOffline(offline) {
  if (state.offline === offline) return;
  state.offline = offline;
  if (state.mode === 'live') {
    markFeedInterrupted();
    connectLive();
  } else {
    renderFeed();
  }
  refreshBasemap();
  queueRender();
}

async function checkOrigin() {
  if (!navigator.onLine) return;
  try {
    const response = await fetch('/bootstrap.json', {
      method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(3500),
    });
    if (navigator.onLine) setOffline(!response.ok);
  } catch {
    if (navigator.onLine) setOffline(true);
  }
}

async function getJson(path) {
  const response = await fetch(path, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Could not load ' + path);
  return { value: await response.json(), offline: response.headers.has('X-Coast-Easy-Offline') };
}

try {
  const live = navigator.onLine ? getJson('/api/bootstrap').catch(() => null) : null;
  const [{ value: routes }, bundled, backend] = await Promise.all([getJson('/geography.json'), getJson('/bootstrap.json'), live]);
  const saved = loadReports();
  const snapshot = backend?.value ?? bundled.value;
  geography = routes;
  plannedCrossing = findPlannedCrossing();
  state.mode = backend ? snapshot.mode : (saved ? 'live' : 'replay');
  state.offline = !navigator.onLine || bundled.offline;
  if (state.mode === 'live') state.reports = new Map((saved ?? []).map((report) => [report.id, report]));
  loadSnapshot(snapshot);
  if (state.mode === 'live' && !backend) state.feed = 'reconnecting';
  renderFeed();
  if (state.mode === 'live') startLive();
  else startReplay();
  salishSaved = await hasSavedSalishMap();
  syncMapOptions();
  initMap();
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', checkOrigin);
  setInterval(() => {
    if (state.mode === 'replay' || state.offline) checkOrigin();
  }, 20_000);
  queueRender();
} catch {
  byId('fleet-caption').textContent = 'The fleet data could not be loaded. Refresh to retry.';
  byId('feed-label').textContent = navigator.onLine ? 'Data unavailable' : 'Offline';
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
