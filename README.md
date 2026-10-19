# HEM
Home Energy Management
  Custom energy monitor for my home.  Features Raspberry Pi with Arduino Pro Mini for hardware interface.
  Monitors temperature, electricity and water consumption.
  Manages HVAC.
  Plots graphs using rrdtool and highcharts.

## LevelDB retention

`retention.js` runs when HEM starts and every 30 minutes thereafter. It keeps raw
samples (`00`) for 48 hours, 1-minute buckets (`01`) for 30 days, 5-minute buckets
(`05`) for 90 days, 15-minute buckets (`15`) for 365 days, and hourly buckets (`60`)
for 1,095 days. Daily (`24`) and billing-month (`28`) buckets remain indefinitely.
These coarser buckets are already written during ingestion; pruning does not
recompute them or reconstruct missing history.

Keys are parsed from their resolution/timestamp suffix, so collection names may
contain hyphens. Unknown formats, histogram keys, and unknown resolutions are
preserved. Cutoffs are fixed at the beginning of each pass; records exactly at
the cutoff are retained. The policy uses elapsed days, not calendar years.

Maintenance discovers series by seeking past each series, then scans only expired
ranges without filling the read cache. Deletes are awaited in batches of 1,000 with
a 10 ms pause between batches. Runs cannot overlap. Startup, progress, completion
counts by resolution, duration, and failures appear in `journalctl -u hem`.
Failures are retried at the next scheduled interval. Automatic LevelDB compaction
reclaims deleted storage over time; do not delete `.ldb` files by hand.

Before the first cleanup or a policy change, take a consistent backup with HEM
stopped or frozen. Audit a separate offline copy (opening LevelDB can recover its
log and modify the copy):

```sh
node retention.js --dry-run /path/to/offline-database-copy
```

The audit reports expired record counts without deleting records. Do not point it
at the running database or the only backup. Large initial cleanups can take time;
watch the progress logs. Live graph requests for history beyond these retention
windows will only contain the available records at the requested resolution.

Run verification with `node test/retention.test.js` and
`node test/hvac-mode.test.js`.

## Measurement collection and dashboards

`public/js/measurement-topics.js` defines approved MQTT measurement topics,
stable existing LevelDB collection IDs, units, accepted ranges, and freshness.
HEM subscribes to these exact measurements plus HVAC state/source and the three
rooms' diagnostic topics. Unknown measurement topics are not archived. A sensor
replacement with a new ROM ID needs an explicit registry entry; its `collection`
option can preserve the historical collection for the same physical role.

- Each of rooms 1-3 has temperature (F), humidity (%), and dew point (F).
- The outside, upper water-heater, and lower water-heater DS18B20s remain active.
- AC high/low DS18B20 mappings and history remain available. They are marked
  awaiting replacement until fresh readings arrive, without missing-sensor alarms.
- Room 3 is expected to return after intermittent circuit power loss. Missing
  readings mean unavailable, without assuming a failed sensor.
- Device status, IP, RSSI and ESP-NOW messages are current diagnostics, never
  numeric history. Retained measurements are not counted as fresh samples or
  replayed consumption events. Retained diagnostics are accepted as metadata.

Before any measurement reaches LevelDB, a counter, or an RRD, it must be nonempty
numeric text, finite and in range: room/control temperature -4 to 140 F, room dew
point -148 to 140 F, humidity 0-100%, DS18B20 temperature -67 to 257 F, power
0-100,000 W, and water flow 0-1,000 GPM. Rejected messages cause no measurement
writes. This does not rewrite previously recorded data.

`GET /api/sensors` returns current readings received since collector startup,
metadata, last receipt times and freshness (45 seconds for room/control inputs,
180 seconds for DS18B20s). Power and water are event-driven and have no stale
alarm. Device online metadata does not override stale or absent measurements.

The chart and thermostat pages show a collapsible availability table. Room charts
are individually selectable; old AC charts remain labeled awaiting replacement.
Controller temperature and `hvac/tempSource` are displayed separately from room
measurements. The existing RRD indoor-temperature source precedence (controller,
then room1 after 45 seconds without a controller reading) is preserved; controller
selection, firmware and published MQTT names are unchanged.

Historical APIs parse timestamps from the shared resolution/timestamp suffix,
including fractional raw timestamps and older two-segment topic collections.
Invalid stored records are skipped in responses without being deleted. Explicit
null gap markers break temperature/humidity chart lines across missing samples;
they are not stored as measurements. Aggregate gaps indicate missing buckets,
not missing individual readings within an existing bucket. API response names and
counter values remain compatible with the existing chart clients.

Dashboard data requests use the current HTTP host/port, and browser MQTT clients
use the current hostname on port 9001. The overview scrolls and adapts its column
count to the available width, including the narrow in-app browser panel.

## RRD graph storage and rebuilding

The classic `/graph/:id` PNG graphs keep their existing styles and filenames.
Their RRDs use a 30-second GAUGE base step and a 60-second heartbeat:

| Resolution | Rows | Retention |
|---|---:|---|
| 30 seconds | 5,760 | 48 hours |
| 1 minute | 43,200 | 30 days |
| 5 minutes | 25,920 | 90 days |
| 15 minutes | 35,040 | 365 days |
| 1 hour | 26,280 | 1,095 days |

All series have AVERAGE archives. Power, temperature, dew point and humidity
also have MIN/MAX archives. Graphs continue to display averages. Current bounds
match the measurement registry: room/control -4..140 F, dew -148..140 F,
outside/water-heater/AC -67..257 F, humidity 0..100%, power 0..100,000 W,
water 0..1,000 GPM, HVAC 0..100%. Longer heartbeat values are not used to conceal
event-driven collection gaps. The water sensor publishes only during flow, so
water graphs display silence as zero GPM; other graphs retain unknown gaps.

The interactive overview offers preset and custom history ranges, including
4 days, 1 week, 30 days, 90 days, 1 year and 3 years. These are also available as
`start=96h`, `7d`, `30d`, `90d`, `365d` or `3y` on the graph URLs. Rendering steps
match available tiers and the width of the graph. See Interactive RRD viewer below.

`./createrrd.sh NEW_DIRECTORY` creates empty files in a new directory only;
it refuses an existing destination instead of erasing live history. Python 3,
RRDtool and the existing Node dependencies are required for rebuilding.

Before rebuilding, make a consistent backup of LevelDB and every RRD while HEM
is stopped or frozen, plus the source/Git history and systemd unit. Never open
the live LevelDB or the only backup with an offline tool. Export a separate
writable copy, then build replacement files alongside the originals:

```sh
node export-rrd-history.js /path/to/offline-leveldb-copy /path/to/new-export
python3 rrd-rebuild.py --originals /path/to/original-rrds \
  --export /path/to/new-export --output /path/to/new-replacements \
  --as-of SNAPSHOT_EPOCH_SECONDS
```

The snapshot epoch must be at least the newest source RRD update. Rebuilds
preserve known existing RRD averages ahead of LevelDB's differently weighted
sample means. LevelDB bucket starts become RRD bucket ends. Raw samples supply
30-second buckets; matching 1m/5m/15m/1h aggregates supply older history. Missing
or out-of-range values remain unknown. Original archives are rebinned into
equal or coarser target intervals using duration-weighted overlap and xff=0.5;
this is an approximation where the old and new bucket boundaries differ.
Coarse data is never expanded into purported finer observations.

Indoor control temperature has no LevelDB backfill: only existing RRD history
is carried forward. Outside history combines older unsmoothed LevelDB samples
with recent smoothed RRD output. HVAC LevelDB minute counters become approximate
runtime percentages; absent counters remain unknown, and recent RRD state
values take precedence. Historical MIN/MAX use LevelDB observed sample extrema;
future MIN/MAX summarize 30-second PDPs, so spikes shorter than the base step
may be attenuated. Historical RRD averages do not fabricate MIN/MAX values.
Old AC fine detail outside the new windows remains in the untouched backup;
hourly AC aggregates still fit the new three-year archives.

The rebuild writes `rebuild-summary.json` with populated rows and source counts.
Verify candidates with `rrdtool info`, `fetch`, representative graphs and tests
before stopping the service. During the short switch, save a final copy of the
old RRDs, then catch up replacements from those files:

```sh
python3 rrd-rebuild.py --catch-up --originals /path/to/final-old-rrds \
  --output /path/to/new-replacements
```

Catch-up replays completed 30-second PDP averages, corrects the first partially
accumulated PDP, and carries the final partial PDP. Extrema during this short
bridge describe 30-second means, not original sample peaks. Finish within the
old 8h32m fine archive, otherwise take a newer snapshot and rebuild. Copy the
verified files into place with ownership `hem:hem`, restart HEM, check graph
responses and confirm timestamps advance on actively publishing series.

For rollback, stop HEM, preserve the replacement files, restore all twelve RRDs
from the consistent final-old copy (or initial backup), set ownership `hem:hem`,
and start HEM. The new graph endpoints work with either archive layout. Restore
source files from the source/Git backup as well if reverting code. Do not restore
an old LevelDB over the live database merely to roll back RRDs.

Verification: `npm test` includes Python migration tests for missing buckets,
mixed grids, timestamp conversion, runtime counters, and continued PDP/CDP
updates after restoration and catch-up, plus graph-range and zero-flow-rendering tests.

## Interactive RRD viewer

`index.html` is the on-demand RRD viewer. Choose graph groups and individual
lines, select a preset or custom local dates, then generate the view. Earlier /
Later pan by half a window; Zoom in/out changes the interval around its center.
Navigation into history pauses automatic refresh; Back to now returns to a
rolling preset. Refresh can be manual, 30 seconds, one minute or five minutes.
Hidden tabs pause graph requests. Only two viewer requests run concurrently,
and changed views cancel obsolete requests. Failed updates retain the last image
with an explicit error and a refresh instruction.

Appearance controls include image dimensions, minimum/average/maximum sensor
aggregates, optional min–max shading, legend/statistics, HVAC overlays, power
logarithmic scale and optional Y-axis bounds. Sensor bounds apply to all selected
graphs; water always uses AVERAGE and silence remains zero flow. Missing extrema
stay unknown; requesting MIN/MAX does not invent peaks absent from the archive.

Each graph offers Open full size and Download PNG. The URL contains the complete
view configuration, so bookmarks and shared links reproduce it. Live preset
links remain relative to now; custom links retain exact epochs. Last-used settings
are also kept in browser local storage. Reset view restores defaults. Clipboard
copy falls back to a selectable link on HTTP origins without clipboard access.

The existing classic RRD PNG styles, colors and sunrise (orange), solar noon
(red), and sunset (blue) lines remain. Solar events use the selected historical
calendar dates at the existing HEM location, with axes in America/Indianapolis.
Long ranges mark representative days (no more than roughly 24 days of solar
events), spaced evenly across the interval to avoid obscuring the series. Cards
show the solar-day spacing and requested rendering interval. Custom date inputs
use the browser's local timezone; the window caption and graph axes use
Indianapolis time. RRD may consolidate further to fit pixels or retained data.

### Graph API

`GET /api/rrd-graphs` returns available groups/traces, presets, retention tiers,
timezone and the existing solar location. `GET /graph/:id` still returns a PNG
for `watt`, `temp`, `wh`, `ac` or `gpm`. Existing preset links such as
`/graph/temp?start=48h` remain supported; the 6h preset now correctly means six
hours. The default period is 24 hours.

Supported query parameters:

| Parameter | Values |
|---|---|
| `start` | `1h`, `2h`, `4h`, `6h`, `12h`, `24h`, `48h`, `96h`, `7d`, `30d`, `90d`, `365d`, `3y` |
| `from`, `to` | Both Unix timestamps in seconds; override `start`. Range: 60 seconds through 1,095 days. End may not exceed server time by more than five minutes. |
| `series` | Comma-separated allowed trace IDs from the catalog for that group |
| `resolution` | `auto`, `30`, `60`, `300`, `900`, `3600` seconds; manual requests finer than retained history are rejected |
| `cf` | `AVERAGE`, `MIN`, `MAX`; flow remains `AVERAGE` |
| `width`, `height` | Integer pixels, width 640–2,400 and height 200–900 |
| `min`, `max` | Optional finite Y-axis limits; minimum must be below maximum; logarithmic power needs positive limits |
| `legend`, `stats`, `bands`, `hvac`, `log` | `0` or `1`; `bands` applies to sensor averages, `hvac` to indoor temperature, and `log` to power |

Example: `/graph/wh?start=7d&series=upper,lower&bands=1&height=480`.
Successful PNG responses include `X-RRD-Step`, `X-RRD-CF`,
`X-Solar-Stride-Days` and a filename in Content-Disposition. Invalid parameters
return JSON with a 400 status; unknown graphs return 404. Rendering errors return
502, timeouts 504, and a busy renderer 503 with Retry-After. Images are buffered
until rendering succeeds so failures do not masquerade as PNGs. Each process has
a 15-second timeout and 8 MiB output limit; four renders can run concurrently.
Client disconnects terminate their render process. All query arguments are
validated against fixed groups/options before invoking RRDtool without a shell.

`rrd-graphs.js` owns the graph API; browser state/navigation helpers are in
`public/js/rrd-viewer-state.js`, controls and request handling in
`public/js/rrd-viewer.js`, and existing MQTT live readings in
`public/js/rrd-live.js`. `npm test` covers API plans, validation, historical solar
markers, renderer errors/cancellation and viewer URL state/navigation in addition
to the collector, retention, data API and migration suites.
