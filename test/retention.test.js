'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const level = require('level');
const { RETENTION_MS, parseKey, runRetention, startRetention } = require('../retention');
async function run() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hem-retention-test-'));
    const db = level(directory, { valueEncoding: 'json' });
    const now = 1792340000000, expired = [], keep = [];
    const options = { now, batchSize: 2, pauseMs: 0, log: () => {} };
    try {
        await db.open();
        for (const collection of ['power-W', 'temp-room1-tempF', 'temp-room1-rh']) {
            for (const [resolution, age] of Object.entries(RETENTION_MS)) {
                expired.push(`${collection}-${resolution}-${now - age - 1}`);
                expired.push(`${collection}-${resolution}-${now - age - 0.5}`);
                keep.push(`${collection}-${resolution}-${now - age}`);
                keep.push(`${collection}-${resolution}-${now}`);
            }
            for (const resolution of ['24', '28']) keep.push(`${collection}-${resolution}-1640995200000`);
        }
        keep.push('hist-power-W-delta-100', 'power-W-00-000000000000a',
            'power-W-99-1640995200000', 'temp-room1-tempF-00-1640995200000oops');
        for (const key of [...expired, ...keep]) await db.put(key, { original: key });
        assert.equal(parseKey('temp-room1-tempF-00-1792340000000.123').collection, 'temp-room1-tempF');
        assert.equal(parseKey('hist-power-W-delta-100'), null);
        const audit = await runRetention(db, { ...options, dryRun: true });
        assert.equal(audit.expired, expired.length);
        assert.equal(audit.deleted, 0);
        for (const key of expired) assert.deepEqual(await db.get(key), { original: key });
        const batch = db.batch.bind(db), sizes = [];
        db.batch = operations => { sizes.push(operations.length); return batch(operations); };
        assert.equal((await runRetention(db, options)).deleted, expired.length);
        assert.ok(sizes.every(size => size <= 2));
        for (const key of expired) await assert.rejects(db.get(key), error => error.notFound);
        for (const key of keep) assert.deepEqual(await db.get(key), { original: key });
        assert.equal((await runRetention(db, options)).deleted, 0);
        const failingKey = `power-W-00-${now - RETENTION_MS['00'] - 1}`;
        await db.put(failingKey, 1);
        db.batch = async () => { throw new Error('batch failed'); };
        await assert.rejects(runRetention(db, options), /batch failed/);
        assert.equal(await db.get(failingKey), 1);
        db.batch = batch;
        const createKeyStream = db.createKeyStream.bind(db);
        db.createKeyStream = () => new Readable({ objectMode: true, read() { this.destroy(new Error('scan failed')); } });
        await assert.rejects(runRetention(db, options), /scan failed/);
        db.createKeyStream = createKeyStream;
        let opens = 0, errors = 0, release;
        const gate = new Promise(resolve => { release = resolve; });
        const scheduledDb = {
            open: async () => { opens++; if (opens === 1) { await gate; throw new Error('open failed'); } },
            // Scheduling does not need native DB handles. Keep this empty
            // fixture isolated so interval retries cannot race db.close().
            iterator: () => ({ next: cb => cb(null, undefined), end: cb => cb(null) }),
            createKeyStream: () => { throw new Error('Empty scheduler fixture must not scan'); },
            batch: async () => {}
        };
        const timer = startRetention(scheduledDb, { ...options, intervalMs: 5, logError: () => errors++ });
        try {
            await new Promise(resolve => setTimeout(resolve, 25));
            assert.equal(opens, 1);
            release();
            for (let i = 0; i < 100 && opens < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
            assert.equal(errors, 1);
            assert.ok(opens >= 2);
            await new Promise(resolve => setTimeout(resolve, 25));
        } finally { clearInterval(timer); }
        console.log('Retention tests passed: dry run, cutoffs, topic formats, preservation, batching, failures, scheduling');
    } finally {
        await db.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
