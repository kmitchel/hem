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
