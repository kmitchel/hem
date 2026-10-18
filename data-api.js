'use strict';
const { parseKey } = require('./retention');
const { byCollection } = require('./public/js/measurement-topics');
const counters = new Set(['power-kWh', 'water-Gal', 'hvac-heat', 'hvac-cool']);
const durations = { '01': 60000, '05': 300000, '15': 900000, '60': 3600000, '24': 86400000, '28': 32 * 86400000 };
function insertGaps(points, gapMs) {
    if (!gapMs) return points;
    const result = [];
    for (const point of points) {
        const previous = result[result.length - 1];
        if (previous && point[0] - previous[0] > gapMs) {
            result.push([previous[0] + 1, ...point.slice(1).map(() => null)]);
        }
        result.push(point);
    }
    return result;
}
async function readData(db, collection, resolution, hours, now = Date.now()) {
    if (!/^[A-Za-z0-9_-]+$/.test(collection) || !['00', ...Object.keys(durations)].includes(resolution) ||
        !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(hours)) || !Number.isFinite(Number(hours) * 3600000) || Number(hours) < 0) {
        const error = new Error('Invalid collection, resolution or time range');
        error.status = 400; throw error;
    }
    const prefix = collection + '-' + resolution + '-';
    const cutoff = Number(hours) === 0 ? '' : String(now - Number(hours) * 3600000);
    const raw = [], range = [], avg = [];
    const isCounter = counters.has(collection);
    for await (const row of db.createReadStream({ gt: prefix + cutoff, lt: collection + '-' + resolution + '.', fillCache: false })) {
        const parsed = parseKey(row.key);
        if (!parsed || parsed.collection !== collection || parsed.resolution !== resolution) continue;
        const timestamp = parsed.timestamp, value = row.value;
        if (resolution === '00' || isCounter) {
            if (typeof value === 'number' && Number.isFinite(value)) raw.push([timestamp, value]);
        } else if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) &&
            value[0] > 0 && value[2] <= value[3]) {
            range.push([timestamp, value[2], value[3]]);
            avg.push([timestamp, Number((value[1] / value[0]).toFixed(2))]);
        }
    }
    const entry = byCollection[collection];
    const gap = entry && entry.staleMs ? (resolution === '00' ? entry.staleMs : durations[resolution] * 1.5) : 0;
    if (resolution === '00' || isCounter) return [{ data: insertGaps(raw, gap),
        ...(collection === 'water-GPM' && resolution === '00' ? { type: 'bar' } : {}) }];
    return [{ name: 'Min-Max', data: insertGaps(range, gap), type: 'arearange' },
        { name: 'Avg', data: insertGaps(avg, gap) }];
}
function registerDataRoutes(app, db) {
    async function handle(req, res) {
        try { res.json(await readData(db, req.params.collection, req.params.time || '00', req.params.past)); }
        catch (error) {
            if (!error.status) console.error('[data] Read failed', error);
            res.status(error.status || 500).json({ error: error.status ? error.message : 'Data unavailable' });
        }
    }
    app.get('/data/:collection/:past', handle);
    app.get('/data/:collection/:time/:past', handle);
}
module.exports = { readData, registerDataRoutes, insertGaps };
