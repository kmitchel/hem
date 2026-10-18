#!/usr/bin/env node
'use strict';
// Open an offline copy only: LevelDB recovery can modify the opened directory.
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const level = require('./node_modules/level');
async function main() {
    const [database, destination] = process.argv.slice(2);
    if (!database || !destination) throw new Error('Usage: node export-rrd-history.js OFFLINE_DB NEW_OUTPUT_DIRECTORY');
    if (fs.realpathSync(database) === fs.realpathSync(path.join(__dirname, 'hemdb'))) {
        throw new Error('Refusing to open the live hemdb; use a consistent offline copy');
    }
    fs.mkdirSync(destination); // Never merge exports from different snapshots.
    const db = level(database, { valueEncoding: 'json', createIfMissing: false });
    const streams = new Map(), counts = {};
    try {
        for await (const { key, value } of db.createReadStream({ fillCache: false })) {
            const match = /^(.+)-(00|01|05|15|60)-(\d{13}(?:\.\d+)?)$/.exec(String(key));
            if (!match) continue;
            const [, collection, resolution, timestamp] = match;
            if (!/^(?:temp-[a-zA-Z0-9-]+|power-W|water-GPM|hvac-heat|hvac-cool)$/.test(collection)) continue;
            if (!streams.has(collection)) {
                streams.set(collection, fs.createWriteStream(path.join(destination, collection + '.jsonl')));
                counts[collection] = 0;
            }
            const stream = streams.get(collection);
            if (!stream.write(JSON.stringify([resolution, Number(timestamp), value]) + '\n')) await once(stream, 'drain');
            counts[collection]++;
        }
        await Promise.all([...streams.values()].map(stream => { stream.end(); return once(stream, 'finish'); }));
    } finally {
        await db.close();
    }
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ exportedAt: new Date().toISOString(), counts }, null, 2) + '\n');
    console.log(JSON.stringify(counts));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
