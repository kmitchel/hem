const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTracker } = require('../public/js/hvac-mode');

async function run() {
  const states = [];
  const published = [];
  const tracker = createTracker(state => states.push(state), 8);
  const publish = (topic, value) => published.push({ topic, value });

  assert.equal(tracker.snapshot().confirmed, null);
  tracker.connect();
  assert.equal(tracker.snapshot().notice, 'Waiting for controller');
  assert.equal(tracker.receive('hvac/mode', 'cool'), false);
  assert.equal(tracker.receive('hvac/modeState', '?'), false);
  assert.equal(tracker.receive('hvac/modeState', 'auto'), false);
  assert.equal(tracker.receive('hvac/modeState', 'cool', { retain: true }), false);
  assert.equal(tracker.snapshot().confirmed, null);

  assert.equal(tracker.receive('hvac/modeState', 'heat', { retain: false }), true);
  assert.equal(tracker.snapshot().confirmed, 'heat');
  tracker.request('cool', publish);
  assert.deepEqual(published, [{ topic: 'hvac/mode', value: 'cool' }]);
  assert.equal(tracker.snapshot().confirmed, 'heat');
  assert.equal(tracker.snapshot().pending, 'cool');
  tracker.receive('hvac/state', 'Cooling');
  tracker.receive('hvac/mode', 'cool');
  tracker.receive('hvac/modeState', 'heat');
  assert.equal(tracker.snapshot().pending, 'cool');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(tracker.snapshot().confirmed, 'heat');
  assert.equal(tracker.snapshot().notice, 'No controller confirmation');

  tracker.request('cool', publish);
  tracker.receive('hvac/modeState', 'cool');
  assert.equal(tracker.snapshot().pending, null);
  assert.equal(tracker.snapshot().confirmed, 'cool');
  tracker.receive('hvac/modeState', 'fan');
  assert.equal(tracker.snapshot().confirmed, 'fan');
  tracker.disconnect();
  assert.equal(tracker.snapshot().confirmed, null);
  assert.equal(tracker.request('heat', publish), false);
  tracker.connect();
  assert.equal(tracker.snapshot().confirmed, null);
  tracker.receive('hvac/modeState', 'off');
  assert.equal(tracker.snapshot().confirmed, 'off');

  for (const page of ['temp.html', 'temp-new.html', 'temp-vanilla.html', 'chart.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../public', page), 'utf8');
    assert.match(html, /js\/hvac-mode\.js/);
    assert.match(html, /mode\.receive\(topic,|modeTracker\.receive\(topic,/);
    assert.match(html, /publish\(['"]hvac\/mode['"], ['"]\?['"]\)/);
    assert.match(html, /modeStatus|hvac-mode-status/);
  }
  assert.ok(states.length > 0);
  console.log('HVAC mode tracker tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
