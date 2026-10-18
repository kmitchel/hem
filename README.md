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
