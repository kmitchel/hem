(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RRDViewerState=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
    'use strict';
    const periods={'1h':3600,'6h':21600,'12h':43200,'24h':86400,'48h':172800,'96h':345600,'7d':604800,'30d':2592000,'90d':7776000,'365d':31536000,'3y':94608000};
    const defaults=()=>({groups:['watt','temp','wh','gpm'],range:'24h',from:null,to:null,refresh:60,resolution:'auto',cf:'AVERAGE',height:320,width:'auto',legend:true,stats:true,bands:false,hvac:true,log:true,theme:'dark',min:'',max:'',
        lines:{watt:['w'],temp:['rh','dew','in','out'],wh:['upper','lower'],ac:['aclow','achigh','out'],gpm:['gpm']}});
    function read(params){
        const s=defaults();
        if(params.has('graphs'))s.groups=params.get('graphs').split(',').filter((v,i,a)=>Object.hasOwn(s.lines,v)&&a.indexOf(v)===i);
        const range=params.get('range');if(Object.hasOwn(periods,range)||['today','yesterday','custom'].includes(range))s.range=range;
        for(const k of ['from','to']){const n=Number(params.get(k));if(params.has(k)&&Number.isInteger(n)&&n>0)s[k]=n;}
        for(const [key,allowed] of Object.entries({refresh:[0,30,60,300],height:[240,320,480,640],width:['auto','1080','1600','2200'],resolution:['auto','30','60','300','900','3600'],cf:['AVERAGE','MIN','MAX']})){
            const v=typeof allowed[0]==='number'?Number(params.get(key)):params.get(key);if(params.has(key)&&allowed.includes(v))s[key]=v;
        }
        for(const key of ['legend','stats','bands','hvac','log'])if(['0','1'].includes(params.get(key)))s[key]=params.get(key)==='1';
        const theme=params.get('theme');if(['dark','light'].includes(theme))s.theme=theme;
        for(const k of ['min','max']){const v=params.get(k);if(v!==null&&v!==''&&Number.isFinite(Number(v))&&Math.abs(Number(v))<=1e9)s[k]=String(Number(v));}
        for(const group of Object.keys(s.lines))if(params.has(group))s.lines[group]=params.get(group).split(',').filter((v,i,a)=>s.lines[group].includes(v)&&a.indexOf(v)===i);
        if(s.range==='custom')s.refresh=0;
        return s;
    }
    function write(s){
        const p=new URLSearchParams({graphs:s.groups.join(','),range:s.range,refresh:String(s.refresh),resolution:s.resolution,cf:s.cf,height:String(s.height),width:String(s.width),theme:s.theme||'dark'});
        if(s.range==='custom'){if(s.from!==null)p.set('from',String(s.from));if(s.to!==null)p.set('to',String(s.to));}
        for(const k of ['legend','stats','bands','hvac','log'])p.set(k,s[k]?'1':'0');
        for(const k of ['min','max'])if(s[k]!=='')p.set(k,s[k]);
        for(const group of Object.keys(s.lines))p.set(group,s.lines[group].join(','));
        return p;
    }
    function windowFor(s,now=Math.floor(Date.now()/1000)){
        if(s.range==='custom')return{from:s.from,to:s.to};
        if(s.range==='today'||s.range==='yesterday'){
            const end=new Date(now*1000),start=new Date(now*1000);start.setHours(0,0,0,0);
            if(s.range==='yesterday'){end.setTime(start.getTime());start.setDate(start.getDate()-1);}
            return{from:Math.floor(start.getTime()/1000),to:Math.floor(end.getTime()/1000)};
        }
        return{from:now-periods[s.range],to:now};
    }
    function move(window,factor,zoom=false,now=Math.floor(Date.now()/1000)){
        const span=window.to-window.from;
        let from,to;
        if(zoom){const next=Math.max(60,Math.min(periods['3y'],Math.round(span*factor)));const center=(window.from+window.to)/2;from=Math.floor(center-next/2);to=from+next;}
        else{const delta=Math.round(span*factor);from=window.from+delta;to=window.to+delta;}
        if(to>now){from-=to-now;to=now;}
        return{from,to};
    }
    function validate(s,now=Math.floor(Date.now()/1000)){
        const w=windowFor(s,now);
        if(!s.groups.length)return'Select at least one graph.';
        if(!Number.isInteger(w.from)||!Number.isInteger(w.to)||w.from>=w.to||w.to-w.from<60)return'Choose a start and end at least one minute apart.';
        if(w.to-w.from>periods['3y'])return'The maximum range is 1,095 days.';
        if(w.to>now+60)return'The end date cannot be in the future.';
        if(s.min!==''&&!Number.isFinite(Number(s.min))||s.max!==''&&!Number.isFinite(Number(s.max)))return'Enter numeric Y-axis limits.';
        if(s.min!==''&&s.max!==''&&Number(s.min)>=Number(s.max))return'Y-axis minimum must be below maximum.';
        if(s.groups.includes('watt')&&s.log&&s.min!==''&&Number(s.min)<=0)return'Logarithmic power requires a positive Y-axis minimum.';
        for(const group of s.groups)if(!s.lines[group].length)return'Select at least one line for each enabled graph.';
        return null;
    }
    return{defaults,read,write,windowFor,move,validate,periods};
});
