# Coast Easy

A Node.js ferry tracker with a map, fleet search, wakes, and a speed chart.

Run `npm ci` and `npm run dev` with Node.js 24 or later. The server defaults to port 3000 and honors `PORT`. The interactive demo uses simulated positions moving along published ferry routes. Set `AISSTREAM_API_KEY` as a server-side environment secret or in a local ignored `.env` file, then restart to receive live AIS reports. The key is never sent to the browser.

The Node server delivers live updates with server-sent events. The Cloudflare Worker uses a same-origin WebSocket. The service keeps the last report and up to 15 minutes of positions per vessel in memory. The roster comes from the [BC Ferries fleet directory](https://www.bcferries.com/on-the-ferry/our-fleet), with MMSIs matched against public AIS vessel listings. Vessels remain in the roster when reports are unavailable. The demo shows a subset of simulated vessels.

## Cloudflare deployment

In **Workers & Pages**, create a Worker by importing the GitHub repository. Use the Worker name `coast-easy`, the repository root, and the `main` production branch. Set the deploy command to `npm run deploy`. Wrangler builds the assets with `npm run build` from `wrangler.jsonc`. [Cloudflare Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)

Add `AISSTREAM_API_KEY` as a **Secret** in the Worker's **Settings → Variables and Secrets**. The Worker serves the demo until the secret is set. With the secret configured, one Durable Object shares an AIS subscription across active viewers and stores last known positions. Test the generated `workers.dev` URL before connecting a custom domain. [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

Run `npm run deploy -- --dry-run` to package and check the build locally. Run `npx wrangler dev` for a local preview of the Worker.

## Planner and offline use

Open the app once while online over HTTPS or localhost so the browser can save the app, roster, routes, and coastline. On that browser, the app can then reopen offline. It keeps the latest AIS reports and up to 15 minutes of track history preceding each report on the device. The status badge shows when the browser is offline or the live feed is disconnected. Live updates resume when the connection recovers.

To install Coast Easy, use the **Install** button when it appears or your browser's app installation menu. On iPhone and iPad, use Safari's **Share → Add to Home Screen**. The installed app opens in its own window and uses the same offline data.

The sailing planner covers both directions on the Horseshoe Bay–Departure Bay, Tsawwassen–Swartz Bay, Tsawwassen–Duke Point, Horseshoe Bay–Langdale, and Comox (Little River)–Powell River (Westview) routes. Choose a departure date and swipe through its scheduled departure and arrival times. Select a sailing to see its crossing and the latest available arrival estimate on the map. The planner uses fresh estimates from the [BC Ferries API community feed](https://bcferriesapi.ca/) when available and the saved timetable offline. For a ferry already underway with no published ETA, it can estimate arrival from the reported departure and the scheduled crossing time. The timetable labels the source of each arrival time and displays scheduled and reported departures.

The Node server polls conditions every minute and keeps up to 30 days of departures observed while it is running in `data/observed-sailings.sqlite`. A static build stores the reports it sees while Coast Easy is open. To update the bundled timetable, download the [BC Ferries GTFS ZIP](https://data.trilliumtransit.com/gtfs/bcferries-bc-ca/bcferries-bc-ca.zip), run `python3 scripts/import-sailings.py path/to/feed.zip`, and rebuild.

Routes and terminal coordinates come from the [BC Ferries GTFS feed](https://www.transit.land/feeds/f-c0-bcferries~bc~ca) dated November 11, 2026. The basemap uses [OpenFreeMap](https://openfreemap.org/), OpenMapTiles and OpenStreetMap data. The fallback coastline uses [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/).

On phones, the sailing planner floats over the chart. **Recenter map** fits the planned crossing when one is selected. **Map options** contains zoom controls, the region picker, and a toggle for other ferry routes.

Choose **Salish Sea (Protomaps pilot)** under **Map options** to try the regional basemap. The pilot covers the major crossings from zoom 0 through 12. **Download Salish Sea map** saves the 15.4 MB archive on the current device. The app renders the pilot labels locally and can reopen the saved map offline.

The included archive is an extract of the November 20, 2026 Protomaps basemap. It uses OpenStreetMap and Natural Earth data. The build divides the archive into 128 KiB files so the web app can load only the parts it needs on a static host. The archive is distributed as an ODbL Produced Work with attribution in MapLibre. [Protomaps basemap downloads and licensing](https://docs.protomaps.com/basemaps/downloads)

```sh
pmtiles extract https://build.protomaps.com/20261120.pmtiles public/maps/salish-sea-20261120.pmtiles \
  --bbox=-125.05,48.36,-122.50,49.95 --maxzoom=12
```
