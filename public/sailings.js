const capacityConditionsUrl = 'https://bcferriesapi.ca/v2/capacity/';
const nonCapacityConditionsUrl = 'https://bcferriesapi.ca/v2/noncapacity/';
export const terminals = {
  CMX: 'Comox (Little River)',
  NAN: 'Departure Bay',
  DUK: 'Duke Point',
  HSB: 'Horseshoe Bay',
  LNG: 'Langdale',
  PWR: 'Powell River (Westview)',
  TSA: 'Tsawwassen',
  SWB: 'Swartz Bay',
};
const routes = [
  ['NAN', 'HSB', 100],
  ['TSA', 'SWB', 95],
  ['TSA', 'DUK', 120],
  ['HSB', 'LNG', 40],
  ['CMX', 'PWR', 90],
];
export const directions = Object.fromEntries(routes.flatMap(([a, b, duration]) =>
  [[a, b], [b, a]].map(([from, to]) => [from + to, {
    from, to, duration,
    conditions: `https://www.bcferries.com/current-conditions/${from}-${to}`,
  }]),
));
export const freshFor = 10 * 60_000;
export const minutesPerDay = 1440;
const minute = 60_000;
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const weekdayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', weekday: 'long' });
const timeFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12: true });

// The major routes use British Columbia's year-round UTC−07:00 Pacific time.
export const localNow = (now = Date.now()) => Math.floor(now / minute) - 420;
export const dateOf = (stamp) => new Date(stamp * minute).toISOString().slice(0, 10);
export const shortDate = (stamp) => dayFormat.format(stamp * minute);
export const weekdayName = (stamp) => weekdayFormat.format(stamp * minute);
export const clock = (stamp) => timeFormat.format(stamp * minute);
export const inputClock = (stamp) => new Date(stamp * minute).toISOString().slice(11, 16);
export function midnight(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  const stamp = Date.parse(date + 'T00:00:00Z') / minute;
  return Number.isFinite(stamp) && dateOf(stamp) === date ? stamp : null;
}

export function clockMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const mins = Number(match[2]);
  if (mins > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (match[3]) hour = hour % 12 + (match[3].toLowerCase() === 'p' ? 12 : 0);
  return hour * 60 + mins;
}

function reportedTime(value, date, near) {
  const mins = clockMinutes(value);
  const start = midnight(date);
  if (mins === null || start === null) return null;
  const stamp = start + mins;
  if (near === undefined) return stamp;
  return stamp + Math.round((near - stamp) / minutesPerDay) * minutesPerDay;
}

function observation(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : null;
}

export function decodeConditions(payload) {
  if (!Array.isArray(payload?.routes)) throw new Error('Sailing reports unavailable');
  const routes = {};
  const reports = [];
  for (const route of payload.routes) {
    const { routeCode: direction } = route;
    if (!Object.hasOwn(directions, direction)) continue;
    const observedAt = observation(route.observedAt);
    routes[direction] = {
      observedAt,
      available: route.dataStatus === 'available' && payload.meta?.stale !== true,
    };
    for (const sailing of route.sailings ?? []) {
      const scheduled = reportedTime(sailing.scheduledTime, sailing.serviceDate);
      if (scheduled === null) continue;
      const actual = reportedTime(sailing.actualDepartureTime, sailing.serviceDate, scheduled);
      const arrivalBase = (actual ?? scheduled) + directions[direction].duration;
      reports.push({
        direction, scheduled, actual,
        estimatedDeparture: reportedTime(sailing.estimatedDepartureTime, sailing.serviceDate, scheduled),
        estimatedArrival: reportedTime(sailing.estimatedArrivalTime, sailing.arrivalDate ?? sailing.serviceDate, arrivalBase),
        actualArrival: reportedTime(sailing.actualArrivalTime, sailing.arrivalDate ?? sailing.serviceDate, arrivalBase),
        vessel: typeof sailing.vesselName === 'string' ? sailing.vesselName : '',
        status: sailing.isCancelled || ['cancelled', 'canceled'].includes(sailing.status) ? 'cancelled' : sailing.status ?? 'unknown',
        observedAt: observation(sailing.statusObservedAt ?? sailing.observedAt) ?? observedAt,
      });
    }
  }
  if (!Object.keys(routes).length) throw new Error('No reports for the major routes');
  return { routes, reports };
}

function decodeNonCapacityConditions(payload) {
  if (!Array.isArray(payload?.routes)) throw new Error('Sailing reports unavailable');
  // This endpoint's overall freshness describes schedules. Live reports carry their own observation times.
  return decodeConditions({
    routes: payload.routes.filter((route) => route.currentConditions).map((route) => ({
      ...route.currentConditions,
      routeCode: route.routeCode,
    })),
  });
}

export async function fetchConditions(readJson) {
  const [capacity, nonCapacity] = await Promise.allSettled([
    readJson(capacityConditionsUrl).then(decodeConditions),
    readJson(nonCapacityConditionsUrl).then(decodeNonCapacityConditions),
  ]);
  if (capacity.status === 'rejected' && nonCapacity.status === 'rejected') throw capacity.reason;
  const capacityRoutes = capacity.value?.routes ?? {};
  return {
    routes: { ...nonCapacity.value?.routes, ...capacityRoutes },
    reports: [
      ...(capacity.value?.reports ?? []),
      ...(nonCapacity.value?.reports ?? []).filter(({ direction }) => !Object.hasOwn(capacityRoutes, direction)),
    ],
  };
}

export function isFresh(observedAt, now) {
  return Number.isFinite(observedAt) && observedAt <= now + minute && now - observedAt <= freshFor;
}

export const reportKey = ({ direction, scheduled }) => direction + ':' + scheduled;

export function mergeReports(older, incoming) {
  const saved = new Map(older.map((record) => [reportKey(record), record]));
  for (const record of incoming) {
    const key = reportKey(record);
    const previous = saved.get(key);
    if (!previous) {
      saved.set(key, record);
      continue;
    }
    const newest = (record.observedAt ?? 0) >= (previous.observedAt ?? 0) ? record : previous;
    const other = newest === record ? previous : record;
    saved.set(key, {
      ...newest, actual: newest.actual ?? other.actual, actualArrival: newest.actualArrival ?? other.actualArrival,
    });
  }
  return [...saved.values()];
}

export function timetable(schedule, direction, date, conditions, now, online) {
  const start = midnight(date);
  if (start === null) return [];
  const local = localNow(now);
  const live = conditions.routes[direction];
  const byTime = new Map((schedule.directions[direction]?.[date] ?? []).map(([depart, arrive]) => [
    start + depart, { scheduled: start + depart, arrival: start + arrive, approximate: false },
  ]));
  const dayReports = conditions.reports.filter((record) =>
    record.direction === direction && record.scheduled >= start && record.scheduled < start + minutesPerDay);
  for (const report of dayReports) {
    const planned = byTime.get(report.scheduled) ?? {
      scheduled: report.scheduled, arrival: report.scheduled + directions[direction].duration, approximate: true,
    };
    byTime.set(report.scheduled, { ...planned, report });
  }

  return [...byTime.values()].sort((a, b) => a.scheduled - b.scheduled).map((trip) => {
    const record = trip.report;
    const fresh = Boolean(online && live?.available && isFresh(live.observedAt, now) && isFresh(record?.observedAt, now));
    const estimatedDeparture = fresh ? record.estimatedDeparture : null;
    const cancelled = record?.status === 'cancelled' && record.actual === null;
    const departed = Number.isFinite(record?.actual) || ['departed', 'arrived', 'underway'].includes(record?.status);
    const arrived = record?.status === 'arrived' || Number.isFinite(record?.actualArrival);
    const expected = fresh && !cancelled && !arrived && Number.isFinite(record.estimatedArrival) && record.estimatedArrival >= local
      ? record.estimatedArrival : null;
    const departureBasedArrival = fresh && departed && !arrived && Number.isFinite(record.actual)
      ? record.actual + trip.arrival - trip.scheduled : null;
    const inferredArrival = expected === null && departureBasedArrival !== null && departureBasedArrival >= local
      ? departureBasedArrival : null;
    const past = (estimatedDeparture ?? trip.scheduled) < local;
    let status = 'Scheduled';
    if (cancelled) status = fresh ? 'Cancelled' : 'Last reported cancelled';
    else if (arrived) status = 'Arrived';
    else if (departed) status = 'Departed';
    else if (fresh && record.status === 'delayed') status = 'Delayed';
    else if (past) status = 'Departure unconfirmed';
    return {
      ...trip, status, cancelled, expected, inferredArrival, estimatedDeparture,
      effectiveArrival: record?.actualArrival ?? expected ?? inferredArrival ?? trip.arrival,
      selectable: !cancelled && !arrived && !departed && !past,
    };
  });
}

export function nearbySailings(schedule, direction, date, target, conditions, now, online) {
  const dates = [-1, 0, 1].map((offset) => dateOf(midnight(date) + offset * minutesPerDay));
  const options = dates.flatMap((day) => day < schedule.validFrom || day > schedule.validTo
    ? [] : timetable(schedule, direction, day, conditions, now, online)).filter((trip) => trip.selectable);
  options.sort((a, b) => a.effectiveArrival - b.effectiveArrival || a.scheduled - b.scheduled);
  return {
    before: options.filter((trip) => trip.effectiveArrival <= target).slice(-2),
    after: options.filter((trip) => trip.effectiveArrival > target).slice(0, 2),
  };
}

export function describeMinutes(mins) {
  const hours = Math.floor(Math.abs(mins) / 60);
  const remainder = Math.abs(mins) % 60;
  return [hours ? hours + ' hr' : '', remainder || !hours ? remainder + ' min' : ''].filter(Boolean).join(' ');
}

export function departureDelay(report) {
  if (!Number.isFinite(report?.actual)) return '';
  const delay = report.actual - report.scheduled;
  return delay === 0 ? 'On time' : describeMinutes(delay) + (delay > 0 ? ' late' : ' early');
}
