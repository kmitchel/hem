'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const { Readable } = require('node:stream');
const { readData, registerDataRoutes } = require('../data-api');
async function run() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hem-data-test-'));
    const db = require('level')(dir, { valueEncoding: 'json' });
    const now = 1792340040000, t = now - 300000;
    let server;
    try {
        await db.open();
        const fixture = [
            [`temp-room1-tempF-00-${t}.125`, 70],
            [`temp-room1-tempF-00-${t + 15000}.375`, 71],
            [`temp-room1-tempF-00-${t + 105000}.500`, 72],
            [`temp-room1-tempF-00-${t + 110000}`, NaN],
            [`temp-room1-tempF-01-${t}`, [2, 140, 68, 72]],
            [`temp-room1-tempF-01-${t + 120000}`, [2, 144, 71, 73]],
            [`temp-room1-tempF-01-${t + 180000}`, [0, 0, 0, 0]],
            [`temp-room2-rh-01-${t}`, [2, 100, 49, 51]],
            [`temp-2809853f030000a7-00-${t}`, 123.5],
            [`temp-tempF-00-${t}`, 68.5],
            [`power-kWh-60-${t}`, 1.234],
        ];
        for (const resolution of ['05', '15', '60', '24', '28']) fixture.push([`temp-room3-dewF-${resolution}-${t}`, [2, 100, 49, 51]]);
        await db.batch(fixture.map(([key, value]) => ({ type: 'put', key, value })));
        const raw = await readData(db, 'temp-room1-tempF', '00', '1', now);
        assert.deepEqual(raw[0].data, [[t + .125, 70], [t + 15000.375, 71], [t + 15001.375, null], [t + 105000.5, 72]]);
        const aggregate = await readData(db, 'temp-room1-tempF', '01', '1', now);
        assert.deepEqual(aggregate[0].data, [[t, 68, 72], [t + 1, null, null], [t + 120000, 71, 73]]);
        assert.deepEqual(aggregate[1].data, [[t, 70], [t + 1, null], [t + 120000, 72]]);
        assert.deepEqual((await readData(db, 'temp-room2-rh', '01', '0', now))[1].data, [[t, 50]]);
        assert.deepEqual((await readData(db, 'temp-2809853f030000a7', '00', '0', now))[0].data, [[t, 123.5]]);
        assert.deepEqual((await readData(db, 'temp-tempF', '00', '0', now))[0].data, [[t, 68.5]]);
        assert.deepEqual((await readData(db, 'power-kWh', '60', '0', now))[0].data, [[t, 1.234]]);
        assert.deepEqual((await readData(db, 'temp-room3-tempF', '00', '0', now))[0].data, []);
        for (const resolution of ['05', '15', '60', '24', '28']) {
            assert.deepEqual((await readData(db, 'temp-room3-dewF', resolution, '0', now))[1].data, [[t, 50]]);
        }
        const app = require('express')(); registerDataRoutes(app, db);
        server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        async function get(url) {
            return new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}${url}`, res => {
                let body = ''; res.on('data', chunk => body += chunk);
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
            }).on('error', reject));
        }
        assert.deepEqual((await get('/data/temp-room1-tempF/0')).body, raw);
        assert.deepEqual((await get('/data/temp-room1-tempF/01/0')).body, aggregate);
        for (const url of ['/data/temp-room1-tempF/-1', '/data/temp-room1-tempF/99/0', '/data/temp.room/0', '/data/temp-room1-tempF/nope', '/data/temp-room1-tempF/' + '9'.repeat(308)]) {
            assert.equal((await get(url)).status, 400, url);
        }
        const createReadStream = db.createReadStream.bind(db);
        db.createReadStream = () => new Readable({ objectMode: true, read() { this.destroy(new Error('read failed')); } });
        await assert.rejects(readData(db, 'temp-room1-tempF', '00', '0', now), /read failed/);
        db.createReadStream = createReadStream;
        console.log('Data API integration tests passed: timestamps, legacy keys, gaps, aggregates, counters, invalid records and requests');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        await db.close(); await fs.rm(dir, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
