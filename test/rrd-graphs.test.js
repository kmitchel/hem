'use strict';
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {buildGraph,createGraphHandler,solarMarkers,PRESETS}=require('../rrd-graphs');
const SunCalc={getTimes:date=>{const base=new Date(date);base.setUTCHours(0,0,0,0);return{sunrise:new Date(+base+11*3600000),solarNoon:new Date(+base+17*3600000),sunset:new Date(+base+23*3600000)};}};
const now=Date.parse('2026-10-18T23:00:00Z')/1000,options={root:'/test/hem',SunCalc,now};
for(const [preset,duration]of Object.entries(PRESETS)){
    const plan=buildGraph('gpm',{start:preset},options);
    assert.equal(plan.window.to-plan.window.from,duration);
    assert.ok(plan.args.includes('CDEF:fixgpm=gpm,UN,0,gpm,IF'));
    assert.ok(plan.args.includes('LINE1:fixgpm#38bdf8:Water flow (GPM)'));
    assert.ok(plan.args.includes('BACK#121824'));
    const lightPlan=buildGraph('gpm',{start:preset,theme:'light'},options);
    assert.ok(lightPlan.args.includes('LINE1:fixgpm#000000:Water flow (GPM)'));
}
assert.equal(buildGraph('temp',{start:'6h'},options).window.duration,21600);
const custom=buildGraph('temp',{from:String(now-172800),to:String(now-86400),series:'in,out',width:'1600',height:'480',bands:'1'},options);
assert.equal(custom.window.from,now-172800);assert.ok(custom.args.includes('1600'));
assert.ok(custom.args.includes('DEF:in=/test/hem/hem-in.rrd:in:AVERAGE'));
assert.ok(!custom.args.some(arg=>arg.startsWith('DEF:rh=')));
assert.ok(custom.args.some(arg=>arg.startsWith('AREA:inspan#')));
assert.ok(custom.args.some(arg=>arg==='DEF:heat=/test/hem/hem-heat.rrd:heat:AVERAGE'));
const withoutInside=buildGraph('temp',{series:'out',stats:'0'},options);
assert.ok(!withoutInside.args.some(arg=>arg.startsWith('DEF:heat=')));
assert.ok(!withoutInside.args.some(arg=>arg.startsWith('GPRINT:')));
const max=buildGraph('wh',{cf:'MAX',legend:'0'},options);
assert.ok(max.args.includes('DEF:upper=/test/hem/hem-upper.rrd:upper:MAX'));assert.ok(max.args.includes('--no-legend'));
assert.equal(buildGraph('gpm',{cf:'MAX'},options).cf,'AVERAGE');
assert.ok(!buildGraph('watt',{log:'0',min:'0',max:'2000'},options).args.includes('--logarithmic'));
const markers=solarMarkers(now-2*86400,now-86400,SunCalc);
assert.ok(markers.markers.length>=3);
for(const marker of markers.markers){const t=Number(marker.split(':')[1].split('#')[0]);assert.ok(t>=now-2*86400&&t<=now-86400);}
const longMarkers=solarMarkers(now-PRESETS['3y'],now,SunCalc);
assert.ok(longMarkers.stride>1&&longMarkers.markers.length<=78);
for(const [id,query]of [
    ['not-a-graph',{}],['temp',{start:';rm -rf'}],['temp',{series:'../../etc/passwd'}],
    ['temp',{series:'in,in'}],['temp',{from:String(now-60)}],['temp',{from:String(now),to:String(now-60)}],
    ['temp',{from:String(now-60),to:String(now+600)}],['temp',{width:'99999'}],['temp',{height:'2'}],
    ['temp',{min:'20',max:'10'}],['temp',{cf:'LAST'}],['temp',{resolution:'30',start:'365d'}],
    ['watt',{min:'0'}],['temp',{legend:['1','0']}],['temp',{from:'1e5',to:String(now)}],
    ['temp',{theme:'neon'}]
])assert.throws(()=>buildGraph(id,query,options),undefined,JSON.stringify(query));

function response(){const res=new EventEmitter();res.headers={};res.setHeader=(k,v)=>{res.headers[k]=v;};res.status=code=>{res.code=code;return res;};res.json=value=>{res.jsonValue=value;res.writableEnded=true;};res.send=value=>{res.body=value;res.writableEnded=true;};return res;}
function child(){const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.killed=false;p.kill=()=>{p.killed=true;};return p;}
const children=[];
const handle=createGraphHandler({...options,now:()=>now,maxActive:1,spawn:()=>{const p=child();children.push(p);return p;},log:()=>{}});
const req=query=>({params:{id:'temp'},query});
let res=response();handle(req({width:'invalid'}),res);assert.equal(res.code,400);assert.equal(children.length,0);
res=response();handle(req({}),res);const one=children.at(-1),busy=response();handle(req({}),busy);assert.equal(busy.code,503);
one.stdout.emit('data',Buffer.from([137,80,78,71,13,10,26,10,1]));one.emit('close',0);
assert.equal(res.headers['Content-Type'],'image/png');assert.equal(res.body.length,9);
res=response();handle(req({}),res);children.at(-1).stderr.emit('data','broken archive');children.at(-1).emit('close',1);assert.equal(res.code,502);assert.ok(res.jsonValue.error);
res=response();handle(req({}),res);const cancelled=children.at(-1);res.emit('close');assert.ok(cancelled.killed);cancelled.emit('close',null);
res=response();handle(req({}),res);children.at(-1).emit('error',new Error('missing rrdtool'));assert.equal(res.code,502);
console.log('RRD API tests passed: ranges, validation, historical solar markers, traces, extrema, water silence, renderer errors and cancellation');
