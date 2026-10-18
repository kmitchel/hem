'use strict';
const registry = require('./public/js/measurement-topics');
function createMeasurements() {
    const readings = new Map();
    const diagnostics = {};
    let source = null, sourceAt = null;
    function receive(topic, payload, now = Date.now(), packet = {}) {
        if (topic === 'hvac/tempSource') {
            const text = String(payload).trim();
            if (!packet.retain && /^(room[123]\/(mqtt|espnow)|none)$/.test(text)) {
                source = text; sourceAt = now;
            }
            return null;
        }
        const diagnostic = /^sensor\/(room[123])\/(status|ip|rssi|espnow)$/.exec(topic);
        if (diagnostic) {
            const text = String(payload).trim();
            if (text.length <= 100) {
                diagnostics[topic] = { value: text, receivedAt: now, retained: Boolean(packet.retain) };
            }
            return null;
        }
        const value = registry.parseReading(topic, payload);
        // A retained sample has no observation timestamp: it cannot establish
        // freshness or be counted again as new energy/water consumption.
        if (value === null || packet.retain) return null;
        const entry = registry.byTopic[topic];
        readings.set(topic, { value, receivedAt: now });
        return { entry, value };
    }
    function snapshot(now = Date.now()) {
        return { sensors: registry.entries.map(entry => {
            const last = readings.get(entry.topic);
            const fresh = Boolean(last && (!entry.staleMs || now - last.receivedAt <= entry.staleMs));
            return { ...entry, value: last ? last.value : null, receivedAt: last ? last.receivedAt : null,
                availability: fresh ? 'online' : entry.expected ? 'unavailable' : 'awaiting-replacement' };
        }), diagnostics: { ...diagnostics }, controlSource: sourceAt !== null && now - sourceAt <= 45000 ? source : null,
            controlSourceAt: sourceAt, now };
    }
    return { receive, snapshot };
}
module.exports = { createMeasurements, registry };
