// Read-only availability display shared by the HEM dashboards.
(function () {
    function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
    function paintControl(snapshot) {
        const control = snapshot.sensors.find(sensor => sensor.topic === 'hvac/controlTempF');
        const available = control && control.availability === 'online' && snapshot.controlSource && snapshot.controlSource !== 'none';
        const value = available ? control.value.toFixed(1) + '°F' : 'Unavailable';
        const source = snapshot.controlSource && snapshot.controlSource !== 'none' ? snapshot.controlSource : 'Unavailable';
        const chart = document.getElementById('hvac-temp');
        if (chart) chart.textContent = value;
        const current = document.getElementById('currentTemp');
        if (current) { current.textContent = value; current.style.fontSize = available ? '' : '1.4rem'; }
        const legacy = document.getElementById('t');
        if (legacy) legacy.textContent = 'Controller temperature: ' + value + ' / Source: ' + source;
        const original = document.getElementById('temp');
        if (original) {
            const heading = text('h1', value); heading.className = 'cover-heading'; original.replaceChildren(heading);
        }
        for (const id of ['hvac-source', 'hem-control-source', 'source']) {
            const node = document.getElementById(id);
            if (node) node.textContent = (id === 'source' ? 'Controller temperature · Source: ' : '') + source;
        }
        document.dispatchEvent(new CustomEvent('hem-sensors', { detail: snapshot }));
    }
    function init() {
        const details = document.createElement('details'); details.className = 'hem-sensor-status';
        const summary = text('summary', 'Sensor availability · Connecting.');
        const content = document.createElement('div'); content.className = 'hem-sensor-status-content';
        details.append(summary, content);
        const main = document.getElementById('main');
        if (main) main.prepend(details);
        else {
            const target = document.querySelector('.container, .cover-container');
            if (target) target.append(details); else document.body.prepend(details);
        }
        let pending = false;
        async function refresh() {
            if (pending) return;
            pending = true;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            try {
                const response = await fetch('/api/sensors', { cache: 'no-store', signal: controller.signal });
                if (!response.ok) throw new Error('Collector unavailable');
                const snapshot = await response.json();
                const online = snapshot.sensors.filter(sensor => sensor.room && sensor.topic.endsWith('/tempF') && sensor.availability === 'online').length;
                summary.textContent = `Sensor availability · ${online} of 3 rooms online`;
                const table = document.createElement('table');
                const header = document.createElement('tr');
                for (const label of ['Measurement', 'Availability', 'Last value', 'Last received']) header.append(text('th', label));
                const head = document.createElement('thead'); head.append(header); table.append(head);
                const body = document.createElement('tbody');
                for (const sensor of snapshot.sensors.filter(sensor => sensor.topic.startsWith('temp/'))) {
                    const row = document.createElement('tr');
                    row.dataset.collection = sensor.collection;
                    const label = text('td', sensor.label); if (sensor.note) label.title = sensor.note;
                    row.append(label, text('td', sensor.availability === 'awaiting-replacement' ? 'Awaiting replacement' : sensor.availability === 'online' ? 'Online' : 'Unavailable'),
                        text('td', sensor.value === null ? '-' : sensor.value.toFixed(2) + ' ' + sensor.unit),
                        text('td', sensor.receivedAt === null ? 'Not received since startup' : new Date(sensor.receivedAt).toLocaleString()));
                    body.append(row);
                }
                table.append(body); content.replaceChildren(table);
                paintControl(snapshot);
            } catch (error) {
                summary.textContent = 'Sensor availability · Collector unavailable';
                content.replaceChildren(text('p', 'Current sensor status cannot be retrieved.'));
                paintControl({ sensors: [], controlSource: null });
            } finally { clearTimeout(timeout); pending = false; }
        }
        refresh(); setInterval(refresh, 10000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
