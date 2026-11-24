import {
  clock, conditionsUrl, dateOf, decodeConditions, departureDelay, directions,
  isFresh, localNow, mergeReports, midnight, minutesPerDay, shortDate, terminals, timetable, weekdayName,
} from './sailings.js';

const byId = (id) => document.getElementById(id);
const routeStep = byId('trip-route-step');
const routeSummary = routeStep.querySelector('summary');
const fromInput = byId('trip-from');
const toInput = byId('trip-to');
const blankDestination = toInput.options[0];
const swapPorts = byId('trip-swap');
const dateInput = byId('trip-date');
const pills = byId('trip-pills');
const pillsMessage = byId('trip-pills-message');
const drawerConditionsLink = byId('drawer-conditions-link');
const conditionsIndex = drawerConditionsLink.href;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const storageKey = 'coast-easy:sailing-reports:v1';
let schedule;
let scheduleRequest;
let conditions = loadSaved();
let refreshInProgress = false;
let updatesAvailable = false;
let preferredDeparture = null;
let renderedDay;
let updateMap;

dateInput.value = dateOf(localNow());
const portOptions = Object.entries(terminals).sort((a, b) => a[1].localeCompare(b[1]));
fromInput.append(...portOptions.map(([code, name]) => new Option(name, code)));
setDestinations();

function setDestinations(preferred = toInput.value) {
  const destinations = Object.values(directions).filter(({ from }) => from === fromInput.value);
  toInput.replaceChildren(blankDestination, ...destinations.map(({ to }) => new Option(terminals[to], to)));
  toInput.disabled = destinations.length === 0;
  toInput.value = destinations.find(({ to }) => to === preferred)?.to
    ?? (destinations.length === 1 ? destinations[0].to : '');
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.routes && Array.isArray(saved.reports)) return saved;
  } catch {
    // The planner also works when browser storage is disabled.
  }
  return { routes: {}, reports: [] };
}

function saveReports() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(conditions));
  } catch {
    // Keep the current session usable when storage is full.
  }
}

function timeWithDay(stamp, date) {
  return clock(stamp) + (dateOf(stamp) === date ? '' : ' · ' + shortDate(stamp));
}

function arrivalLabel(trip) {
  if (Number.isFinite(trip.report?.actualArrival)) return 'Arrived';
  if (Number.isFinite(trip.expected)) return 'Expected arrival';
  if (Number.isFinite(trip.inferredArrival)) return 'Estimated from departure';
  return trip.approximate ? 'Approx. arrival' : 'Scheduled arrival';
}

function makePill(trip, date, selected) {
  const pill = element('button', '', 'trip-pill');
  const departure = clock(trip.scheduled);
  const arrival = timeWithDay(trip.arrival, date);
  const details = [trip.status === 'Scheduled' ? '' : trip.status, trip.approximate ? 'Approx. arrival' : '']
    .filter(Boolean).join(' · ');
  pill.type = 'button';
  pill.disabled = !trip.selectable;
  pill.dataset.departure = String(trip.scheduled);
  pill.setAttribute('aria-pressed', String(selected));
  pill.setAttribute('aria-label', `Departs ${departure}, arrives ${arrival}${details ? ', ' + details : ''}`);
  pill.append(element('span', `${departure} → ${arrival}`, 'trip-pill-times'));
  if (details) pill.append(element('span', details, 'trip-pill-status'));
  return pill;
}

function updatePillTabStop() {
  pills.tabIndex = pills.scrollWidth > pills.clientWidth + 1 ? 0 : -1;
}

function pillScrollPosition(pill) {
  const left = pills.scrollLeft + pill.getBoundingClientRect().left - pills.getBoundingClientRect().left;
  return Math.max(0, Math.min(left, pills.scrollWidth - pills.clientWidth));
}

function renderPills(trips, selected, direction, date, message = '') {
  if (pillsMessage.textContent !== message) pillsMessage.textContent = message;
  pills.hidden = !trips.length;
  const dayKey = trips.length ? `${direction}:${date}` : undefined;
  const sameDay = dayKey === renderedDay;
  const buttons = trips.map((trip) => makePill(trip, date, trip === selected));
  if (sameDay && buttons.length === pills.childElementCount &&
    buttons.every((button, index) => button.isEqualNode(pills.children[index]))) return;

  const focused = pills.contains(document.activeElement) ? document.activeElement.dataset.departure : undefined;
  const oldScroll = pills.scrollLeft;
  pills.replaceChildren(...buttons);
  renderedDay = dayKey;
  if (!buttons.length) return;
  const selectedPill = buttons[trips.indexOf(selected)];
  pills.scrollTo({ left: sameDay ? oldScroll : selectedPill ? pillScrollPosition(selectedPill) : 0, behavior: 'instant' });
  updatePillTabStop();
  if (focused !== undefined) {
    const replacement = sameDay && buttons.find((button) => button.dataset.departure === focused && !button.disabled);
    (replacement || pills).focus({ preventScroll: true });
  }
}

function fillTable(container, labels, rows, emptyText) {
  if (!rows.length) {
    container.replaceChildren(element('p', emptyText, 'trip-table-message'));
    return;
  }
  const wrap = element('div', '', 'trip-table-wrap');
  const table = element('table', '', 'trip-table');
  const heading = table.createTHead().insertRow();
  for (const label of labels) {
    const header = element('th', label);
    header.scope = 'col';
    heading.append(header);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) {
      const td = tr.insertCell();
      if (Array.isArray(value)) {
        td.textContent = value[0];
        if (value[1]) td.append(element('small', value[1]));
      } else td.textContent = value;
    }
  }
  wrap.append(table);
  container.replaceChildren(wrap);
}

function renderHistory(direction, now) {
  const cutoff = localNow(now) - 30 * minutesPerDay;
  const history = conditions.reports.filter((trip) => trip.direction === direction &&
    Number.isFinite(trip.actual) && trip.scheduled >= cutoff).sort((a, b) => b.scheduled - a.scheduled);
  byId('trip-history-count').textContent = history.length ? 'Latest ' + Math.min(history.length, 20) + ' of ' + history.length : '';
  fillTable(byId('trip-history'), ['Date', 'Scheduled', 'Departed', 'Difference'], history.slice(0, 20).map((trip) => [
    shortDate(trip.scheduled), [clock(trip.scheduled), trip.vessel],
    timeWithDay(trip.actual, dateOf(trip.scheduled)), departureDelay(trip),
  ]), 'Confirmed departures will appear here as reports come in.');
}

function render() {
  const direction = fromInput.value + toInput.value;
  const route = directions[direction];
  const date = dateInput.value;
  const start = midnight(date);
  const now = Date.now();
  const online = navigator.onLine && updatesAvailable;
  const from = route ? terminals[route.from] : null;
  const to = route ? terminals[route.to] : null;
  routeSummary.hidden = !route;
  swapPorts.disabled = !route;
  if (!route) routeStep.open = true;
  byId('trip-route-summary').textContent = route ? `${from} → ${to}` : '';
  byId('trip-date-weekday').textContent = start === null ? 'Choose a day' : weekdayName(start);
  const validDate = schedule && start !== null && date >= schedule.validFrom && date <= schedule.validTo;
  const trips = route && validDate ? timetable(schedule, direction, date, conditions, now, online) : [];
  const chosen = trips.find((trip) => trip.selectable && trip.scheduled === preferredDeparture)
    ?? trips.find((trip) => trip.selectable);
  const timingUpdates = [];
  if (Number.isFinite(chosen?.estimatedDeparture) && chosen.estimatedDeparture !== chosen.scheduled) {
    timingUpdates.push(`Expected departure ${timeWithDay(chosen.estimatedDeparture, date)}`);
  }
  if (chosen && chosen.effectiveArrival !== chosen.arrival) {
    timingUpdates.push(`${arrivalLabel(chosen)} ${timeWithDay(chosen.effectiveArrival, date)}`);
  }
  updateMap({ from, to, summary: timingUpdates.join(' · ') });
  byId('trip-sailing-step').hidden = !route;
  byId('trip-service').hidden = !route;
  byId('trip-records').hidden = !route;
  byId('trip-conditions-source').hidden = !route;
  drawerConditionsLink.href = route?.conditions ?? conditionsIndex;
  if (!route) {
    renderPills([], null, direction, date);
    byId('trip-timetable-date').textContent = '';
    byId('trip-timetable').replaceChildren();
    byId('trip-history-count').textContent = '';
    byId('trip-history').replaceChildren();
    return;
  }
  const source = conditions.routes[direction];
  const fresh = Boolean(online && source?.available && isFresh(source.observedAt, now));
  const status = byId('trip-freshness');
  const savedAt = Number.isFinite(source?.observedAt) ? localNow(source.observedAt) : null;
  status.dataset.live = String(fresh);
  if (savedAt !== null) {
    const state = !navigator.onLine ? 'Offline' : fresh ? 'Live conditions' : 'Saved conditions';
    status.textContent = state + ' · Checked ' + shortDate(savedAt) + ', ' + clock(savedAt);
  } else {
    status.textContent = navigator.onLine ? 'Timetable · Live conditions unavailable' : 'Offline · Saved timetable';
  }
  byId('trip-booking').hidden = direction !== 'HSBNAN';
  byId('trip-conditions-link').href = route.conditions;
  renderHistory(direction, now);

  byId('trip-timetable-date').textContent = validDate ? shortDate(start) : '';
  if (!validDate) {
    const note = start === null ? 'Choose a sailing date.' : schedule
      ? 'The saved timetable covers ' + shortDate(midnight(schedule.validFrom)) + ' to ' + shortDate(midnight(schedule.validTo)) + '.'
      : scheduleRequest ? 'Loading timetable…' : 'The timetable is unavailable. Reopen Coast Easy while online to save a copy.';
    renderPills([], null, direction, date, note);
    fillTable(byId('trip-timetable'), [], [], note);
    return;
  }

  const emptyDay = 'No sailings are scheduled for this date.';
  fillTable(byId('trip-timetable'), ['Scheduled', 'Reported departure', 'Arrival', 'Status'], trips.map((trip) => [
    [timeWithDay(trip.scheduled, date), trip.report?.vessel],
    Number.isFinite(trip.report?.actual)
      ? [timeWithDay(trip.report.actual, date), departureDelay(trip.report)]
      : trip.estimatedDeparture === null ? '—' : [timeWithDay(trip.estimatedDeparture, date), 'Expected'],
    trip.cancelled ? '—' : [timeWithDay(trip.effectiveArrival, date), arrivalLabel(trip)],
    trip.status,
  ]), emptyDay);
  renderPills(trips, chosen, direction, date, trips.length ? '' : emptyDay);
}

async function json(url, timeout = 6000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error('Sailing data request failed');
  return response.json();
}

async function refresh() {
  if (refreshInProgress || !navigator.onLine) return;
  refreshInProgress = true;
  try {
    const backend = await json('/api/sailings', 3000).catch(() => null);
    const archived = (backend?.history ?? []).map((record) => ({
      ...record, estimatedArrival: null, estimatedDeparture: null,
      status: record.actualArrival !== null ? 'arrived' : 'departed',
    }));
    const next = backend?.conditions ?? await json(conditionsUrl).then(decodeConditions).catch(() => null);
    const cutoff = localNow() - 30 * minutesPerDay;
    const saved = loadSaved();
    conditions = {
      routes: { ...saved.routes, ...conditions.routes, ...next?.routes },
      reports: mergeReports(mergeReports(saved.reports, conditions.reports), [...archived, ...(next?.reports ?? [])])
        .filter((trip) => trip.scheduled >= cutoff),
    };
    updatesAvailable = Boolean(next);
    saveReports();
  } catch {
    updatesAvailable = false;
  } finally {
    refreshInProgress = false;
    render();
  }
}

function loadSchedule() {
  scheduleRequest ??= json('/sailings-schedule.json').then((value) => {
    schedule = value;
    dateInput.min = value.validFrom;
    dateInput.max = value.validTo;
    render();
  }).catch(() => {
    scheduleRequest = undefined;
    render();
  });
  render();
  void refresh();
}

export function showSailings(onMapChange) {
  updateMap = onMapChange;
  loadSchedule();
}

function editPlan() {
  preferredDeparture = null;
  render();
}

function collapseRoute() {
  if (directions[fromInput.value + toInput.value]) routeStep.open = false;
}

let pointerLeavingRoute = false;
document.addEventListener('pointerdown', (event) => {
  pointerLeavingRoute = !routeStep.contains(event.target);
}, true);
for (const event of ['keydown', 'pointercancel']) {
  document.addEventListener(event, () => { pointerLeavingRoute = false; }, true);
}
routeStep.addEventListener('focusout', (event) => {
  if (!pointerLeavingRoute && event.relatedTarget && !routeStep.contains(event.relatedTarget)) collapseRoute();
});
document.addEventListener('pointerup', (event) => {
  // WebKit may not dispatch a click for a tap on plain text or whitespace.
  if (event.pointerType === 'touch' && pointerLeavingRoute && !routeStep.contains(event.target) &&
    !event.target.closest('a, button, input, label, select, summary, textarea, [tabindex]')) {
    pointerLeavingRoute = false;
    collapseRoute();
  }
}, true);
document.addEventListener('click', (event) => {
  if (routeStep.contains(event.target)) return;
  if (!routeStep.open || routeSummary.hidden) {
    pointerLeavingRoute = false;
    return;
  }
  // Let the tapped row activate before collapsing changes its position.
  requestAnimationFrame(() => {
    pointerLeavingRoute = false;
    collapseRoute();
  });
}, true);
pills.addEventListener('click', (event) => {
  const pill = event.target.closest('.trip-pill:not(:disabled)');
  if (!pill) return;
  preferredDeparture = Number(pill.dataset.departure);
  collapseRoute();
  render();
});
pills.addEventListener('keydown', (event) => {
  if (event.target !== pills || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const step = event.key === 'ArrowLeft' ? -1 : 1;
  const stops = Array.from(pills.children, pillScrollPosition);
  if (step < 0) stops.reverse();
  const left = stops.find((stop) => (stop - pills.scrollLeft) * step > 1);
  if (left !== undefined) pills.scrollTo({ left, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
});
new ResizeObserver(updatePillTabStop).observe(pills);

fromInput.addEventListener('change', () => {
  setDestinations();
  editPlan();
});
toInput.addEventListener('change', editPlan);
swapPorts.addEventListener('click', () => {
  const origin = fromInput.value;
  fromInput.value = toInput.value;
  setDestinations(origin);
  editPlan();
});
dateInput.addEventListener('input', editPlan);
window.addEventListener('offline', () => render());
window.addEventListener('online', loadSchedule);
setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
