const replayStart = Date.UTC(2026, 10, 19, 21, 42);
const minute = 60_000;
const crossingData = [
  { id: 'SOBC', route: '12443', progress: .47, minutes: 95, speed: 17.4 },
  { id: 'QOAK', route: '12444', progress: .46, minutes: 100, speed: 18.7 },
  { id: 'CEL', route: '12443', dock: 0 },
  { id: 'INS', route: '12393', progress: .51, minutes: 120, speed: 15.1 },
  { id: 'QSUR', route: '12394', dock: 1 },
  { id: 'QCAP', route: '12400', progress: .67, minutes: 20, speed: 12.7 },
  { id: 'SKEN', route: '12427', progress: .55, minutes: 35, speed: 11.2 },
  { id: 'IGWA', route: '12425', dock: 0 },
  { id: 'BSC', route: '12428', dock: 1 },
  { id: 'ORCA', route: '12396', progress: .43, minutes: 85, speed: 14.2 },
  { id: 'NEXP', route: '12434', progress: .42, minutes: 925, speed: 18.2 },
];

function lengthBetween(a, b) {
  const scale = Math.cos((a[1] + b[1]) * Math.PI / 360);
  return Math.hypot((b[0] - a[0]) * scale, b[1] - a[1]);
}

function trackFor(points) {
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    distances.push(distances[i - 1] + lengthBetween(points[i - 1], points[i]));
  }
  return { points, distances, length: distances.at(-1) };
}

function pointAt(track, progress) {
  const distance = track.length * progress;
  const index = Math.max(1, track.distances.findIndex((length) => length >= distance));
  const from = track.points[index - 1];
  const to = track.points[index];
  const span = track.distances[index] - track.distances[index - 1];
  const fraction = span ? (distance - track.distances[index - 1]) / span : 0;
  const lon = from[0] + (to[0] - from[0]) * fraction;
  const lat = from[1] + (to[1] - from[1]) * fraction;
  const scale = Math.cos(lat * Math.PI / 180);
  const course = (Math.atan2((to[0] - from[0]) * scale, to[1] - from[1]) * 180 / Math.PI + 360) % 360;
  return { lat, lon, course };
}

function replayPosition(crossing, elapsed) {
  const travel = crossing.dock ?? crossing.progress + elapsed / (crossing.minutes * minute);
  const phase = ((travel % 2) + 2) % 2;
  const backwards = phase > 1;
  const progress = backwards ? 2 - phase : phase;
  const point = pointAt(crossing.track, progress);
  const speed = crossing.dock === undefined
    ? crossing.speed * Math.min(1, .12 + Math.min(progress, 1 - progress) * 12)
      + .55 * Math.sin(elapsed / 67_000 + crossing.progress * 19)
    : 0;
  const course = (point.course + (backwards ? 180 : 0)) % 360;
  return { ...point, course, speed: Math.max(0, speed), time: replayStart + elapsed };
}

export function createReplay(geography) {
  const terminals = new Map(geography.terminals.features.map((point) => [
    point.properties.name, point.geometry.coordinates,
  ]));
  const routes = new Map(geography.routes.features.map((route) => [route.properties.id, route]));

  const crossings = crossingData.map((crossing) => {
    const route = routes.get(crossing.route);
    const tracks = route.geometry.coordinates.map(trackFor);
    let track = tracks[0];
    if (crossing.id === 'NEXP') {
      track = tracks.reduce((longest, item) => item.length > longest.length ? item : longest);
      const from = terminals.get(route.properties.from);
      if (from && lengthBetween(track.points[0], from) > lengthBetween(track.points.at(-1), from)) {
        track = trackFor([...track.points].reverse());
      }
    }
    return { ...crossing, routeDetails: route.properties, track };
  });

  return (elapsed) => ({
    now: replayStart + elapsed,
    reports: crossings.map((crossing) => ({
      id: crossing.id,
      route: crossing.routeDetails,
      position: replayPosition(crossing, elapsed),
      trail: Array.from({ length: 31 }, (_, index) =>
        replayPosition(crossing, elapsed - (30 - index) * 30_000)),
    })),
  });
}
