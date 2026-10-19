'use strict';
const path = require('node:path');
const PRESETS = { '1h':3600, '2h':7200, '4h':14400, '6h':21600, '12h':43200,
    '24h':86400, '48h':172800, '96h':345600, '7d':604800, '30d':2592000,
    '90d':7776000, '365d':31536000, '3y':94608000 };
const TIERS = [{ step:30, days:2 }, { step:60, days:30 }, { step:300, days:90 },
    { step:900, days:365 }, { step:3600, days:1095 }];
const TRACES = {
    w: { label:'Power', unit:'W', color:'000000', darkColor:'38bdf8' },
    in: { label:'Inside', unit:'F', color:'00ff00', darkColor:'4ade80' },
    out: { label:'Outside', unit:'F', color:'0000ff', darkColor:'38bdf8' },
    dew: { label:'Dew point', unit:'F', color:'000000', darkColor:'c084fc' },
    rh: { label:'Humidity', unit:'%', color:'ff00ff', darkColor:'f472b6' },
    upper: { label:'Upper tank', unit:'F', color:'ff0000', darkColor:'f87171' },
    lower: { label:'Lower tank', unit:'F', color:'0000ff', darkColor:'60a5fa' },
    achigh: { label:'AC high', unit:'F', color:'ff0000', darkColor:'f87171' },
    aclow: { label:'AC low', unit:'F', color:'0000ff', darkColor:'38bdf8' },
    gpm: { label:'Water flow', unit:'GPM', color:'000000', darkColor:'38bdf8' }
};
const GROUPS = {
    watt: { label:'Power', unit:'Watts', traces:['w'] },
    temp: { label:'Temperature & humidity', unit:'F / %', traces:['rh','dew','in','out'] },
    wh: { label:'Water heater', unit:'F', traces:['upper','lower'] },
    ac: { label:'Air conditioning', unit:'F', traces:['aclow','achigh','out'], note:'AC sensors awaiting replacement; older history remains available.' },
    gpm: { label:'Water flow', unit:'GPM', traces:['gpm'], note:'The sensor publishes during flow only. Silence is shown as zero flow.' }
};
class GraphError extends Error { constructor(message, status=400) { super(message); this.status=status; } }
function scalar(query,key,fallback) {
    if (query[key] === undefined) return fallback;
    if (typeof query[key] !== 'string') throw new GraphError('Invalid '+key);
    return query[key];
}
function numeric(query,key,fallback,min,max,integer=false) {
    const text=scalar(query,key,undefined);
    if (text===undefined || text==='') return fallback;
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new GraphError('Invalid '+key);
    const n=Number(text);
    if (!Number.isFinite(n) || n<min || n>max || (integer && !Number.isInteger(n))) throw new GraphError('Invalid '+key);
    return n;
}
function boolean(query,key,fallback) {
    const text=scalar(query,key,undefined);
    if (text===undefined) return fallback;
    if (!['0','1'].includes(text)) throw new GraphError('Invalid '+key);
    return text==='1';
}
function windowFor(query,now) {
    const explicit=query.from!==undefined || query.to!==undefined;
    let from,to;
    if (explicit) {
        from=numeric(query,'from',null,1,4102444800,true);
        to=numeric(query,'to',null,1,4102444800,true);
        if (from===null || to===null) throw new GraphError('Supply both from and to as Unix seconds');
    } else {
        const preset=scalar(query,'start','24h');
        if (!Object.hasOwn(PRESETS,preset)) throw new GraphError('Unknown time range');
        to=now; from=to-PRESETS[preset];
    }
    if (from>=to || to-from<60 || to-from>PRESETS['3y']) throw new GraphError('Choose a range between one minute and 1,095 days');
    if (to>now+300) throw new GraphError('The end date cannot be in the future');
    return { from,to,duration:to-from };
}
function solarMarkers(from,to,SunCalc,theme='dark') {
    // Anchor at 17:00 UTC, always midday in Indianapolis, to preserve calendar
    // dates through DST without changing the collector process timezone.
    const parts=new Intl.DateTimeFormat('en-US',{ timeZone:'America/Indianapolis',year:'numeric',month:'numeric',day:'numeric' }).formatToParts(new Date(from*1000));
    const get=type=>Number(parts.find(part=>part.type===type).value);
    const first=Date.UTC(get('year'),get('month')-1,get('day'),17);
    const days=Math.ceil((to*1000-first)/86400000)+1;
    const stride=Math.max(1,Math.ceil(days/24));
    const markers=[], labeled=new Set();
    const markerColors = theme === 'dark'
        ? [['sunrise','fbbf24','Sunrise'],['solarNoon','f87171','Solar noon'],['sunset','38bdf8','Sunset']]
        : [['sunrise','FFA500','Sunrise'],['solarNoon','ff0000','Solar noon'],['sunset','00a5ff','Sunset']];
    for (let day=0;day<=days;day+=stride) {
        const times=SunCalc.getTimes(new Date(first+day*86400000),41.1660,-85.4831);
        for (const [key,color,label] of markerColors) {
            const t=Math.round(Number(times[key])/1000);
            if (!Number.isFinite(t) || t<from || t>to) continue;
            markers.push(`VRULE:${t}#${color}${labeled.has(key)?'':':'+label}`);
            labeled.add(key);
        }
    }
    return { markers,stride };
}
function buildGraph(id,query,{root,SunCalc,now=Math.floor(Date.now()/1000)}) {
    if (!Object.hasOwn(GROUPS,id)) throw new GraphError('Unknown graph',404);
    const group=GROUPS[id], window=windowFor(query,now);
    const theme=scalar(query,'theme','dark');
    if (!['dark','light'].includes(theme)) throw new GraphError('Invalid theme');
    const width=numeric(query,'width',1080,640,2400,true),height=numeric(query,'height',320,200,900,true);
    const selectedText=scalar(query,'series',group.traces.join(','));
    const selected=selectedText.split(',');
    if (!selected.length || selected.some(s=>!group.traces.includes(s)) || new Set(selected).size!==selected.length) throw new GraphError('Select valid graph lines');
    const cf=scalar(query,'cf','AVERAGE');
    if (!['AVERAGE','MIN','MAX'].includes(cf)) throw new GraphError('Invalid aggregation');
    const effectiveCf=id==='gpm'?'AVERAGE':cf;
    const minimum=numeric(query,'min',null,-1000000000,1000000000);
    const maximum=numeric(query,'max',null,-1000000000,1000000000);
    if (minimum!==null && maximum!==null && minimum>=maximum) throw new GraphError('Y-axis minimum must be below maximum');
    const log=id==='watt' && boolean(query,'log',true);
    if (log && minimum!==null && minimum<=0) throw new GraphError('Logarithmic power requires a positive Y-axis minimum');
    const requested=scalar(query,'resolution','auto');
    const age=Math.max(0,now-window.from);
    // Allow one bucket for alignment/transport delay at an exact preset boundary.
    const retentionStep=(TIERS.find(t=>age<=t.days*86400+t.step)||TIERS.at(-1)).step;
    let step;
    if (requested==='auto') {
        const displayStep=window.duration<=7200?30:window.duration<=43200?60:window.duration<=172800?300:window.duration<=604800?900:3600;
        step=Math.max(retentionStep,displayStep);
    } else {
        if (!TIERS.some(t=>String(t.step)===requested)) throw new GraphError('Invalid resolution');
        step=Number(requested);
        if (step<retentionStep) throw new GraphError('That resolution is outside its retention window; choose Auto or a coarser interval');
    }
    const legend=boolean(query,'legend',true),stats=legend && boolean(query,'stats',true);
    const bands=boolean(query,'bands',false) && effectiveCf==='AVERAGE' && id!=='gpm';
    const args=['graph','-','-a','PNG','--width',String(width),'--height',String(height),'--full-size-mode',
        '--start',String(window.from),'--end',String(window.to),'--step',String(step),
        '--title',group.label+(effectiveCf==='AVERAGE'?'':' — '+effectiveCf.toLowerCase()),'--vertical-label',group.unit];
    if (theme==='dark') {
        args.push(
            '--color','BACK#121824',
            '--color','CANVAS#0d1117',
            '--color','SHADEA#1e293b',
            '--color','SHADEB#1e293b',
            '--color','GRID#1e293b',
            '--color','MGRID#334155',
            '--color','FONT#cbd5e1',
            '--color','AXIS#475569',
            '--color','FRAME#334155',
            '--color','ARROW#94a3b8'
        );
    }
    if (!legend) args.push('--no-legend');
    if (log) args.push('--logarithmic','--units=si');
    if (minimum!==null) args.push('--lower-limit',String(minimum));
    if (maximum!==null) args.push('--upper-limit',String(maximum));
    if (minimum!==null && maximum!==null) args.push('--rigid');
    const solar=solarMarkers(window.from,window.to,SunCalc,theme);
    args.push(...solar.markers);
    const file=name=>path.join(root,`hem-${name}.rrd`);
    const resolveColor=(name)=>{
        const trace=TRACES[name];
        if (theme==='dark') {
            if (id==='ac' && name==='out') return '94a3b8';
            return trace.darkColor||trace.color;
        }
        return id==='ac'&&name==='out'?'000000':trace.color;
    };
    for (const name of selected) {
        const color=resolveColor(name);
        args.push(`DEF:${name}=${file(name)}:${name}:${effectiveCf}`);
        if (bands) {
            args.push(`DEF:${name}min=${file(name)}:${name}:MIN`,`DEF:${name}max=${file(name)}:${name}:MAX`,
                `CDEF:${name}span=${name}max,${name}min,-`,`AREA:${name}min#${color}00`,`AREA:${name}span#${color}25::STACK`);
        }
    }
    for (const name of selected) {
        const trace=TRACES[name], variable=name==='gpm'?'fixgpm':name, color=resolveColor(name);
        if (name==='gpm') args.push('CDEF:fixgpm=gpm,UN,0,gpm,IF'); // Event-only: silence means no water.
        args.push(`LINE1:${variable}#${color}:${trace.label} (${trace.unit})`);
        if (stats) args.push(`GPRINT:${variable}:LAST:Last\\: %6.2lf`,`GPRINT:${variable}:AVERAGE:Avg\\: %6.2lf`,
            `GPRINT:${variable}:MIN:Min\\: %6.2lf`,`GPRINT:${variable}:MAX:Max\\: %6.2lf\\l`);
    }
    if (id==='temp' && selected.includes('in') && boolean(query,'hvac',true)) {
        const heatColor=theme==='dark'?'f87171':'ff0000';
        const coolColor=theme==='dark'?'60a5fa':'0000ff';
        args.push(`DEF:heat=${file('heat')}:heat:AVERAGE`,`DEF:cool=${file('cool')}:cool:AVERAGE`,
            'CDEF:heaton=heat,0,GT,in,UNKN,IF',`LINE1:heaton#${heatColor}:Heating`,
            'CDEF:coolon=cool,0,GT,in,UNKN,IF',`LINE1:coolon#${coolColor}:Cooling`);
    }
    return {args,window,step,solarStride:solar.stride,cf:effectiveCf,theme,
        filename:`hem-${id}-${effectiveCf.toLowerCase()}-${theme}-${new Date(window.from*1000).toISOString().slice(0,10)}-${new Date(window.to*1000).toISOString().slice(0,10)}.png`};
}
function createGraphHandler({root,SunCalc,spawn=require('node:child_process').spawn,now=()=>Math.floor(Date.now()/1000),timeoutMs=15000,maxActive=4,log=console.error}) {
    let active=0;
    return function graph(req,res) {
        let plan;
        try {plan=buildGraph(req.params.id,req.query||{},{root,SunCalc,now:now()});}
        catch(error) {return res.status(error.status||400).json({error:error.message});}
        if (active>=maxActive) {res.setHeader('Retry-After','2');return res.status(503).json({error:'Graphs are busy. Try again in a moment.'});}
        let child,timer,done=false,released=false,bytes=0;
        const chunks=[];
        const release=()=>{if(!released){released=true;active--;clearTimeout(timer);}};
        const fail=(status,message)=>{if(done)return;done=true;if(child)child.kill();release();if(!res.destroyed)res.status(status).json({error:message});};
        active++;
        try {child=spawn('rrdtool',plan.args,{env:{...process.env,TZ:'America/Indianapolis'}});}
        catch(error) {fail(502,'Graph renderer could not start');return;}
        timer=setTimeout(()=>fail(504,'Graph rendering timed out. Try a shorter range.'),timeoutMs);
        let stderr='';
        child.stderr.on('data',chunk=>{if(stderr.length<8192)stderr+=String(chunk);});
        child.stdout.on('data',chunk=>{if(done)return;bytes+=chunk.length;if(bytes>8*1024*1024){fail(502,'Graph image exceeded its size limit');return;}chunks.push(chunk);});
        child.on('error',()=>fail(502,'Graph renderer could not start'));
        child.on('close',code=>{
            release();if(done)return;
            const png=Buffer.concat(chunks);
            if(code!==0 || png.length<8 || !png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
                if(stderr)log('RRD graph failed: '+stderr);
                fail(502,'Graph rendering failed. Check the range and axis limits.');return;
            }
            done=true;
            res.setHeader('Content-Type','image/png');res.setHeader('Cache-Control','no-store');
            res.setHeader('Content-Disposition',`inline; filename="${plan.filename}"`);
            res.setHeader('X-RRD-Step',String(plan.step));res.setHeader('X-RRD-CF',plan.cf);res.setHeader('X-Solar-Stride-Days',String(plan.solarStride));
            res.setHeader('X-RRD-Theme',plan.theme);
            res.send(png);
        });
        res.on('close',()=>{if(!done && !res.writableEnded){done=true;child.kill();release();}});
    };
}
function register(app,options) {
    app.get('/api/rrd-graphs',(req,res)=>{
        res.setHeader('Cache-Control','no-store');
        res.json({groups:GROUPS,traces:TRACES,presets:PRESETS,tiers:TIERS,timeZone:'America/Indianapolis',solar:{latitude:41.1660,longitude:-85.4831}});
    });
    app.get('/graph/:id',createGraphHandler(options));
}
module.exports={PRESETS,TIERS,TRACES,GROUPS,GraphError,windowFor,solarMarkers,buildGraph,createGraphHandler,register};
