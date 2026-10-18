'use strict';

const DAY = 24 * 60 * 60 * 1000;
// Daily and billing-month buckets intentionally have no expiry.
const RETENTION_MS = Object.freeze({
    '00': 2 * DAY,
    '01': 30 * DAY,
    '05': 90 * DAY,
    '15': 365 * DAY,
    '60': 3 * 365 * DAY
});

function parseKey(key) {
    // Read the suffix: MQTT-derived collection names may contain hyphens.
    const match = /^(.+)-(00|01|05|15|60|24|28)-(\d{13}(?:\.\d+)?)$/.exec(String(key));
    if (!match) return null;
    return { collection: match[1], resolution: match[2], timestamp: Number(match[3]) };
}

async function discoverSeries(db) {
    const iterator = db.iterator({ values: false, fillCache: false });
    const series = [];
    try {
        while (true) {
            const key = await new Promise((resolve, reject) => {
                iterator.next((error, key) => error ? reject(error) : resolve(key));
            });
            if (key === undefined) break;
            const parsed = parseKey(key);
            if (!parsed) continue;
            const prefix = parsed.collection + '-' + parsed.resolution + '-';
            series.push({ ...parsed, prefix });
            // Skip this entire series instead of scanning all retained records.
            iterator.seek(parsed.collection + '-' + parsed.resolution + '.');
        }
    } finally {
        await new Promise((resolve, reject) => iterator.end(error => error ? reject(error) : resolve()));
    }
    return series;
}

async function runRetention(db, options = {}) {
    const { now = Date.now(), dryRun = false, batchSize = 1000, pauseMs = 10,
        log = message => console.log(message) } = options;
    if (!Number.isSafeInteger(now) || !Number.isInteger(batchSize) || batchSize < 1 ||
        !Number.isFinite(pauseMs) || pauseMs < 0) throw new Error('Invalid retention options');
    const started = Date.now();
    const stats = { dryRun, expired: 0, deleted: 0, byResolution: {}, series: 0 };
    let lastProgress = started;
    log('[retention] ' + (dryRun ? 'Dry run' : 'Starting') + ' cutoff time ' + new Date(now).toISOString());
    const series = await discoverSeries(db);
    stats.series = series.length;
    for (const { prefix, resolution } of series) {
        const age = RETENTION_MS[resolution];
        if (age === undefined) continue;
        const cutoff = now - age;
        let batch = [];
        const flush = async () => {
            if (!batch.length) return;
            await db.batch(batch);
            stats.deleted += batch.length;
            batch = [];
            // Let MQTT writes and HTTP requests run between deletion batches.
            await new Promise(resolve => setTimeout(resolve, pauseMs));
        };
        const stream = db.createKeyStream({ gte: prefix, lt: prefix + cutoff, fillCache: false });
        for await (const key of stream) {
            const parsed = parseKey(key);
            // Preserve unknown/malformed records even if they fall in this range.
            if (!parsed || parsed.collection + '-' + parsed.resolution + '-' !== prefix ||
                parsed.timestamp >= cutoff) continue;
            stats.expired++;
            stats.byResolution[resolution] = (stats.byResolution[resolution] || 0) + 1;
            if (!dryRun) {
                batch.push({ type: 'del', key });
                if (batch.length >= batchSize) await flush();
            }
            if (Date.now() - lastProgress >= 30000) {
                log('[retention] Progress ' + JSON.stringify(stats));
                lastProgress = Date.now();
            }
        }
        await flush();
    }
    stats.durationMs = Date.now() - started;
    log('[retention] Complete ' + JSON.stringify(stats));
    return stats;
}

function startRetention(db, options = {}) {
    const { intervalMs = 30 * 60 * 1000, log = message => console.log(message),
        logError = error => console.error('[retention] Failed; will retry next interval', error),
        ...runOptions } = options;
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            await db.open();
            await runRetention(db, { ...runOptions, log });
        } catch (error) {
            logError(error);
        } finally {
            running = false;
        }
    };
    const timer = setInterval(run, intervalMs);
    run();
    return timer;
}

module.exports = { RETENTION_MS, parseKey, discoverSeries, runRetention, startRetention };

// Audit an OFFLINE database copy. Opening LevelDB may recover its log, so never
// point this command at a live database or the only backup.
if (require.main === module) {
    const [flag, location, ...extra] = process.argv.slice(2);
    if (flag !== '--dry-run' || !location || extra.length) {
        console.error('Usage: node retention.js --dry-run /path/to/offline-database-copy');
        process.exitCode = 1;
    } else {
        const db = require('level')(location, { valueEncoding: 'json', createIfMissing: false });
        (async () => {
            try { await db.open(); await runRetention(db, { dryRun: true }); }
            finally { await db.close(); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    }
}
