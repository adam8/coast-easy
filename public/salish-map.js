export const salishMapPath = '/maps/salish-sea-20261120.pmtiles';
export const salishMapBounds = [[-125.05, 48.36], [-122.50, 49.95]];
export const salishArchiveBytes = 15_382_208;
export const salishPartBytes = 128 * 1024;
export const salishPartsPath = '/maps/salish-sea-20261120/';
const partCount = Math.ceil(salishArchiveBytes / salishPartBytes);
const savedMaps = 'coast-easy-offline-maps';
const savedArchiveName = 'salish-sea-20261120-offline.pmtiles';
let protocol;

class SalishParts {
  key = 'salish-sea-20261120-online.pmtiles';
  parts = new Map();

  getKey() { return this.key; }

  part(index) {
    const pending = this.parts.get(index);
    if (pending) return pending;
    const expected = Math.min(salishPartBytes, salishArchiveBytes - index * salishPartBytes);
    const next = fetch(salishPartsPath + index + '.bin', { signal: AbortSignal.timeout(25_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error('Salish Sea map data unavailable');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== expected) throw new Error('Incomplete Salish Sea map data');
        return bytes;
      }).catch((error) => {
        this.parts.delete(index);
        throw error;
      });
    this.parts.set(index, next);
    return next;
  }

  async getBytes(offset, length, signal) {
    const first = Math.floor(offset / salishPartBytes);
    const last = Math.floor((offset + length - 1) / salishPartBytes);
    const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, index) => this.part(first + index)));
    signal?.throwIfAborted();
    const bytes = new Uint8Array(length);
    let copied = 0;
    for (const part of parts) {
      const start = copied === 0 ? offset % salishPartBytes : 0;
      const size = Math.min(part.byteLength - start, length - copied);
      bytes.set(new Uint8Array(part, start, size), copied);
      copied += size;
    }
    if (copied !== length) throw new Error('Incomplete Salish Sea map range');
    return { data: bytes.buffer };
  }

  async download() {
    const parts = [];
    const batch = 10;
    for (let start = 0; start < partCount; start += batch) {
      parts.push(...await Promise.all(Array.from({ length: Math.min(batch, partCount - start) },
        (_, index) => this.part(start + index))));
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  }
}

const networkArchive = new SalishParts();

export async function hasSavedSalishMap() {
  try {
    return Boolean(await caches.match(salishMapPath, { cacheName: savedMaps }));
  } catch {
    return false;
  }
}

async function archiveFromBlob(blob) {
  if (blob.size !== salishArchiveBytes) throw new Error('Incomplete Salish Sea map');
  const source = new pmtiles.FileSource(new File([blob], savedArchiveName));
  const archive = new pmtiles.PMTiles(source);
  await archive.getHeader();
  return archive;
}

export async function saveSalishMap() {
  const blob = await networkArchive.download();
  const archive = await archiveFromBlob(blob);
  const cache = await caches.open(savedMaps);
  await cache.put(salishMapPath, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }));
  protocol?.add(archive);
}

export async function salishBasemap(saved) {
  if (!protocol) {
    protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
  }
  const source = saved ? savedArchiveName : networkArchive.getKey();
  if (saved && !protocol.get(source)) {
    const response = await caches.match(salishMapPath, { cacheName: savedMaps });
    if (!response) throw new Error('The saved Salish Sea map is unavailable');
    protocol.add(await archiveFromBlob(await response.blob()));
  } else if (!saved && !protocol.get(source)) {
    const archive = new pmtiles.PMTiles(networkArchive);
    await archive.getHeader();
    protocol.add(archive);
  }
  return {
    version: 8,
    name: 'Coast Easy Salish Sea',
    sources: {
      salish: {
        type: 'vector', url: 'pmtiles://' + source,
        attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com/">Protomaps</a> · Natural Earth',
      },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': '#c8dff0' } },
      {
        id: 'land', type: 'fill', source: 'salish', 'source-layer': 'earth',
        paint: { 'fill-color': '#eef2f5' },
      },
      {
        id: 'woodland', type: 'fill', source: 'salish', 'source-layer': 'landcover', minzoom: 8,
        filter: ['in', ['get', 'kind'], ['literal', ['forest', 'wood', 'grassland']]],
        paint: { 'fill-color': '#e3ebef', 'fill-opacity': .65 },
      },
      {
        id: 'water', type: 'fill', source: 'salish', 'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#c8dff0' },
      },
      {
        id: 'main-roads', type: 'line', source: 'salish', 'source-layer': 'roads', minzoom: 11,
        filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road', 'medium_road']]],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#aebdca', 'line-opacity': .48, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, .65, 14, 2] },
      },
      {
        id: 'place-names', type: 'symbol', source: 'salish', 'source-layer': 'places', minzoom: 6,
        filter: ['all', ['==', ['get', 'kind'], 'locality'], ['<=', ['coalesce', ['get', 'min_zoom'], 12], ['zoom']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name'], ''],
          'text-font': ['Arial'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 13, 13],
          'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 15],
        },
        paint: { 'text-color': '#52697b', 'text-halo-color': '#eef2f5', 'text-halo-width': 1.3 },
      },
    ],
  };
}
