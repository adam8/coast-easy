export const aisStreamUrl = 'wss://stream.aisstream.io/v0/stream';

const trailWindow = 15 * 60 * 1000;

export function subscription(apiKey, vesselsByMmsi) {
  return JSON.stringify({
    APIKey: apiKey,
    BoundingBoxes: [[[56, -136], [47, -122]]],
    FiltersShipMMSI: [...vesselsByMmsi.keys()].map(String),
    FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
  });
}

export function eventFrame(event, value) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n';
}

function utcTime(value, now) {
  if (typeof value !== 'string') return now;
  const normalized = value.replace(' +0000 UTC', 'Z').replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && parsed <= now + 60_000 ? parsed : now;
}

function numberInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export function recordPosition(event, vesselsByMmsi, reports, now = Date.now()) {
  const raw = event.Message?.[event.MessageType];
  const metadata = event.MetaData;
  if (!raw || raw.Valid === false) return null;
  const vessel = vesselsByMmsi.get(Number(metadata?.MMSI ?? raw.UserID));
  if (!vessel) return null;
  const lat = numberInRange(raw.Latitude ?? metadata?.Latitude ?? metadata?.latitude, 46, 57);
  const lon = numberInRange(raw.Longitude ?? metadata?.Longitude ?? metadata?.longitude, -137, -121);
  if (lat === null || lon === null) return null;

  const time = utcTime(metadata?.time_utc, now);
  const last = reports.get(vessel.id);
  if (last && last.position.time >= time) return null;
  const position = {
    lat, lon, time,
    speed: numberInRange(raw.Sog, 0, 102.2),
    course: numberInRange(raw.Cog, 0, 359.9),
    heading: numberInRange(raw.TrueHeading, 0, 359),
    navStatus: numberInRange(raw.NavigationalStatus ?? raw.NavStatus, 0, 15),
  };
  const trail = [...(last?.trail ?? []), position]
    .filter((point) => time - point.time <= trailWindow)
    .slice(-360);
  const report = { id: vessel.id, position, trail };
  reports.set(vessel.id, report);
  return report;
}
