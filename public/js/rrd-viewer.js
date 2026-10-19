/* 3-Pane Master/Detail RRD Dashboard Viewer */
(async function(){
    'use strict';
    const S=window.RRDViewerState,$=id=>document.getElementById(id),key='hem.rrd.viewer.v1';
    const form=$('viewer-controls'),cards=new Map();
    let catalog,state,controller,timer,debounce,generation=0,currentWindow,loading=false;

    function status(message){
        const el=$('status');
        if(el)el.textContent=message;
    }
    function error(message){
        const el=$('form-error');
        if(!el)return;
        el.textContent=message||'';
        el.hidden=!message;
    }
    const el=(tag,text,className)=>{
        const node=document.createElement(tag);
        if(text!==undefined)node.textContent=text;
        if(className)node.className=className;
        return node;
    };
    function dateInput(seconds){
        if(!Number.isFinite(seconds))return'';
        const d=new Date(seconds*1000),pad=n=>String(n).padStart(2,'0');
        return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function updateActiveCount(){
        const badge=$('active-count-badge');
        if(badge)badge.textContent=state.groups.length+' active';
    }

    function paint(){
        for(const id of ['range','refresh','resolution','cf','height','width','min','max']){
            const node=$(id);if(node)node.value=state[id];
        }
        for(const id of ['legend','stats','bands','hvac','log']){
            const node=$(id);if(node)node.checked=state[id];
        }
        const w=S.windowFor(state);
        if($('from'))$('from').value=dateInput(w.from);
        if($('to'))$('to').value=dateInput(w.to);
        if($('custom-dates'))$('custom-dates').hidden=state.range!=='custom';

        if($('refresh'))$('refresh').disabled=state.range==='custom'||state.range==='yesterday';
        if($('stats'))$('stats').disabled=!state.legend;
        if($('bands'))$('bands').disabled=state.cf!=='AVERAGE';

        document.querySelectorAll('.preset-btn').forEach(btn=>{
            btn.classList.toggle('active',btn.dataset.range===state.range);
        });

        // Update View Mode buttons
        const isAll=state.active==='all';
        if($('view-mode-focus'))$('view-mode-focus').classList.toggle('active',!isAll);
        if($('view-mode-all'))$('view-mode-all').classList.toggle('active',isAll);

        // Update master stream cards
        document.querySelectorAll('.stream-card').forEach(card=>{
            const group=card.dataset.group;
            const isChecked=state.groups.includes(group);
            const input=card.querySelector('input[type=checkbox]');
            if(input)input.checked=isChecked;
            card.classList.toggle('disabled',!isChecked);
            card.classList.toggle('active',!isAll&&state.active===group);
        });

        updateActiveCount();

        // Update inspector metric heading
        const heading=$('inspector-heading');
        const activeGroup=state.active==='all'?(state.groups[0]||'watt'):state.active;
        if(heading&&catalog&&catalog.groups[activeGroup]){
            heading.textContent=isAll?'All Metrics Inspector':catalog.groups[activeGroup].label;
        }

        // Filter/highlight inspector trace options
        document.querySelectorAll('.graph-choice').forEach(choice=>{
            const group=choice.dataset.group;
            if(!group)return;
            const check=$('group-'+group);
            if(check){
                check.checked=state.groups.includes(group);
                choice.classList.toggle('disabled',!check.checked);
            }
            if(!isAll){
                choice.style.display=(group===activeGroup)?'block':'none';
            }else{
                choice.style.display='block';
            }
            if(catalog&&catalog.groups[group]){
                for(const trace of catalog.groups[group].traces){
                    const input=$('trace-'+group+'-'+trace);
                    if(input){
                        input.checked=state.lines[group].includes(trace);
                        input.disabled=!state.groups.includes(group);
                    }
                }
            }
        });
    }

    function read(){
        const next=structuredClone(state);
        for(const id of ['range','resolution','cf','width','min','max']){
            const node=$(id);if(node)next[id]=node.value;
        }
        for(const id of ['min','max'])if(next[id]!==''&&Number.isFinite(Number(next[id])))next[id]=String(Number(next[id]));
        for(const id of ['refresh','height']){
            const node=$(id);if(node)next[id]=Number(node.value);
        }
        for(const id of ['legend','stats','bands','hvac','log']){
            const node=$(id);if(node)next[id]=node.checked;
        }
        next.groups=Object.keys(catalog.groups).filter(group=>{
            const node=$('group-'+group);return node&&node.checked;
        });
        for(const [group,definition]of Object.entries(catalog.groups)){
            if(definition.traces.length>1){
                next.lines[group]=definition.traces.filter(trace=>{
                    const node=$('trace-'+group+'-'+trace);return node&&node.checked;
                });
            }
        }
        if(next.range==='custom'){
            const fromEl=$('from'),toEl=$('to');
            next.from=fromEl&&fromEl.value?Math.floor(new Date(fromEl.value).getTime()/1000):null;
            next.to=toEl&&toEl.value?Math.floor(new Date(toEl.value).getTime()/1000):null;
            next.refresh=0;
        }
        return next;
    }

    function save(){
        const params=S.write(state),url=new URL(location.href);url.search=params.toString();url.hash='';
        history.replaceState(null,'',url);
        try{localStorage.setItem(key,params.toString());}catch{}
    }

    function setupChoices(){
        const fragment=document.createDocumentFragment();
        for(const [group,definition]of Object.entries(catalog.groups)){
            const box=el('div',undefined,'graph-choice'),label=el('label',undefined,'check group-check'),input=el('input');
            box.dataset.group=group;
            input.type='checkbox';input.id='group-'+group;
            label.append(input,el('span',definition.label));box.append(label);
            if(definition.note)box.title=definition.note;
            if(definition.traces.length>1){
                const lines=el('div',undefined,'trace-options');
                for(const trace of definition.traces){
                    const line=el('label',undefined,'check trace-check'),checkbox=el('input');
                    checkbox.type='checkbox';checkbox.id='trace-'+group+'-'+trace;
                    line.append(checkbox,el('span',catalog.traces[trace].label));lines.append(line);
                }box.append(lines);
            }fragment.append(box);
        }$('graph-options').replaceChildren(fragment);
    }

    function visibleGroups(){
        if(state.active&&state.active!=='all'&&state.groups.includes(state.active)){
            return [state.active];
        }
        return state.groups;
    }

    function synchronizeCards(){
        const activeList=visibleGroups();
        for(const [id,card]of cards){
            if(!activeList.includes(id)){
                if(card.objectUrl)URL.revokeObjectURL(card.objectUrl);
                card.article.remove();
                cards.delete(id);
            }
        }
        for(const id of activeList){
            if(!cards.has(id)){
                const definition=catalog.groups[id],article=el('article',undefined,'graph-card');
                article.dataset.graph=id;
                const heading=el('div',undefined,'card-heading');
                heading.append(el('h2',definition.label,'card-title'));
                const right=el('div',undefined,'card-right');
                const message=el('span','…','card-status');
                const links=el('div',undefined,'graph-links');
                const open=el('a','Open','link-btn'),download=el('a','PNG','link-btn');
                open.target='_blank';open.rel='noopener';open.setAttribute('aria-disabled','true');
                download.setAttribute('aria-disabled','true');
                links.append(open,download);
                right.append(message,links);
                heading.append(right);
                const frame=el('div',undefined,'graph-frame'),img=el('img');
                img.hidden=true;img.alt=definition.label+' graph';
                frame.append(img);
                article.append(heading,frame);
                if(definition.note)article.append(el('p',definition.note,'card-note'));
                cards.set(id,{article,message,frame,img,open,download,objectUrl:null});
            }
            $('graphs').append(cards.get(id).article);
        }
    }

    function graphUrl(id,window,containerWidth){
        const width=state.width==='auto'?containerWidth:Number(state.width);
        const p=new URLSearchParams({
            from:String(window.from),
            to:String(window.to),
            series:state.lines[id].join(','),
            width:String(width),
            height:String(state.height),
            resolution:state.resolution,
            cf:state.cf,
            theme:state.theme||'dark'
        });
        for(const k of ['legend','stats','bands','hvac','log'])p.set(k,state[k]?'1':'0');
        for(const k of ['min','max'])if(state[k]!=='')p.set(k,state[k]);
        return'/graph/'+id+'?'+p;
    }

    function caption(w){
        const format=new Intl.DateTimeFormat(undefined,{dateStyle:'short',timeStyle:'short',timeZone:'America/Indianapolis'});
        $('window-label').textContent=format.format(new Date(w.from*1000))+' — '+format.format(new Date(w.to*1000))+' (Indianapolis)';
        if($('forward'))$('forward').disabled=w.to>=Math.floor(Date.now()/1000)-5;
    }

    function schedule(){
        clearTimeout(timer);
        if(state.refresh>0&&!['custom','yesterday'].includes(state.range))timer=setTimeout(()=>{
            if(!document.hidden&&!loading)render();else schedule();
        },state.refresh*1000);
    }

    async function render(){
        clearTimeout(timer);clearTimeout(debounce);
        const invalid=S.validate(state);if(invalid){error(invalid);status('Adjust controls to generate view.');return;}
        error();if(controller)controller.abort();controller=new AbortController();const signal=controller.signal,token=++generation;
        loading=true;save();synchronizeCards();currentWindow=S.windowFor(state);caption(currentWindow);
        const containerWidth=$('graphs')?Math.max(500,Math.min(2400,Math.round($('graphs').clientWidth-2))):1080;
        const targets=visibleGroups();
        const jobs=targets.map(id=>({id,url:graphUrl(id,currentWindow,containerWidth)}));
        status('Rendering '+jobs.length+' graph'+(jobs.length===1?'':'s')+'…');
        for(const {id}of jobs){
            const card=cards.get(id);
            if(card){
                card.article.setAttribute('aria-busy','true');
                card.message.textContent='Rendering…';
                card.message.classList.remove('error');
            }
        }
        let successes=0,failures=0;
        async function worker(){
            while(jobs.length&&!signal.aborted){
                const {id,url}=jobs.shift(),card=cards.get(id);
                if(!card)continue;
                try{
                    const response=await fetch(url,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(22000)])});
                    if(!response.ok){let message='Graph request failed ('+response.status+').';try{message=(await response.json()).error||message;}catch{}throw new Error(message);}
                    if(!(response.headers.get('Content-Type')||'').startsWith('image/png'))throw new Error('No image returned.');
                    const blob=await response.blob();if(token!==generation||signal.aborted)return;
                    const objectUrl=URL.createObjectURL(blob),old=card.objectUrl,preview=new Image();preview.src=objectUrl;
                    try{await preview.decode();}catch(e){URL.revokeObjectURL(objectUrl);throw new Error('Image decode error.');}
                    if(token!==generation||signal.aborted){URL.revokeObjectURL(objectUrl);return;}
                    card.img.src=objectUrl;card.objectUrl=objectUrl;if(old)URL.revokeObjectURL(old);card.img.hidden=false;
                    const step=Number(response.headers.get('X-RRD-Step')),stride=Number(response.headers.get('X-Solar-Stride-Days'));
                    const stepText=step<60?step+'s':step<3600?step/60+'m':step/3600+'h';
                    const cf=(response.headers.get('X-RRD-CF')||'AVERAGE').toLowerCase();
                    card.message.textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · '+cf+' · '+stepText+(stride>1?' · '+stride+'d solar':'');
                    card.open.href=url;card.open.setAttribute('aria-disabled','false');card.download.href=objectUrl;
                    card.download.download='hem-'+id+'-'+cf+'-'+currentWindow.from+'-'+currentWindow.to+'.png';card.download.setAttribute('aria-disabled','false');successes++;
                }catch(e){
                    if(signal.aborted||token!==generation)return;
                    card.message.textContent=(card.objectUrl?'Cached · ':'')+e.message;card.message.classList.add('error');failures++;
                }finally{if(token===generation&&cards.has(id))card.article.setAttribute('aria-busy','false');}
            }
        }
        await Promise.all([worker(),worker()]);if(token!==generation)return;
        loading=false;status(failures?successes+' updated, '+failures+' failed':successes+' graph'+(successes===1?'':'s')+' ready · '+(state.refresh>0&&!['custom','yesterday'].includes(state.range)?'refresh: '+state.refresh+'s':'manual'));
        schedule();
    }

    function apply(){state=read();paint();render();}
    function navigate(factor,zoom){
        const invalid=S.validate(state);if(invalid){error(invalid);return;}
        const w=S.move(currentWindow||S.windowFor(state),factor,zoom);Object.assign(state,w,{range:'custom',refresh:0,resolution:'auto'});paint();render();
    }

    try{
        const response=await fetch('/api/rrd-graphs',{cache:'no-store'});if(!response.ok)throw new Error('Graph options unavailable.');catalog=await response.json();
        let saved='';try{saved=localStorage.getItem(key)||'';}catch{}
        state=S.read(new URLSearchParams(location.search||saved));
        setupChoices();paint();

        form.addEventListener('submit',event=>{event.preventDefault();apply();});
        form.addEventListener('change',event=>{
            if(event.target.id==='range'&&event.target.value==='custom'){
                state=read();const w=currentWindow||S.windowFor(S.defaults());state.from=w.from;state.to=w.to;state.refresh=0;paint();clearTimeout(timer);return;
            }
            if(['from','to','min','max'].includes(event.target.id))return;
            clearTimeout(debounce);debounce=setTimeout(apply,250);
        });

        // Preset button clicks
        document.addEventListener('click',event=>{
            const btn=event.target.closest('.preset-btn');
            if(!btn)return;
            const r=btn.dataset.range;
            if(!r)return;
            $('range').value=r;
            if(r==='custom'){
                state=read();const w=currentWindow||S.windowFor(S.defaults());state.from=w.from;state.to=w.to;state.refresh=0;paint();clearTimeout(timer);return;
            }
            apply();
        });

        // Master stream selection & toggle
        document.addEventListener('click',event=>{
            const card=event.target.closest('.stream-card');
            if(!card)return;
            const group=card.dataset.group;
            if(event.target.matches('input[type=checkbox]')){
                // User clicked the checkbox to enable/disable group
                if(event.target.checked){
                    if(!state.groups.includes(group))state.groups.push(group);
                }else{
                    state.groups=state.groups.filter(g=>g!==group);
                }
                const inspectorCheck=$('group-'+group);
                if(inspectorCheck)inspectorCheck.checked=event.target.checked;
                apply();
                return;
            }
            // User clicked card body -> focus this metric in detail pane
            state.active=group;
            if(!state.groups.includes(group))state.groups.push(group);
            paint();
            render();
        });

        // View Mode toggles
        if($('view-mode-focus'))$('view-mode-focus').addEventListener('click',()=>{
            state.active=state.active==='all'?(state.groups[0]||'watt'):state.active;
            paint();render();
        });
        if($('view-mode-all'))$('view-mode-all').addEventListener('click',()=>{
            state.active='all';
            paint();render();
        });

        // Sidebar toggles for mobile / tablet
        if($('toggle-sidebar-left'))$('toggle-sidebar-left').addEventListener('click',()=>{
            $('pane-master').classList.toggle('open');
            $('pane-inspector').classList.remove('open');
        });
        if($('toggle-sidebar-right'))$('toggle-sidebar-right').addEventListener('click',()=>{
            $('pane-inspector').classList.toggle('open');
            $('pane-master').classList.remove('open');
        });

        $('reload').addEventListener('click',apply);
        $('back').addEventListener('click',()=>navigate(-.5,false));$('forward').addEventListener('click',()=>navigate(.5,false));
        $('zoom-in').addEventListener('click',()=>navigate(.5,true));$('zoom-out').addEventListener('click',()=>navigate(2,true));
        $('now').addEventListener('click',()=>{
            if(state.range==='custom'||state.range==='yesterday'){
                const w=currentWindow||S.windowFor(state),span=w.to-w.from;
                state.range=Object.keys(S.periods).find(k=>S.periods[k]===span)||'24h';
            }paint();render();
        });
        $('reset').addEventListener('click',()=>{state=S.defaults();paint();render();});
        $('share').addEventListener('click',async()=>{
            const candidate=read(),invalid=S.validate(candidate);if(invalid){error(invalid);return;}
            state=candidate;save();
            const shareBtn=$('share'),orig=shareBtn.textContent;
            try{
                await navigator.clipboard.writeText(location.href);
                status('Link copied to clipboard');
                shareBtn.textContent='✓ Copied';
                setTimeout(()=>{shareBtn.textContent=orig;},2000);
            }
            catch{
                $('share-fallback').hidden=false;$('share-url').value=location.href;$('share-url').select();status('Copy link from input');
            }
        });
        window.addEventListener('popstate',()=>{state=S.read(new URLSearchParams(location.search));paint();render();});
        document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!loading&&state.refresh>0&&!['custom','yesterday'].includes(state.range))render();});
        window.addEventListener('pagehide',()=>{if(controller)controller.abort();for(const card of cards.values())if(card.objectUrl)URL.revokeObjectURL(card.objectUrl);});
        render();
    }catch(e){error(e.message+' Reload to retry.');status('Viewer unavailable');}
})();
