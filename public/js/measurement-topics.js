// Shared registry: MQTT names and existing LevelDB collection IDs are stable.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.HemTopics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const entries = [];
    function add(topic, label, unit, min, max, options = {}) {
        entries.push(Object.freeze({ topic, collection: topic.replace(/\//g, '-'), label,
            unit, min, max, staleMs: 180000, expected: true, ...options }));
    }
    const roomLabels = { room1: 'Front bedroom', room2: 'Kitchen / middle', room3: 'Rear bedroom' };
    for (const [room, label] of Object.entries(roomLabels)) {
        const options = { room, staleMs: 45000,
            note: room === 'room3' ? 'Intermittent power on outdoor GFCI circuit' : '' };
        add(`temp/${room}/tempF`, `${label} temperature`, '°F', -4, 140, options);
        add(`temp/${room}/rh`, `${label} humidity`, '%', 0, 100, options);
        add(`temp/${room}/dewF`, `${label} dew point`, '°F', -148, 140, options);
    }
    add('temp/284a046d4c2001a3', 'Outside temperature', '°F', -67, 257);
    add('temp/2809853f030000a7', 'Upper water heater', '°F', -67, 257);
    add('temp/2813513f03000072', 'Lower water heater', '°F', -67, 257);
    add('temp/289fa756b5013c68', 'AC high side', '°F', -67, 257, { expected: false, note: 'Awaiting replacement' });
    add('temp/2874913c46200105', 'AC low side', '°F', -67, 257, { expected: false, note: 'Awaiting replacement' });
    add('power/W', 'Power', 'W', 0, 100000, { kind: 'power', staleMs: 0 });
    add('water/GPM', 'Water flow', 'GPM', 0, 1000, { kind: 'water', staleMs: 0 });
    add('hvac/controlTempF', 'Controller temperature', '°F', -4, 140, { kind: 'control', staleMs: 45000, archive: false });
    const byTopic = Object.freeze(Object.fromEntries(entries.map(entry => [entry.topic, entry])));
    const byCollection = Object.freeze(Object.fromEntries(entries.map(entry => [entry.collection, entry])));
    function parseReading(topic, payload) {
        const entry = byTopic[topic];
        if (!entry) return null;
        const text = String(payload).trim();
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
        const value = Number(text);
        return Number.isFinite(value) && value >= entry.min && value <= entry.max ? value : null;
    }
    return { entries: Object.freeze(entries), byTopic, byCollection, roomLabels: Object.freeze(roomLabels), parseReading };
});
