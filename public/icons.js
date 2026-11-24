const paths = {
  water: '<path d="M2 7.5c3.5 0 3.5-2.5 7-2.5s3.5 2.5 7 2.5c2.5 0 3.4-1.3 6-2.2M2 12.5c3.5 0 3.5-2.5 7-2.5s3.5 2.5 7 2.5c2.5 0 3.4-1.3 6-2.2M2 17.5c3.5 0 3.5-2.5 7-2.5s3.5 2.5 7 2.5c2.5 0 3.4-1.3 6-2.2"/>',
  radar: '<path d="M17.6 6.4a8 8 0 1 1-11.3 0m9.2 2.1a5 5 0 1 1-7 0M12 12l8-8"/><circle cx="12" cy="12" r="1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  ship: '<path d="M6 12V7h12v5M9 7V4h6v3M3 15l9-4 9 4-2 4M5 19l-2-4m9-4v6M2 21c1.6-1.2 3.2-1.2 5 0 1.7 1.1 3.4 1.1 5 0s3.3-1.1 5 0c1.8 1.2 3.4 1.2 5 0"/>',
  pause: '<path d="M9 5v14m6-14v14"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  install: '<path d="M12 3v11m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5m-18 4 9 5 9-5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  swap: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  focus: '<circle cx="12" cy="12" r="6"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
  map: '<path d="M9 17l-6 3V6l6-3 6 3 6-3v14l-6 3zM9 3v14m6-11v14"/>',
  signal: '<circle cx="12" cy="12" r="1"/><path d="M9 9a4.2 4.2 0 0 0 0 6m6-6a4.2 4.2 0 0 1 0 6M6 6a8.5 8.5 0 0 0 0 12M18 6a8.5 8.5 0 0 1 0 12"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-9 4h2m3 0h1m-9 3h1m3 0h1"/>',
  history: '<path d="M4 11a8 8 0 1 1 2 6M4 5v6h6m2-3v5l3 2"/>',
  external: '<path d="M14 4h6v6m0-6-9 9m8 0v6H5V5h6"/>',
  anchor: '<circle cx="12" cy="5" r="2"/><path d="M12 7v13M8 11h8m-12 3a8 8 0 0 0 16 0m-16 0 3 2m13-2-3 2"/>',
};

export function icon(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
}
