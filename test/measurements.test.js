'use strict';
const assert = require('node:assert/strict');
const { registry, createMeasurements } = require('../measurements');
const tracker = createMeasurements();
const now = 1792340000000;
assert.equal(registry.entries.filter(e => e.room).length, 9);
assert.equal(new Set(registry.entries.map(e => e.collection)).size, registry.entries.length);
for (const payload of ['', ' ', '?', 'NaN', 'Infinity', '1e400', '0x40', 'true', '70F', '999', '-50']) {
    assert.equal(tracker.receive('temp/room1/tempF', payload, now), null, payload);
}
for (const topic of ['temp/unknown/tempF', 'temp/room1/tempF/debug', 'other/temp/room1/tempF', 'power/W/debug']) {
    assert.equal(tracker.receive(topic, '70', now), null, topic);
}
assert.equal(tracker.receive('temp/room1/rh', '101', now), null);
assert.equal(tracker.receive('temp/room1/rh', '-1', now), null);
assert.equal(tracker.receive('temp/room1/rh', '0', now).value, 0);
assert.equal(tracker.receive('power/W', '0', now).value, 0);
assert.equal(tracker.receive('water/GPM', '-1', now), null);
assert.equal(tracker.receive('temp/room1/tempF', '71.25', now, { retain: true }), null);
assert.equal(tracker.receive('power/W', '100', now, { retain: true }), null);
assert.equal(tracker.receive('temp/room1/tempF', ' 71.25 ', now).value, 71.25);
assert.equal(tracker.receive('temp/284a046d4c2001a3', '-10', now).value, -10);
assert.equal(tracker.receive('temp/2809853f030000a7', '125', now).value, 125);
assert.equal(tracker.receive('sensor/room1/status', 'online', now, { retain: true }), null);
assert.equal(tracker.receive('sensor/room1/ip', '192.168.1.20', now), null);
tracker.receive('hvac/controlTempF', '69', now);
tracker.receive('hvac/tempSource', 'room2/espnow', now);
let state = tracker.snapshot(now + 1000);
assert.equal(state.controlSource, 'room2/espnow');
assert.equal(state.diagnostics['sensor/room1/status'].value, 'online');
assert.equal(state.sensors.find(e => e.topic === 'hvac/controlTempF').value, 69);
assert.equal(state.sensors.find(e => e.topic === 'temp/room1/tempF').value, 71.25);
assert.equal(state.sensors.find(e => e.topic === 'temp/room3/tempF').availability, 'unavailable');
assert.equal(state.sensors.find(e => e.topic === 'temp/289fa756b5013c68').availability, 'awaiting-replacement');
state = tracker.snapshot(now + 45001);
assert.equal(state.sensors.find(e => e.topic === 'temp/room1/tempF').availability, 'unavailable');
assert.equal(state.controlSource, null);
// Room 3 and the awaiting-replacement AC inputs can resume without renaming.
tracker.receive('temp/room3/tempF', '68', now + 50000);
tracker.receive('temp/289fa756b5013c68', '90', now + 50000);
state = tracker.snapshot(now + 50001);
assert.equal(state.sensors.find(e => e.topic === 'temp/room3/tempF').availability, 'online');
assert.equal(state.sensors.find(e => e.topic === 'temp/289fa756b5013c68').availability, 'online');
console.log('Measurement registry, validation, freshness and source tests passed');
