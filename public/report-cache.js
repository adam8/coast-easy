const cacheKey = 'coast-easy:ais-reports:v1';
export const trailWindow = 15 * 60_000;
const maxPoints = 360;

export function recentTrail(points, reportTime) {
  return points.filter((point) => point.time >= reportTime - trailWindow && point.time <= reportTime)
    .slice(-maxPoints);
}

export function mergeReport(previous, incoming) {
  if (!previous) return incoming;

  const position = previous.position.time > incoming.position.time ? previous.position : incoming.position;
  const points = new Map();
  for (const point of [...previous.trail, ...incoming.trail, previous.position, incoming.position]) {
    points.set(point.time, point);
  }
  const trail = [...points.values()].sort((a, b) => a.time - b.time);
  return { id: incoming.id, position, trail: recentTrail(trail, position.time) };
}

export function loadReports() {
  try {
    const reports = JSON.parse(localStorage.getItem(cacheKey));
    if (Array.isArray(reports)) return reports.filter((report) =>
      typeof report?.id === 'string' && Number.isFinite(report.position?.time) && Array.isArray(report.trail));
  } catch {
    // Browser storage can be unavailable in private or restricted sessions.
  }
  return null;
}

export function saveReports(reports) {
  try {
    localStorage.setItem(cacheKey, JSON.stringify([...reports.values()]));
  } catch {
    // A storage limit must not interrupt the live map.
  }
}
