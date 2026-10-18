'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const writes = [], rrd = [], subscriptions = [], publications = [];
const db = { get: (key, cb) => cb(new Error('not found')),
    put: (key, value) => { writes.push([key, value]); return Promise.resolve(); } };
const mqtt = new EventEmitter();
mqtt.subscribe = topics => subscriptions.push(...topics);
mqtt.publish = (topic, value) => publications.push([topic, value]);
const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
child.stdin = { write: line => rrd.push(line) };
const app = { get: () => {}, use: () => {} };
const express = () => app; express.static = () => () => {};
const replacements = {
    'child_process': { spawn: () => child }, express,
    compression: () => () => {}, http: { Server: () => ({ listen: () => {} }) },
    suncalc: {}, level: () => db, mqtt: { connect: () => mqtt },
    './retention': { startRetention: () => null }
};
vm.runInNewContext(fs.readFileSync(require.resolve('../index'), 'utf8'), {
    require: name => replacements[name] || require('../' + name.replace(/^\.\//, '')),
    __dirname: '/test/hem', performance: require('node:perf_hooks').performance, console
});
mqtt.emit('connect');
assert.ok(subscriptions.includes('temp/room3/tempF'));
assert.ok(subscriptions.includes('temp/289fa756b5013c68'));
assert.ok(!subscriptions.includes('#'));
function emit(topic, payload, packet = {}) { mqtt.emit('message', topic, Buffer.from(payload), packet); }
for (const [topic, payload, packet] of [
    ['temp/room1/tempF', 'NaN'], ['temp/room1/tempF', ''], ['temp/room1/rh', '150'],
    ['temp/room1/debug', '10'], ['other/temp/room1/tempF', '71'], ['power/W/debug', '500'],
    ['power/W', '100', { retain: true }], ['hvac/state', 'Heating', { retain: true }],
    ['sensor/room1/status', 'online'], ['sensor/room1/rssi', '-50'], ['hvac/tempSource', 'room1/mqtt']
]) emit(topic, payload, packet);
assert.deepEqual(writes, []); assert.deepEqual(rrd, []);
emit('temp/room1/tempF', '71');
assert.equal(writes.length, 7); assert.ok(writes.every(([key]) => key.startsWith('temp-room1-tempF-')));
assert.equal(rrd.length, 1);
writes.length = 0; rrd.length = 0;
emit('temp/2809853f030000a7', '125');
assert.equal(writes.length, 7); assert.match(rrd[0], /hem-upper\.rrd N:125/);
writes.length = 0; rrd.length = 0;
emit('hvac/controlTempF', '69');
assert.equal(writes.length, 0); assert.match(rrd[0], /hem-in\.rrd N:69/);
emit('temp/room1/tempF', '71'); assert.equal(rrd.length, 1); // Preserve existing control-temperature precedence.
writes.length = 0; rrd.length = 0;
emit('power/W', '500');
assert.equal(writes.length, 13); assert.equal(writes.filter(([key]) => key.startsWith('power-kWh-')).length, 6);
writes.length = 0; rrd.length = 0;
emit('water/GPM', '2');
assert.equal(writes.length, 13); assert.equal(writes.filter(([key]) => key.startsWith('water-Gal-')).length, 6);
writes.length = 0; rrd.length = 0;
emit('hvac/state', 'Heating');
assert.equal(writes.length, 6); assert.ok(writes.every(([key]) => key.startsWith('hvac-heat-')));
assert.equal(rrd.length, 2);
console.log('Collector wiring tests passed: invalid/diagnostic/retained messages cause no writes; valid sensors, counters and RRD routing preserved');
