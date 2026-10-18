'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const routes = {}, invocations = [];
const mqtt = new EventEmitter();
const child = new EventEmitter();
child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
child.stdout.pipe = () => {}; child.stdin = { write() {} };
const app = { get: (route, handler) => { routes[route] = handler; }, use() {} };
const express = () => app; express.static = () => () => {};
const mocks = {
    child_process: { spawn: (cmd, args) => { invocations.push([cmd, args]); return child; } },
    express, compression: () => () => {}, http: { Server: () => ({ listen() {} }) },
    suncalc: { getTimes: () => ({ sunrise: new Date(), solarNoon: new Date(), sunset: new Date() }) },
    level: () => ({}), mqtt: { connect: () => mqtt }, './retention': { startRetention() {} }
};
vm.runInNewContext(fs.readFileSync(require.resolve('../index'), 'utf8'), {
    require: name => mocks[name] || require('../' + name.replace(/^\.\//, '')),
    __dirname: '/test/hem', performance: require('node:perf_hooks').performance, console
});
for (const [period, step, start] of [
    ['12h', 60, 'now-12hour'], ['48h', 300, 'now-48hour'], ['96h', 900, 'now-96hour'],
    ['7d', 900, 'now-7days'], ['30d', 3600, 'now-30days'], ['90d', 3600, 'now-90days'],
    ['365d', 3600, 'now-365days'], ['3y', 3600, 'now-1095days']
]) {
    routes['/graph/:id']({ query: { start: period }, params: { id: 'gpm' } }, { setHeader() {} });
    const [cmd, args] = invocations.at(-1);
    assert.equal(cmd, 'rrdtool');
    assert.equal(args[args.indexOf('--step')+1], String(step));
    assert.ok(args.includes(start));
    assert.ok(args.includes('LINE1:fixgpm#000000:GPM'));
    assert.ok(args.includes('CDEF:fixgpm=gpm,UN,0,gpm,IF'), 'Event-only water sensor silence means zero flow');
}
console.log('RRD graph tests passed: retained-tier steps, long history ranges and zero flow during water sensor silence');
