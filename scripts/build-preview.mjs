import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { salishArchiveBytes, salishMapPath, salishPartBytes, salishPartsPath } from '../public/salish-map.js';

const fleet = JSON.parse(await readFile('data/fleet.json', 'utf8'));
await mkdir('dist/vendor', { recursive: true });
await rm('dist' + salishMapPath, { force: true });
await cp('public', 'dist', { recursive: true, filter: (source) => !source.endsWith(salishMapPath) });
await Promise.all([
  writeFile('dist/bootstrap.json', JSON.stringify({ mode: 'replay', feed: 'replay', fleet, reports: [] })),
  cp('node_modules/maplibre-gl/dist/maplibre-gl.css', 'dist/vendor/maplibre.css'),
  cp('node_modules/maplibre-gl/dist/maplibre-gl.js', 'dist/vendor/maplibre.js'),
  cp('node_modules/pmtiles/dist/pmtiles.js', 'dist/vendor/pmtiles.js'),
]);

const archive = await readFile('public' + salishMapPath);
if (archive.length !== salishArchiveBytes) throw new Error('The Salish Sea archive does not match its expected size');
await mkdir('dist' + salishPartsPath, { recursive: true });
await Promise.all(Array.from({ length: Math.ceil(archive.length / salishPartBytes) }, (_, index) => {
  const offset = index * salishPartBytes;
  return writeFile('dist' + salishPartsPath + index + '.bin', archive.subarray(offset, offset + salishPartBytes));
}));
