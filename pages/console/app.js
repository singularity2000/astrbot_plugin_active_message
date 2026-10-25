/* Native AstrBot Pages client. All user/model text is rendered with textContent. */
(() => {
  'use strict';
  const {t,runtime:R,value:V}=window.ActiveMessageI18n;
  const $ = id => document.getElementById(id);
  const {node: el, dialog, copyText, help, helpNote, hideHelp, preserveView,sessionLabel:S,sessionText:ST,sessionReferences:SR} = window.ActiveMessageUI;
  const clone = value => JSON.parse(JSON.stringify(value));
  const get = (obj, path) => path.reduce((o,k) => o?.[k], obj);
  const blank = v => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.every(x => !String(x).trim()));
  const tabs = () => [['overview',t("pages.console.ui.s80959ffa56")],['traces',t("pages.console.ui.s596c4f198f")],['groups',t("pages.console.ui.s2cb02a6a10")],['interjection',t("pages.console.ui.s5453160ded")],['proactive',t("pages.console.ui.s5e6f228dbe")],['schedule',t("pages.console.ui.sf284e9eacb")],['context',t("pages.console.ui.s994242dcac")]];
  const state = {tab:'overview',scope:-1,dirty:false,busy:false,config:null,schema:null,effective:null,status:null,
    run:null,step:0,traceSeq:0,previewSeq:0,live:false,traceLive:false,preferences:{theme:'auto'},placeholders:[],templateFocus:null,
    samples:{model:0.8,activity:0.8,energy:0.6},scoreWeights:null,scoreScope:null,scoreCustom:false,tour:false};
  const traceBrowser=createTraceBrowser({state,el,section,refreshStatus,api,fail,drawTrace,persistPrefs});
  const scheduleView=createScheduleStrip({state,el});
  let statusPending=null;
  let bridge, previewTimer, latestTheme=false, fieldId=0, prefsQueue=Promise.resolve();
  const dock=window.createPlaceholderDock({catalog:()=>state.placeholders,report:notice});
  let draggedGroup=null;
  let renderedScope=null,renderRevision=0;
  const changeTracker=window.ActiveMessageChanges.createTracker();
  let lastChangeLocations=[];
  const agendaUI=window.createAgendaUI({state,render,previewSoon,field,section,persistPrefs,saveAgenda,refreshAgenda,fail});

  /* 回放筛选属于浏览状态；刷新只更新记录，保留输入、详情和滚动位置。 */
  function createTraceBrowser({state, el, section, refreshStatus, api, fail, drawTrace, persistPrefs}) {
    const filters={group:'',sid:'',minutes:0,kinds:new Set(['ordinary','other','interjection','proactive']),results:new Set(['running','sent','quiet','error'])};
    let host, list, groupSelect, summary, renderedIds='',searchTimer;
    function save(){persistPrefs({trace_group:filters.group,trace_sid:filters.sid,trace_minutes:filters.minutes,trace_kinds:[...filters.kinds],trace_results:[...filters.results],trace_live:state.traceLive});}
    function groupKey(index){return (state.status?.groups||[]).find(g=>g.index===index)?.key??String(index);}
    function groupIndex(run){return Object.hasOwn(run,'group_index')?run.group_index:(state.status?.sessions||[]).find(s=>s.sid===run.sid)?.group_index??null;}
    function kind(run){return run.kind||'other';}
    function outcomes(run){
      const values=[];
      if(run.result==='running')values.push('running');
      if(run.progress?.sent||run.sent)values.push('sent');
      if(run.error)values.push('error');
      if(!values.length)values.push('quiet');
      return values;
    }
    function matches(run){
      const index=groupIndex(run);
      return (!filters.group||(filters.group==='ungrouped'?index===null:groupKey(index)===filters.group))
        &&S(run.sid).toLowerCase().includes(filters.sid.trim().toLowerCase())
        &&filters.kinds.has(kind(run))&&outcomes(run).some(value=>filters.results.has(value))
        &&(!filters.minutes||run.created_at>=Date.now()/1000-filters.minutes*60);
    }
    function multi(title, choices, selected){
      const field=el('div',undefined,'trace-filter-checks');field.setAttribute('role','group');field.setAttribute('aria-label',title);field.append(el('strong',title,'trace-filter-title'));
      for(const [key,caption] of choices){const label=el('label'),check=el('input');check.type='checkbox';check.checked=selected.has(key);check.onchange=()=>{check.checked?selected.add(key):selected.delete(key);save();update(true);};label.append(check,document.createTextNode(caption));field.append(label);}
      return field;
    }
    function update(force=false){
      if(!host?.isConnected||state.tab!=='traces')return;
      const runs=state.status?.runs||[],groups=state.status?.groups||[];
      const options=[['',t("pages.console.ui.s778fc8f994")],...groups.map(g=>[g.key??String(g.index),g.name||t("pages.console.ui.sd82edc4765")])];
      if(groups.length&&runs.some(r=>groupIndex(r)===null))options.push(['ungrouped',t("pages.console.ui.sae6e3be564")]);
      const optionKey=JSON.stringify(options);
      if(groupSelect.dataset.options!==optionKey){groupSelect.replaceChildren(...options.map(([value,text])=>new Option(text,value)));groupSelect.dataset.options=optionKey;if(!options.some(([key])=>key===filters.group))filters.group='';groupSelect.value=filters.group;}
      const matching=runs.filter(matches),signature=JSON.stringify(matching.map(r=>[r.run_id,r.status,r.kind,r.created_at]));
      if(state.run&&!matching.some(run=>run.run_id===state.run.run_id)){
        state.traceSeq++;state.run=null;state.step=0;drawTrace();
      }
      summary.textContent=t("pages.console.ui.scb3a43eea3")+matching.length+' / '+runs.length+t("pages.console.ui.sa0cd378be4");
      if(force||signature!==renderedIds){
        const scroll=list.scrollTop,buttons=matching.map(run=>{
          const b=el('button',(run.kind==='proactive'?t("pages.console.ui.s5e6f228dbe"):run.kind==='interjection'?t("pages.console.ui.s5453160ded"):run.kind==='ordinary'?t("pages.console.ui.s91a31123dd"):t("pages.console.ui.s98fcd3ca25"))+' · '+window.ActiveMessageI18n.runtime(run.status),'trace-item');b.dataset.runId=run.run_id;b.append(el('small',S(run.sid)),el('small',new Date(run.created_at*1000).toLocaleString(window.ActiveMessageI18n.getLocale())));
          b.onclick=async()=>{const seq=++state.traceSeq;try{const value=await api('trace',undefined,{run_id:run.run_id});if(seq!==state.traceSeq||state.tab!=='traces')return;const current=(state.status?.runs||[]).find(r=>r.run_id===run.run_id);if(!current||!matches(current))return;state.run=value;state.step=0;highlight();drawTrace();}catch(e){if(seq===state.traceSeq)fail(e);}};return b;
        });
        list.replaceChildren(...buttons);if(!matching.length)list.append(el('p',runs.length?t("pages.console.ui.s856890ff55"):t("pages.console.ui.sb329eb6906"),'empty'));list.scrollTop=scroll;renderedIds=signature;
      }
      highlight();
    }
    function highlight(){list.querySelectorAll('[data-run-id]').forEach(b=>b.classList.toggle('active',b.dataset.runId===state.run?.run_id));}
    return {update,restore(){
      const p=state.preferences;
      if(typeof p.trace_group==='string')filters.group=p.trace_group;
      if(typeof p.trace_sid==='string')filters.sid=p.trace_sid;
      if([0,5,30,60,180,360,720,1440].includes(p.trace_minutes))filters.minutes=p.trace_minutes;
      if(Array.isArray(p.trace_kinds))filters.kinds=new Set(p.trace_kinds.filter(k=>['ordinary','other','interjection','proactive'].includes(k)));
      if(Array.isArray(p.trace_results))filters.results=new Set(p.trace_results.filter(k=>['running','sent','quiet','error'].includes(k)));
      state.traceLive=p.trace_live===true;
    },render(root){
      host=section(t("pages.console.ui.s42da210ee0"),t("pages.console.ui.s8cd0b0e354"));host.id='trace-intro';
      const toolbar=el('div',undefined,'trace-toolbar'),actions=el('div',undefined,'actions'),refresh=el('button',t("pages.console.ui.s7b0ae4c99f")),label=el('label'),live=el('input');refresh.onclick=()=>refreshStatus().catch(fail);live.type='checkbox';live.checked=state.traceLive;live.onchange=()=>{state.traceLive=live.checked;save();};label.append(live,document.createTextNode(t("pages.console.ui.seea28ea3ee")));actions.append(refresh,label);toolbar.append(actions);host.append(toolbar);
      const bar=el('div',undefined,'trace-filter-bar');groupSelect=el('select');groupSelect.setAttribute('aria-label',t("pages.console.ui.sdcdf72163c"));groupSelect.onchange=()=>{filters.group=groupSelect.value;save();update(true);};
      const sid=el('input');sid.type='search';sid.placeholder=t("pages.console.ui.s4598fe6c7d");sid.setAttribute('aria-label',t("pages.console.ui.sddc0ff6de0"));sid.maxLength=1000;sid.value=filters.sid;sid.oninput=()=>{filters.sid=sid.value;update(true);clearTimeout(searchTimer);searchTimer=setTimeout(save,300);};sid.onchange=()=>{clearTimeout(searchTimer);save();};
      const time=el('select');time.setAttribute('aria-label',t("pages.console.ui.s2d6db4126f"));for(const [value,caption] of [[0,t("pages.console.ui.s09c4fc252c")],[5,t("pages.console.ui.sb7150505d5")],[30,t("pages.console.ui.s40276e3f9b")],[60,t("pages.console.ui.s92e6814bba")],[180,t("pages.console.ui.s66387a4077")],[360,t("pages.console.ui.s5a6f35c4fd")],[720,t("pages.console.ui.sa07f9b382d")],[1440,t("pages.console.ui.seb9f889d6a")]])time.add(new Option(caption,String(value)));time.value=String(filters.minutes);time.onchange=()=>{filters.minutes=Number(time.value);save();update(true);};
      function labeled(caption,control){const label=el('label',caption);label.append(control);return label;}bar.append(labeled(t("pages.console.ui.s2cb02a6a10"),groupSelect),labeled('SID',sid),labeled(t("pages.console.ui.s89b4aa6364"),time));toolbar.append(bar);
      const choices=el('div',undefined,'trace-choice-row');choices.append(multi(t("pages.console.ui.s5b2d75aa54"),[['ordinary',t("pages.console.ui.s59f50e6e9f")],['other',t("pages.console.ui.sfbf6c141cc")],['interjection',t("pages.console.ui.s5453160ded")],['proactive',t("pages.console.ui.s5e6f228dbe")]],filters.kinds),multi(t("pages.console.ui.s1b213f405b"),[['running',t("pages.console.ui.s6f1972e48e")],['sent',t("pages.console.ui.safb62932a7")],['quiet',t("pages.console.ui.se6fb07f93f")],['error',t("pages.console.ui.s5caf279339")]],filters.results));host.append(choices);
      summary=el('small',undefined,'trace-filter-summary');host.append(summary);root.append(host);
      const grid=el('div',undefined,'trace-grid');list=el('section',undefined,'trace-list');list.setAttribute('aria-label',t("pages.console.ui.s24fb424dfd"));const steps=el('div',undefined,'trace-steps');steps.id='trace-steps';const detail=el('section',undefined,'trace-detail');detail.id='trace-detail';grid.append(list,steps,detail);root.append(grid);renderedIds='';update(true);drawTrace();
    }};
  }

  /* 按真实分钟划分作息色段；当前时间使用服务端预览时区。 */
  function createScheduleStrip({state,el}) {
    let clock=null,receivedAt=0,selectedSid='',scopeKey='',renderedDate='',selectedAt='',reallocating=false;
    const statuses=()=>({pending:t("pages.console.ui.sc4804ff109"),running:t("pages.console.ui.s6f1972e48e"),sent:t("pages.console.ui.safb62932a7"),quiet:t("pages.console.ui.s2050f3bc00"),failed:t("pages.console.ui.sb61b08aec3"),skipped:t("pages.console.ui.s9f38afd41e"),missed:t("pages.console.ui.sf1d0e1ac37")});
    function ranges(spec){return (spec||'').split(',').filter(p=>p.trim()).map(part=>{const clocks=part.trim().split('-');if(clocks.length!==2)throw Error();return clocks.map(t=>{if(!/^\d{1,2}:\d{2}$/.test(t.trim()))throw Error();const [h,m]=t.trim().split(':').map(Number);if(h>23||m>59)throw Error();return h*60+m;});});}
    const format=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(Math.floor(m%60)).padStart(2,'0');
    function moment(date){
      try{const values=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:clock?.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));return {day:values.year+'-'+values.month+'-'+values.day,minute:Number(values.hour)*60+Number(values.minute)+Number(values.second)/60};}
      catch{const offset=/([+-])(\d{2}):(\d{2})$/.exec(clock?.now||''),mins=offset?(Number(offset[2])*60+Number(offset[3]))*(offset[1]==='-'?-1:1):0,local=new Date(date.getTime()+mins*60000);return {day:local.toISOString().slice(0,10),minute:local.getUTCHours()*60+local.getUTCMinutes()+local.getUTCSeconds()/60};}
    }
    function current(){return new Date(Date.parse(clock?.now||new Date().toISOString())+Date.now()-receivedAt);}
    function sessions(){const group=state.scope>=0?state.config.session_groups[state.scope]:null;return (state.status?.sessions||[]).filter(s=>s.matched&&(group?!!group.agenda_id&&s.group_id===group.agenda_id:s.group_id==null));}
    function reallocationState(){
      const selected=sessions().find(s=>s.sid===selectedSid),plan=selected?.reallocation;
      const now=current(),today=moment(now).day;
      const count=(selected?.schedule||[]).filter(row=>row.status==='pending'&&Date.parse(row.at)>now.getTime()).length;
      const reason=reallocating?t("pages.console.ui.sed48b8f83d"):state.tour?t("pages.console.ui.s8c5cdfcfc0"):state.busy?t("pages.console.ui.s9d3f3cc516"):
        !selected?t("pages.console.ui.sd20f4b9d0a"):
        !plan?t("pages.console.ui.s2609b6adc1"):
        selected.schedule_timezone!==clock?.timezone?t("pages.console.ui.s84ef3cdcba"):
        R(plan.reason)||((plan.date!==today||!count)?t("pages.console.ui.s05b8962d33"):
          count!==plan.count?t("pages.console.ui.sb6e8f870fd"):'');
      return {selected,plan,reason};
    }
    function updateReallocation(){
      const button=document.getElementById('redistribute-proactive'),hint=document.getElementById('redistribute-hint');if(!button||!hint)return;
      const {reason}=reallocationState();button.disabled=!!reason;button.title=reason;if(hint.textContent!==reason)hint.textContent=reason;hint.hidden=!reason;
    }
    async function redistribute(){
      const {selected,plan,reason}=reallocationState();if(reason)return;
      const sid=selected.sid,revision=state.revision,scheduleRevision=plan.revision;
      let locked=false,saved=false;reallocating=true;updateReallocation();
      try{
        const confirmed=await dialog({title:t("pages.console.ui.sfcfdc4db71"),message:t("pages.console.ui.s5e552e7d27")+S(sid)+t("pages.console.ui.s4b05f0e460")+plan.date+'（'+plan.timezone+t("pages.console.ui.s2bd06952be")+plan.count+t("pages.console.ui.s8f469a4fb4"),confirm:t("pages.console.ui.s26a44d8d21"),cancel:t("pages.console.ui.s4d0b4688c7")});
        if(!confirmed)return;
        locked=true;busy(true);
        const result=await api('redistribute',{sid,revision,schedule_revision:scheduleRevision});saved=true;
        if(statusPending)await statusPending;
        await refreshStatus();
        notice(t("pages.console.ui.sec74f8a1b5")+result.date+t("pages.console.ui.s246cfa4efb")+result.count+t("pages.console.ui.s6c40c566e0")+S(sid)+'。');
      }catch(error){
        notice(saved?t("pages.console.ui.sefd200667a")+error.message:error.message,true);
        if(!saved)try{if(statusPending)await statusPending;await refreshStatus();}catch{}
      }finally{reallocating=false;if(locked)busy(false);if(state.tab==='schedule')render();}
    }
    function updateClock(){
      const marker=document.getElementById('schedule-now');if(!marker||!clock)return;
      const now=current(),point=moment(now);if(renderedDate&&point.day!==renderedDate){render();return;}
      marker.style.left=point.minute/1440*100+'%';marker.dataset.edge=point.minute<120?'start':point.minute>1320?'end':'middle';marker.querySelector('span').textContent=t("pages.console.ui.s672d2d8473")+format(point.minute);marker.setAttribute('aria-label',t("pages.console.ui.s91bba5b9e4")+format(point.minute)+'，'+clock.timezone);
      document.querySelectorAll('.schedule-slot[data-status=pending]').forEach(n=>{n.classList.toggle('awaiting-sync',Number(n.dataset.at)<=now.getTime());});
      updateReallocation();
    }
    function render(){
      const box=document.getElementById('schedule-preview');if(!box||!state.effective)return;
      const scopedGroup=state.scope>=0?state.config.session_groups[state.scope]:null;
      if(scopedGroup&&!state.saved.session_groups.some(g=>g.agenda_id===scopedGroup.agenda_id)){
        box.replaceChildren(el('h2',t("pages.console.ui.s413c499e83")),el('p',t("pages.console.ui.s31460c914d"),'muted'));return;
      }
      const focus=document.activeElement,focusAt=box.contains(focus)?focus?.dataset?.at:null,focusedSelect=focus?.id==='schedule-session';
      box.replaceChildren(el('h2',t("pages.console.ui.s3554abdd76")));const cfg=(state.liveEffective||state.effective).routine;
      try{
        const sleep=ranges(cfg.sleep_hours),active=ranges(cfg.active_hours),inside=(items,m)=>items.some(([a,b])=>a===b||(a<b?m>=a&&m<b:m>=a||m<b)),kind=m=>inside(sleep,m)?'sleep':inside(active,m)?'active':'normal';
        const boundaries=[...new Set([0,1440,...sleep.flat(),...active.flat()])].sort((a,b)=>a-b),segments=[];
        for(let i=0;i<boundaries.length-1;i++){const start=boundaries[i],end=boundaries[i+1],status=kind(start),last=segments.at(-1);if(last?.status===status)last.end=end;else segments.push({start,end,status});}
        const names={sleep:t("pages.console.ui.sca5f735b70"),normal:t("pages.console.ui.sa664edb23e"),active:t("pages.console.ui.s902bc6cfb2")},axis=el('div',undefined,'schedule-axis'),labels=el('div',undefined,'schedule-boundaries');
        const labelPoints=[...segments.map(s=>s.start),1440],lastByRow=[],width=Math.max(180,box.clientWidth-24),labelWidth=38;
        labelPoints.forEach(m=>{const percent=m/1440*100,x=percent/100*width,left=m===0?0:m===1440?width-labelWidth:x-labelWidth/2;let row=lastByRow.findIndex(end=>left>=end+6);if(row<0)row=lastByRow.length;lastByRow[row]=left+labelWidth;const label=el('span',format(m));label.style.left=percent+'%';label.style.top=row*19+'px';label.dataset.edge=m===0?'start':m===1440?'end':'middle';labels.append(label);});
        labels.style.height=(Math.max(...[...labels.children].map(n=>parseInt(n.style.top)),0)+22)+'px';axis.append(labels);
        const track=el('div',undefined,'schedule-track'),bar=el('div',undefined,'timebar');segments.forEach(s=>{const segment=el('span',undefined,s.status);segment.style.flex=String(s.end-s.start);segment.title=format(s.start)+'～'+format(s.end)+' '+names[s.status];segment.setAttribute('aria-label',segment.title);bar.append(segment);});track.append(bar);
        const options=sessions(),newScope=state.scope<0?'global':state.config.session_groups[state.scope]?.agenda_id||'draft';
        if(newScope!==scopeKey){scopeKey=newScope;selectedSid='';}if(!options.some(s=>s.sid===selectedSid))selectedSid=options[0]?.sid||'';
        const selected=options.find(s=>s.sid===selectedSid),toolbar=el('div',undefined,'schedule-plan-toolbar');
        if(options.length){const label=el('label',t("pages.console.ui.s3687c411a3")),select=el('select');select.id='schedule-session';select.setAttribute('aria-label',t("pages.console.ui.s60b205e543"));options.forEach(s=>select.add(new Option(S(s.sid),s.sid)));select.value=selectedSid;select.title=S(selectedSid);select.onchange=()=>{selectedSid=select.value;selectedAt='';render();refreshStatus().catch(fail);};label.append(select);toolbar.append(label);}
        const now=current(),today=moment(now).day;renderedDate=today;
        const slots=(selected?.schedule||[]).filter(row=>moment(new Date(row.at)).day===today);
        const explanation=el('p',t("pages.console.ui.sc5edc88895"),'schedule-slot-detail');explanation.id='schedule-slot-detail';explanation.setAttribute('aria-live','polite');
        slots.forEach(row=>{const date=new Date(row.at),point=moment(date),marker=el('button',undefined,'schedule-slot');marker.type='button';marker.dataset.at=String(date.getTime());marker.dataset.status=row.status;marker.style.left=point.minute/1440*100+'%';const text=format(point.minute)+' · '+(statuses()[row.status]||row.status)+(row.reason?' · '+ST(row.reason):'');marker.title=text+'\n'+S(selected.sid);marker.setAttribute('aria-label',marker.title);marker.onclick=()=>{selectedAt=row.at;explanation.textContent=text;};if(selectedAt===row.at)explanation.textContent=text;track.append(marker);});
        const marker=el('div',undefined,'schedule-now');marker.id='schedule-now';marker.append(el('span',t("pages.console.ui.sa511e8442f")));track.append(marker);axis.append(track);
        toolbar.append(el('small',today+' · '+slots.length+t("pages.console.ui.sbabe8db6dc")));box.append(toolbar,axis);
        const legend=el('div',undefined,'schedule-legend');for(const [key,name] of Object.entries(names)){const item=el('span',name);item.className=key;legend.append(item);}legend.append(el('span',t("pages.console.ui.sf128aab730"),'planned'),el('small',t("pages.console.ui.sb9cb982e0f")+(clock?.timezone||cfg.timezone||t("pages.console.ui.s1f3bc94376"))));
        const footer=el('div',undefined,'schedule-footer'),action=el('div',undefined,'schedule-reallocation'),button=el('button',t("pages.console.ui.s873bf2d9e6")),hint=el('small');
        button.id='redistribute-proactive';button.onclick=redistribute;hint.id='redistribute-hint';button.setAttribute('aria-describedby',hint.id);hint.setAttribute('role','status');action.append(button,hint);footer.append(legend,action);box.append(footer);
        let note=!selected?t("pages.console.ui.sb10a594207"):!selected.proactive||!state.status?.enabled?t("pages.console.ui.sda449ee56f"):!slots.length?t("pages.console.ui.sb625a1d378"):t("pages.console.ui.s082f03f0d2");
        if(state.dirty)note+=t("pages.console.ui.s5c653ba65f");
        box.append(el('p',note,'muted'));if(slots.length)box.append(explanation);
        if(selected?.schedule_timezone&&selected.schedule_timezone!==clock?.timezone)box.append(el('small',t("pages.console.ui.s49c6e478e6")+selected.schedule_timezone+'。','muted'));
        updateClock();if(focusedSelect)document.getElementById('schedule-session')?.focus({preventScroll:true});else if(focusAt)box.querySelector('[data-at="'+focusAt+'"]')?.focus({preventScroll:true});
      }catch{box.append(el('p',t("pages.console.ui.s842c014367"),'warning'));}
    }
    return {setClock(value){clock=value;receivedAt=Date.now();},selectedSid(){const options=sessions();return options.find(s=>s.sid===selectedSid)?.sid||options[0]?.sid||'';},updateClock,render};
  }

  function notice(text, bad=false) {
    const restore=$('notice').textContent!==(text||'')?preserveView():null;
    $('notice').textContent=ST(text || ''); $('notice').hidden=!text; $('notice').classList.toggle('error',bad);
    restore?.();
  }
  function fail(error) {
    const message=R(error?.message||String(error));notice(message,true);
    if(!state.config){
      $('connection').textContent=t('pages.console.static.connection_failed');
      $('title').textContent=t('pages.console.static.startup_failed_title');
      $('content').replaceChildren(section(t('pages.console.static.startup_failed_title'),message),
        el('p',t('pages.console.static.startup_failed_help'),'empty'));
    }
  }
  async function api(name, body, params) {
    if(!bridge)throw new Error(t("pages.console.ui.s0d7df5a3ec"));
    const result=body===undefined ? await bridge.apiGet(name,params) : await bridge.apiPost(name,body);
    if(typeof result?.ok!=='boolean')throw new Error('“'+name+t("pages.console.ui.s3828b886d4"));
    if(!result.ok){const error=new Error(result.error || t("pages.console.ui.s0384c763b8")); error.details=result.data; throw error;}
    return result.data;
  }
  function persistPrefs(patch) {
    Object.assign(state.preferences,patch);
    prefsQueue=prefsQueue.then(()=>api('preferences',patch)).catch(error=>notice(t("pages.console.ui.sf0e52c2319")+error.message,true));
  }
  function applyTheme() {
    const mode=state.preferences.theme || 'auto';
    const effective=mode==='auto' ? (latestTheme?'dark':'light') : mode;
    const label=effective==='dark'?t("pages.console.ui.s30b2c979ac"):t("pages.console.ui.s80ec9e2b1b");
    document.documentElement.dataset.theme=effective;
    if(!window.ActiveMessageI18n.isLoaded())return;
    $('theme').textContent=mode==='auto'?t("pages.console.ui.s49d0847cfd")+label+'）':label;
    $('theme').title=t("pages.console.ui.s098bffb551")+({auto:t("pages.console.ui.s80ec9e2b1b"),light:t("pages.console.ui.s30b2c979ac"),dark:t("pages.console.ui.s1f3bc94376")}[mode]);
    $('theme').setAttribute('aria-label',t("pages.console.ui.s6e627ca7c8")+$('theme').textContent+'；'+$('theme').title);
  }
  $('theme').onclick=()=>{persistPrefs({theme:({auto:'light',light:'dark',dark:'auto'}[state.preferences.theme])||'auto'});applyTheme();};
  function busy(value) {
    if(value)dock.hide();
    state.busy=value; $('content').inert=value; $('nav').inert=value; $('scope').disabled=value;
    $('reload').disabled=value; $('language').disabled=value; $('save').disabled=value || !state.dirty;
    $('save').textContent=value?t("pages.console.ui.sce9fd54c50"):t("pages.console.ui.s2af288c513");
  }
  function refreshDirty() {
    const locations=changeTracker.compare(state.config,state.saved,state.schema);state.dirty=locations.length>0;
    $('dirty').hidden=!state.dirty;$('dirty-summary').hidden=!state.dirty;$('save').disabled=state.busy||!state.dirty;
    if(locations.length!==lastChangeLocations.length||locations.some((v,i)=>v!==lastChangeLocations[i])){
      const list=$('dirty-locations'),scroll=list.scrollLeft;list.replaceChildren(...locations.map(text=>el('li',text)));
      list.scrollLeft=scroll;$('dirty-count').textContent=locations.length+t("pages.console.ui.sffa9a85f79");lastChangeLocations=locations;
    }
  }
  function dirty() { state.previewSeq++;refreshDirty();previewSoon(); }
  function acceptAgenda(data){
    if(data.config_revision!==state.revision)throw new Error(t("pages.console.ui.s0be10f52f3"));
    const changed=state.agendaRevision!==data.revision;
    state.agendaRevision=data.revision;
    for(const target of [state.config,state.saved]){
      target.agenda.events=clone(data.events);
      for(const group of target.session_groups)group.agenda_exclusions=clone(data.exclusions[group.agenda_id]||[]);
    }
    return changed;
  }
  async function refreshAgenda(){
    if(state.busy||!state.config)return;
    const revision=state.agendaRevision;
    const data=await api('agenda_data');
    if(state.busy||revision!==state.agendaRevision)return;
    if(acceptAgenda(data)){state.previewSeq++;if(state.tab==='schedule')render();previewSoon();}
  }
  async function saveAgenda(patch,revision=state.agendaRevision){
    if(state.busy)throw new Error(t("pages.console.ui.s9d3f3cc516"));
    busy(true);state.previewSeq++;clearTimeout(previewTimer);
    try{
      const data=await api('agenda',{...patch,revision,config_revision:state.revision});
      acceptAgenda(data);render();notice(t("pages.console.ui.sef4d0adbfb"));
    }finally{busy(false);previewSoon();}
  }
  function changed(obj,key,value,redraw=false) { obj[key]=value;dirty();if(redraw)render(); }
  function section(title,hint) { const s=el('section',undefined,'section'),heading=el('h2',title);s.append(heading);if(hint)s.append(el('p',hint,'muted'));return s; }
  function defaultObject(fields) { const out={};for(const [key,meta] of Object.entries(fields))out[key]=meta.type==='object'?defaultObject(meta.items):clone(meta.default??null);return out; }
  function selectTab(tab,persist=true) {
    if(!tabs().some(t=>t[0]===tab))return;
    state.tab=tab;state.traceSeq++;state.previewSeq++;notice('');render(false);window.scrollTo(0,0);if(tab==='schedule')refreshStatus().catch(fail);if(persist)persistPrefs({tab});
  }
  function nav() {
    $('nav').replaceChildren();
    tabs().forEach(([key,label])=>{const b=el('button',label);b.id='nav-'+key;b.setAttribute('aria-current',state.tab===key?'page':'false');b.onclick=()=>selectTab(key);$('nav').append(b);});
  }
  function scopeOptions() {
    const select=$('scope');select.replaceChildren(new Option(t("pages.console.ui.sc3d367e416"),'-1'));
    state.config.session_groups.forEach((g,i)=>select.add(new Option((i+1)+'. '+(g.group_name||t("pages.console.ui.sd82edc4765")),String(i))));
    if(state.scope>=state.config.session_groups.length)state.scope=-1;
    select.value=String(state.scope);
    $('scope-note').textContent=state.scope<0?t("pages.console.ui.s556b2d8aae"):t("pages.console.ui.s6a4f3a59b1");
    $('scope-note').title=$('scope-note').textContent;
    select.title=select.selectedOptions[0]?.textContent||'';
    $('scope-effective').textContent='';
    $('scope-bar').classList.toggle('group-scope',state.scope>=0);
  }
  $('scope').onchange=()=>{state.scope=Number($('scope').value);state.calendarSid='';state.effective=null;state.previewSeq++;render();if(state.tab==='schedule')refreshStatus().catch(fail);};
  function phaseFor(path) {
    if(path.includes('decision')&&['prompt','jev_state_template'].includes(path.at(-1)))return 'decision';
    if(path.includes('proactive_chat')&&['prompts','task_prompt'].includes(path.at(-1)))return 'proactive';
    return null;
  }
  function bindTemplate(input,phase,label) {
    if(!phase)return;
    input.dataset.templatePhase=phase;
    input.addEventListener('focus',()=>{state.templateFocus={input,phase,label};updatePlaceholderTarget();dock.show(input,phase,label);});
    input.addEventListener('click',()=>dock.show(input,phase,label));
  }
  function inlineHint(path,hint,inherit=false) {
    const key=path.at(-1),critical={
      enabled:t("pages.console.ui.s324bc09ab2"),
      threshold:t("pages.console.ui.s12361d30bc"),
      decision_mode:t("pages.console.ui.sb084e2f7af"),
      provider_id:t("pages.console.ui.s01d3a4c455"),
      daily_limit:t("pages.console.ui.sd4607e33e6"),
      timezone:t("pages.console.ui.s9828d2f27f"),
      sleep_hours:t("pages.console.ui.s458881e74e"),
      active_hours:t("pages.console.ui.sf6421bc63c"),
      history_messages:t("pages.console.ui.se0534d9316"),
      proactive_timeout_seconds:t("pages.console.ui.sfaed2cb69f"),
      agenda_mode:t("pages.console.ui.scc15532005"),
      preview_days:t("pages.console.ui.sdd78be7885"),
      max_items:t("pages.console.ui.s274042be07"),
      agenda_preview_days:t("pages.console.ui.s7c552e3b5d"),
      agenda_max_items:t("pages.console.ui.sae4b438099"),
      outside_scope:t("pages.console.ui.s7431ecb074"),
      allow_global_management:t("pages.console.ui.s911de6acea"),
      background_description:t("pages.console.ui.s5a2c54f96a"),
      repeat:t("pages.console.ui.sfe0b615664"),
      time_mode:t("pages.console.ui.sf8820c0c57"),
      pause_interjection:t("pages.console.ui.s15cc1e1f62"),
      pause_proactive:t("pages.console.ui.s928bc560ba")
    };
    if(inherit&&path[0]==='agenda'&&['preview_days','max_items'].includes(key))return critical['agenda_'+key];
    if(!critical[key])return '';
    return inherit?t("pages.console.ui.s865857a885")+critical[key].replace(/^本组留空跟随全局；/,'') : critical[key];
  }
  function field(key,meta,obj,path,inherit=false) {
    if(meta.type==='object') {
      obj[key]??={};const box=el('details',undefined,'form-section');box.dataset.viewKey='section:'+path.join('.');box.open=true;const heading=el('summary',meta.description||key);if(meta.hint)heading.append(help(meta.description||key,meta.hint));box.append(heading);
      const fields=el('div',undefined,'form-fields');appendFields(fields,obj[key],meta.items,path,inherit);box.append(fields);return box;
    }
    const row=el('div',undefined,'field');row.dataset.path=path.join('.');
    const labelBox=el('div',undefined,'field-label'),ctl=el('div',undefined,'control');
    const id='field-'+(++fieldId),label=el('label',meta.description||key);label.htmlFor=id;labelBox.append(label);
    if(meta.hint){labelBox.append(help(meta.description||key,meta.hint,id+'-hint'));const inline=inlineHint(path,meta.hint,inherit);if(inline)labelBox.append(el('small',inline,'field-hint'));}
    const value=obj[key]??meta.default, phase=phaseFor(path);let input;
    if(phase)row.classList.add('template-field');
    if(phase||['text','list'].includes(meta.type)||['jev_endpoint','jev_api_key'].includes(key))row.classList.add('field-wide');
    if(meta.type==='bool')row.classList.add('toggle-field');
    if(meta.type==='list') {
      if(!Array.isArray(obj[key]))obj[key]=[];
      label.removeAttribute('for');label.id=id+'-label';
      const list=el('div',undefined,'list-control');list.setAttribute('role','group');list.setAttribute('aria-labelledby',label.id);
      function draw() {
        list.replaceChildren();
        obj[key].forEach((item,index)=>{
          const wrap=el('div',undefined,'list-item'+(key==='sids'?' session-id-item':'')),area=el('textarea');area.rows=phase?4:2;area.value=item;area.id=id+'-'+index;
          const names=key==='sids'?el('small',SR(item),'session-name-reference'):null;
          area.setAttribute('aria-label',(meta.description||key)+' '+(index+1));area.oninput=()=>{obj[key][index]=area.value;if(names)names.textContent=SR(area.value);dirty();};bindTemplate(area,phase,meta.description);
          const remove=el('button',t("pages.console.ui.s2f752c005e"));remove.onclick=()=>{const restore=preserveView();obj[key].splice(index,1);dirty();draw();restore();};wrap.append(area,remove);if(names)wrap.append(names);list.append(wrap);
        });
      }
      draw();const add=el('button',phase?t("pages.console.ui.se7f77f145c"):t("pages.console.ui.s113c10fb7f"));add.id=id;add.onclick=()=>{obj[key].push('');dirty();draw();[...list.querySelectorAll('textarea')].at(-1)?.focus();};ctl.append(list,add);
    } else if(meta.type==='bool') {
      input=el('input');input.type='checkbox';input.checked=Boolean(value);input.onchange=()=>changed(obj,key,input.checked,true);
      if(['enabled','interjection.enabled','proactive_chat.enabled','agenda.enabled'].includes(path.join('.'))){input.classList.add('capsule-switch');input.setAttribute('role','switch');}
    } else if(meta.options||meta._special==='select_provider') {
      input=el('select');const options=meta.options||['',...(state.providers||[]).map(p=>p.id)];
      const optionLabels={llm:t("pages.console.ui.s1e08a151dc"),jev:t("pages.console.ui.sa64d6cfd2e")};
      options.forEach((option,index)=>input.add(new Option(option===''?(inherit?t("pages.console.ui.s405dfd8dbe"):t("pages.console.ui.s382f4b5559")):(meta.labels?.[index]||optionLabels[option]||V(option)),option)));
      if(value&&!options.includes(value))input.add(new Option(String(value)+t("pages.console.ui.s89a4c2d564"),value));input.value=value??'';
      input.onchange=()=>changed(obj,key,input.value,true);
    } else {
      input=el(meta.type==='text'?'textarea':'input');input.value=value??'';if(phase)input.rows=5;
      if(meta.secret) {
        input.type='password';input.autocomplete='new-password';input.value=value==='__ACTIVE_MESSAGE_KEEP_SECRET__'?'':(value||'');
        input.placeholder=value==='__ACTIVE_MESSAGE_KEEP_SECRET__'?t("pages.console.ui.sa842312440"):t("pages.console.ui.sd60dbdd863");
        input.oninput=()=>changed(obj,key,input.value||(value==='__ACTIVE_MESSAGE_KEEP_SECRET__'?value:''));
        const clear=el('button',t("pages.console.ui.sb3627265cc"),'danger');clear.onclick=async()=>{if(await dialog({title:t("pages.console.ui.s0b7e0dd6e7"),message:t("pages.console.ui.s146aa66b47"),confirm:t("pages.console.ui.s84fcd70d42"),danger:true})){obj[key]='';input.value='';input.placeholder=t("pages.console.ui.sd6c2fdafe8");dirty();}};ctl.append(clear);
      } else {
        if(['int','float'].includes(meta.type)){input.type='number';input.step=meta.type==='int'?'1':'any';}
        if(key==='proactive_timeout_seconds'){input.inputMode='numeric';input.placeholder=t("pages.console.ui.s187c7323e4");}
        if(['preview_days','agenda_preview_days'].includes(key))input.placeholder=t(key==='agenda_preview_days'?'pages.console.ui.preview_days_group_placeholder':'pages.console.ui.preview_days_placeholder');
        if(['max_items','agenda_max_items'].includes(key))input.placeholder=t(key==='agenda_max_items'?'pages.console.ui.s5fc1a82434':'pages.console.ui.s0c9b70b61e');
        input.oninput=()=>changed(obj,key,['int','float'].includes(meta.type)?(input.value===''?'':Number(input.value)):input.value);
        bindTemplate(input,phase,meta.description);
      }
    }
    if(input){input.id=id;input.setAttribute('aria-label',meta.description||key);if(meta.hint)input.setAttribute('aria-describedby',id+'-hint');ctl.prepend(input);}
    if(inherit&&!meta.secret){
      const hint=el('div',undefined,'effective');hint.dataset.path=JSON.stringify(path);hint._obj=obj;hint._key=key;
      const badge=el('span',undefined,'override-badge'),valueText=el('span',undefined,'effective-value'),reset=el('button',t("pages.console.ui.se4cff5c0d2"),'inherit-reset');
      reset.onclick=()=>{obj[key]=clone(meta.default??'');dirty();render();};hint.append(badge,valueText,reset);ctl.append(hint);
    }
    row.append(labelBox,ctl);return row;
  }
  function appendFields(box,obj,fields,prefix=[],inherit=false) { for(const [key,meta] of Object.entries(fields))if(!meta.invisible)box.append(field(key,meta,obj,[...prefix,key],inherit)); }
  function briefValue(value,agendaKey=''){
    if(value===undefined)return t("pages.console.ui.s7011734430");
    if(agendaKey&&blank(value))return t(agendaKey==='preview_days'?'pages.console.ui.s21c91b0dc6':'pages.console.ui.s09c4fc252c');
    if(typeof value==='boolean')return value?t("pages.console.ui.s256783b7d4"):t("pages.console.ui.s6c14bd7f6f");
    if(Array.isArray(value))return value.length+t("pages.console.ui.s12de8e1252");
    const text=String(value??'');return text.length>90?text.slice(0,90)+'…':(text||t("pages.console.ui.s82ca4a6ba6"));
  }
  function effectiveHints() {
    let count=0;
    document.querySelectorAll('.effective').forEach(n=>{
      const path=JSON.parse(n.dataset.path),value=n._obj[n._key],agendaNumber=['agenda_preview_days','agenda_max_items'].includes(n._key),inherited=typeof value==='string'&&['跟随全局','inherit'].includes(value.trim()),overridden=agendaNumber?!inherited:!blank(value)&&!inherited;
      const globalValue=get(state.config,path),effective=get(state.effective,path),same=JSON.stringify(globalValue)===JSON.stringify(effective);
      n.closest('.field').classList.toggle('overridden',overridden);if(overridden)count++;
      n.querySelector('.override-badge').textContent=overridden?(same?t("pages.console.ui.s98226981e8"):t("pages.console.ui.s8f2d0f688c")):t("pages.console.ui.s405dfd8dbe");
      const agendaKey=agendaNumber?path.at(-1):'',text=n.querySelector('.effective-value');text.textContent=(overridden?t("pages.console.ui.s73cfe84d32")+briefValue(globalValue,agendaKey)+' → ':'')+t("pages.console.ui.sd3364006eb")+briefValue(effective,agendaKey);
      n.querySelector('.inherit-reset').hidden=!overridden;
    });
    const summary=$('override-count');if(summary)summary.textContent=t("pages.console.ui.sd64440dd44")+count+t("pages.console.ui.s12de8e1252");
    if(state.effective){
      const cfg=state.effective;
      $('scope-effective').textContent=(cfg.enabled?'':t("pages.console.ui.s0f2fcb6753"))+t("pages.console.ui.s22bcfb49c8")+(cfg.enabled&&cfg.interjection.enabled?t("pages.console.ui.s256783b7d4"):t("pages.console.ui.s6c14bd7f6f"))+t("pages.console.ui.sd3a345ce67")+(cfg.enabled&&cfg.proactive_chat.enabled?t("pages.console.ui.s256783b7d4"):t("pages.console.ui.s6c14bd7f6f"))+'。';
      $('scope-effective').title=$('scope-effective').textContent;
    }
  }
  function showValidation(errors,warnings=[]) {
    const box=$('validation');if(!box)return;box.replaceChildren();
    const entries=Object.entries(errors||{}).flatMap(([feature,rows])=>rows.map(([path,hint])=>({feature,path,hint})));
    document.querySelectorAll('.field').forEach(row=>{const invalid=entries.some(e=>e.path===row.dataset.path);row.classList.toggle('invalid',invalid);row.querySelectorAll('input,textarea,select').forEach(n=>n.setAttribute('aria-invalid',String(invalid)));});
    if(entries.length){box.append(el('h3',t("pages.console.ui.s55b583c2ae")));entries.forEach(e=>box.append(el('p',e.path+': '+ST(R(e.hint)))));}
    warnings.forEach(w=>box.append(el('p',ST(R(w.message)),'warning')));box.hidden=!entries.length&&!warnings.length;
  }
  function previewSoon() { clearTimeout(previewTimer);previewTimer=setTimeout(preview,250); }
  async function preview(injectionOnly=false) {
    if(!state.config||state.busy)return;
    const seq=++state.previewSeq,scope=state.scope;
    try {
      const result=await api('preview',{config:clone(state.config),group_index:scope,...(state.tab==='schedule'?(injectionOnly?{injection_only:true,injection_sid:agendaUI.previewParams().injection_sid}:{calendar_month:state.calendarMonth||'',calendar_sid:state.calendarSid||'',...agendaUI.previewParams()}):{})});
      if(seq!==state.previewSeq||scope!==state.scope)return;
      const restore=preserveView();
      state.effective=result.effective;state.liveEffective=result.live_effective||null;scheduleView.setClock(result.live_schedule_clock||result.schedule_clock);effectiveHints();showValidation(result.errors,result.warnings);drawScore();scheduleStrip();if(result.calendar)agendaUI.update(result.calendar,result.agenda_list,result.agenda_injection);
      else if(result.agenda_injection)agendaUI.updateInjection(result.agenda_injection);
      restore();
    } catch(error){if(seq===state.previewSeq)notice(t("pages.console.ui.s9091926ece")+error.message,true);}
  }
  function render(keepPosition=true) {
    if(!state.config)return;
    const scopeKey=state.tab+':'+state.scope,restore=keepPosition&&renderedScope===scopeKey?preserveView():null;
    renderedScope=scopeKey;
    hideHelp();dock.hide();fieldId=0;state.templateFocus=null;nav();scopeOptions();$('title').textContent=tabs().find(t=>t[0]===state.tab)[1];
    $('scope-bar').hidden=['overview','traces','groups'].includes(state.tab);refreshDirty();
    const root=$('content');root.dataset.view=scopeKey+':'+(++renderRevision);root.replaceChildren();root.classList.toggle('only-overrides',!!state.onlyOverrides&&state.scope>=0&&!['overview','traces','groups','schedule'].includes(state.tab));
    if(state.scope>=0&&!['overview','traces','groups','schedule'].includes(state.tab)){const bar=el('div',undefined,'override-summary'),count=el('strong'),toggle=el('button',state.onlyOverrides?t("pages.console.ui.sbdcd099bb9"):t("pages.console.ui.se88d3a1997"));count.id='override-count';toggle.onclick=()=>{state.onlyOverrides=!state.onlyOverrides;render();};bar.append(count,toggle);root.append(bar);}
    if(state.tab==='overview')renderOverview(root);else if(state.tab==='traces')renderTraces(root);else if(state.tab==='groups')renderGroups(root);else renderSettings(root);
    if(state.tab!=='traces'){const v=el('aside',undefined,'validation-summary');v.id='validation';v.hidden=true;root.append(v);}
    effectiveHints();if(state.tab!=='traces')previewSoon();
    restore?.();
  }
  function renderOverview(root) {
    const intro=section(t("pages.console.ui.s0cbdcb04cb"),t("pages.console.ui.scfde547c57"));intro.classList.add('intro');intro.id='overview-intro';
    const flow=el('div',undefined,'flow');[t("pages.console.ui.s98fcd3ca25"),t("pages.console.ui.sd5c384880f"),t("pages.console.ui.s497039e3c3"),t("pages.console.ui.s627ae535b3")].forEach(t=>flow.append(el('span',t)));intro.append(flow);
    const top=el('div',undefined,'overview-top'),control=el('section',undefined,'overview-switch');control.id='global-switch';control.setAttribute('aria-label',t("pages.console.ui.s4e7e00255a"));
    control.append(field('enabled',{...state.schema.enabled,hint:''},state.config,['enabled']),el('small',t("pages.console.ui.s93fc891811")));
    top.append(intro,control);root.append(top);
    if(!state.preferences.tutorial_seen){const welcome=section(t("pages.console.ui.sdf328733ac"),t("pages.console.ui.sec366f483b"));const b=el('button',t("pages.console.ui.s5ead3f184a"),'primary');b.onclick=startTour;welcome.append(b);root.append(welcome);}
    const d=state.status||{sessions:[],runs:[]};const box=section(t("pages.console.ui.sd9d43ed42d"),t("pages.console.ui.seb8700c51a"));
    if(d.scheduler){const scheduler=d.scheduler,notice=el('p',t('pages.console.static.'+(scheduler.error?'scheduler_failed':scheduler.stale?'scheduler_recovering':scheduler.running?'scheduler_ok':'scheduler_stopped')),scheduler.error?'warning':'muted');if(scheduler.error)notice.append(el('code',scheduler.error));box.append(notice);}
    const tools=el('div',undefined,'actions'),refresh=el('button',t("pages.console.ui.s7cc7f07a2c")),live=el('input');live.type='checkbox';live.checked=state.live;live.onchange=()=>{state.live=live.checked;persistPrefs({overview_live:state.live});};const label=el('label');label.append(live,document.createTextNode(t("pages.console.ui.seea28ea3ee")));refresh.onclick=()=>refreshStatus().catch(fail);tools.append(refresh,label);box.append(tools);
    if(!d.sessions.length)box.append(el('p',t("pages.console.ui.sb649a2abdd"),'empty'));
    else {
      const wrap=el('div',undefined,'scroll'),table=el('table'),head=el('tr');[t("pages.console.ui.sfb7bf39991"),t("pages.console.ui.s6ccdfcc780"),t("pages.console.ui.s198faa5f7c"),t("pages.console.ui.sc75c756a0b"),t("pages.console.ui.s1b917b7d22"),t("pages.console.ui.s40852947a8")].forEach(x=>head.append(el('th',x)));table.append(head);
      d.sessions.forEach(s=>{const row=el('tr'),sid=el('td',S(s.sid),'sid'),results=el('td',undefined,'session-results');sid.append(el('small',R(s.group)));
        for(const [key,name] of [['interjection',t("pages.console.ui.s5453160ded")],['proactive',t("pages.console.ui.s5e6f228dbe")]]){const result=s.results?.[key],line=el('div');line.append(el('strong',name+'：'),el('span',result?window.ActiveMessageI18n.runtime(result.status):t("pages.console.ui.s4265af54b8")));if(result){line.title=new Date(result.finished_at*1000).toLocaleString(window.ActiveMessageI18n.getLocale());line.classList.toggle('warning',result.error);const view=el('button',t("pages.console.ui.sf7acefd2d4"),'result-link');view.onclick=async()=>{try{selectTab('traces');state.run=await api('trace',undefined,{run_id:result.run_id});state.step=Math.max(0,state.run.steps.length-1);drawTrace();}catch(error){fail(error);}};line.append(view);}results.append(line);}
        const modes=el('td',(s.interjection?t("pages.console.ui.sb4217093bc"):t("pages.console.ui.sa3332f1c94"))+' / '+(s.proactive?t("pages.console.ui.sb4217093bc"):t("pages.console.ui.sa3332f1c94")));if(s.agent_active)modes.append(el('small',t('pages.console.static.agent_busy')));row.append(sid,modes,el('td',s.cooldown_remaining+t("pages.console.ui.sd9ad5055c3")),el('td',s.daily_sent+' / '+s.daily_limit),el('td',s.next_run?new Date(s.next_run).toLocaleString(window.ActiveMessageI18n.getLocale()):t("pages.console.ui.s0bf49114ad")),results);table.append(row);});wrap.append(table);box.append(wrap);
    }
    root.append(box);
    if(d.unresolved?.length)root.append(section(t("pages.console.ui.scc9b822038"),d.unresolved.join('、')+t("pages.console.ui.s194ac7f3a7"),false));
    for(const w of d.warnings||[])root.append(section(t("pages.console.ui.s17c2fa1cae"),ST(R(w.message)),false));
    if(d.errors&&Object.keys(d.errors).length){const b=section(t("pages.console.ui.s58bdf12ac1"));b.append(el('pre',ST(JSON.stringify(d.errors,null,2))));root.append(b);}
  }
  function moveGroup(from,to){
    const groups=state.config.session_groups;if(from<0||to<0||from>=groups.length||to>=groups.length||from===to)return;
    const scrollPosition={left:window.scrollX,top:window.scrollY};
    const selected=state.scope>=0?groups[state.scope]:null;const [item]=groups.splice(from,1);groups.splice(to,0,item);
    state.scope=selected?groups.indexOf(selected):-1;draggedGroup=null;dirty();render(false);notice(t("pages.console.ui.s2dac6c5792"));
    const grid=$('content').querySelector('.group-grid');
    // Header/notice height and rebuilt cards must not move the document after a drop.
    // Capture at drop time, not drag start, so intentional drag auto-scrolling is retained.
    window.scrollTo({...scrollPosition,behavior:'instant'});
    requestAnimationFrame(()=>{
      if(state.tab==='groups'&&grid?.isConnected&&!document.querySelector('.shell').inert)
        window.scrollTo({...scrollPosition,behavior:'instant'});
    });
  }
  function renderGroups(root) {
    const intro=section(t("pages.console.ui.s0a7b15a204"),t("pages.console.ui.s77c1a6acd9"));intro.id='groups-intro';root.append(intro);
    intro.append(el('small',t("pages.console.ui.s2b4e3b4e6e"),'muted'));
    const fields=state.schema.session_groups.templates.group.items,grid=el('div',undefined,'group-grid');root.append(grid);
    state.config.session_groups.forEach((group,index)=>{
      const box=section((index+1)+'. '+(group.group_name||t("pages.console.ui.sd82edc4765"))),head=el('div',undefined,'actions'),heading=el('div',undefined,'group-card-heading');box.classList.add('group-card');box.dataset.groupIndex=String(index);heading.append(box.querySelector('h2'));box.append(heading);
      const handle=el('button',t("pages.console.ui.sc042cbe326"),'drag-handle');handle.draggable=true;handle.setAttribute('aria-label',t("pages.console.ui.sfab7736597")+(group.group_name||t("pages.console.ui.sd82edc4765")));
      handle.ondragstart=e=>{draggedGroup=group;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(index));box.classList.add('dragging');};
      handle.ondragend=()=>{draggedGroup=null;document.querySelectorAll('.dragging,.drop-target').forEach(n=>n.classList.remove('dragging','drop-target'));};
      box.ondragover=e=>{if(draggedGroup&&draggedGroup!==group){e.preventDefault();e.dataTransfer.dropEffect='move';box.classList.add('drop-target');}};
      box.ondragleave=e=>{if(!box.contains(e.relatedTarget))box.classList.remove('drop-target');};
      box.ondrop=e=>{e.preventDefault();if(draggedGroup)moveGroup(state.config.session_groups.indexOf(draggedGroup),index);};
      const up=el('button',t("pages.console.ui.sa53a7037dc")),down=el('button',t("pages.console.ui.sfb5f58d7e6"));up.disabled=index===0;down.disabled=index===state.config.session_groups.length-1;
      up.onclick=()=>moveGroup(index,index-1);down.onclick=()=>moveGroup(index,index+1);head.append(handle,up,down);
      const edit=el('button',t("pages.console.ui.s1c52f2a9a9"));edit.onclick=()=>{state.scope=index;state.effective=null;selectTab('interjection');};
      const remove=el('button',t("pages.console.ui.s6b7fc03552"),'danger');remove.onclick=async()=>{if(await dialog({title:t("pages.console.ui.s735a040a0b"),message:t("pages.console.ui.sadeb396138"),confirm:t("pages.console.ui.s6b7fc03552"),danger:true})){state.config.session_groups.splice(index,1);state.scope=-1;dirty();render();}};head.append(edit,remove);heading.append(head);
      const fieldsBox=el('div',undefined,'group-fields');appendFields(fieldsBox,group,Object.fromEntries(['group_name','sids','interjection_mode','proactive_mode','cooldown_override'].map(k=>[k,fields[k]])));box.append(fieldsBox);
      const choices=[[t("pages.console.ui.s5453160ded"),group.interjection_mode],[t("pages.console.ui.s5e6f228dbe"),group.proactive_mode]],summary=el('div',undefined,'group-choice-summary');
      for(const [name,value] of choices){const badge=el('span',name+'：'+({inherit:t("pages.console.ui.s405dfd8dbe"),enabled:t("pages.console.ui.s256783b7d4"),disabled:t("pages.console.ui.s6c14bd7f6f")}[value]||value),value==='inherit'?'tag':'override-badge');summary.append(badge);}box.append(summary);
      if(!blank(group.cooldown_override))box.append(el('small',t("pages.console.ui.saa36643992")+group.cooldown_override+t("pages.console.ui.sd9ad5055c3"),'override-badge'));
      if(!group.sids.some(s=>String(s).trim()))box.append(el('p',t("pages.console.ui.s1b3094d89a"),'warning'));grid.append(box);
    });
    const add=el('button',t("pages.console.ui.sdc92016407"),'primary');add.id='add-group';add.onclick=()=>{state.config.session_groups.push({...defaultObject(fields),__template_key:'group'});dirty();render();};root.append(add);
  }
  function renderSettings(root) {
    const group=state.scope>=0?state.config.session_groups[state.scope]:null,gs=state.schema.session_groups.templates.group.items;
    if(state.tab==='interjection') {
      const box=section(t("pages.console.ui.s5453160ded"),t("pages.console.ui.s8fdaad3e8d"));box.id='feature-settings';root.append(box);
      const model=section(t("pages.console.ui.s40d96917a9"),t("pages.console.ui.see9147262f"));model.id='judgment-settings';root.append(model);
      const rules=section(t("pages.console.ui.s3eec3e8a28"),t("pages.console.ui.s7f8305a520"));rules.id='scoring-settings';root.append(rules);
      if(group) {
        box.append(field('interjection_mode',gs.interjection_mode,group,['interjection','enabled'],true));
        rules.append(field('threshold_override',gs.threshold_override,group,['interjection','threshold'],true));
        model.append(field('decision_mode',gs.decision_mode,group,['interjection','decision','mode'],true));
        model.append(el('p',t("pages.console.ui.s794c08e40b"),'muted'));
        appendFields(model,group.decision_overrides,gs.decision_overrides.items,['interjection','decision'],true);
        for(const [key,meta] of Object.entries(gs.interjection_overrides.items))rules.append(field(key,meta,group.interjection_overrides,['interjection',key],true));
        for(const key of ['weights','activity','energy']){const b=section(gs['interjection_'+key].description);appendFields(b,group['interjection_'+key],gs['interjection_'+key].items,['interjection',key],true);rules.append(b);}
      } else {
        box.append(field('enabled',state.schema.interjection.items.enabled,state.config.interjection,['interjection','enabled']));
        const metas=state.schema.interjection.items.decision.items;
        const order=['mode','provider_id','timeout_seconds','retry_attempts','retry_delay_seconds','jev_model','jev_endpoint','jev_api_key','prompt','jev_state_template'];
        const keys=[...order.filter(k=>metas[k]),...Object.keys(metas).filter(k=>!order.includes(k))];
        appendFields(model,state.config.interjection.decision,Object.fromEntries(keys.map(k=>[k,metas[k]])),['interjection','decision']);
        appendFields(rules,state.config.interjection,Object.fromEntries(Object.entries(state.schema.interjection.items).filter(([k])=>!['enabled','decision'].includes(k))),['interjection']);
      }
      renderScore(root);
      renderPlaceholders(root,['decision']);
    } else if(['proactive','schedule'].includes(state.tab)) {
      const isSchedule=state.tab==='schedule',configKey=isSchedule?'routine':'proactive_chat',groupKey=isSchedule?'routine_overrides':'proactive_overrides';
      const box=section(isSchedule?t("pages.console.ui.s82ced76822"):t("pages.console.ui.s5e6f228dbe"),isSchedule?t("pages.console.ui.s53a2651bb8"):t("pages.console.ui.s39044d7217"));box.id='feature-settings';root.append(box);
      if(group&&!isSchedule)box.append(field('proactive_mode',gs.proactive_mode,group,['proactive_chat','enabled'],true));
      const obj=group?group[groupKey]:state.config[configKey],metas=group?gs[groupKey].items:state.schema[configKey].items;
      appendFields(box,obj,metas,[configKey],!!group);
      if(!isSchedule){
        const link=el('div',undefined,'actions'),jump=el('button',t('pages.console.ui.shared_cooldown_jump'));jump.type='button';
        jump.onclick=()=>{
          const groupIndex=state.scope;selectTab(groupIndex<0?'interjection':'groups');
          const selector=groupIndex<0?'.field[data-path="interjection.cooldown_seconds"] input':`.group-card[data-group-index="${groupIndex}"] .field[data-path="cooldown_override"] input`;
          const input=$('content').querySelector(selector);input?.focus({preventScroll:true});input?.closest('.field').scrollIntoView({block:'center'});
        };
        link.append(el('small',t('pages.console.ui.shared_cooldown_note')),jump);
        box.querySelector('.field[data-path="proactive_chat.daily_limit"]').after(link);
      }
      if(isSchedule){const strip=section(t("pages.console.ui.s413c499e83"));strip.id='schedule-preview';root.append(strip);scheduleStrip();agendaUI.render(root,group);}else renderPlaceholders(root,['proactive']);
    } else {
      const box=section(t("pages.console.ui.s2c0396b4b4"),t("pages.console.ui.s90cc3f488d"));box.id='context-settings';root.append(box);
      box.append(el('p',t("pages.console.ui.sc7a1fecf29"),'muted'));
      appendFields(box,group?group.context_overrides:state.config.context,group?gs.context_overrides.items:state.schema.context.items,['context'],!!group);
      if(!group){const diag=section(t("pages.console.ui.s9e3a29f2f6"),t("pages.console.ui.sab339e4743"));appendFields(diag,state.config.diagnostics,state.schema.diagnostics.items,['diagnostics']);root.append(diag);const resources=section(t("pages.console.ui.s2228cf92fd"),t("pages.console.ui.s1cc75682a4"));appendFields(resources,state.config.runtime,state.schema.runtime.items,['runtime']);root.append(resources);}
    }
    root.querySelectorAll('.section,.form-fields').forEach(box=>{
      if(box.querySelector(':scope > .field'))box.classList.add('settings-grid');
    });
  }
  function renderScore(root) {
    const box=section(t("pages.console.ui.s9c36d20a0b"),t("pages.console.ui.s1c6bbd765f"));box.id='score-lab';
    const tools=el('div',undefined,'score-toolbar'),note=el('small');note.id='score-weight-note';
    const reset=el('button',t("pages.console.ui.sc80dceb4f8"));reset.id='score-reset';reset.onclick=()=>{state.scoreCustom=false;drawScore();};tools.append(note,reset);box.append(tools);
    const sliders=el('div',undefined,'score-sliders');
    for(const [key,label] of [['model',t("pages.console.ui.s5d2ddbab55")],['activity',t("pages.console.ui.sb1028136ce")],['energy',t("pages.console.ui.s734058d1fb")]]){
      const card=el('div',undefined,'score-card'),wrap=el('label'),caption=el('span',label),input=el('input'),output=el('output',String(state.samples[key]));input.type='range';input.min=0;input.max=1;input.step=.01;input.value=state.samples[key];input.setAttribute('aria-label',t("pages.console.ui.s959ab3bcab")+label);
      input.oninput=()=>{state.samples[key]=Number(input.value);output.textContent=input.value;drawScore();};wrap.append(caption,output,input);
      const weightLabel=el('label',undefined,'score-weight'),weight=el('input');weight.id='score-weight-'+key;weight.type='number';weight.step='any';weight.setAttribute('aria-label',label+t("pages.console.ui.s8cf6626e96"));weight.placeholder=t("pages.console.ui.se26f61e174");
      weight.oninput=()=>{state.scoreCustom=true;state.scoreWeights??={};state.scoreWeights[key]=weight.value;drawScore();};weightLabel.append(el('span',t("pages.console.ui.s8cf6626e96")),weight);card.append(wrap,weightLabel);sliders.append(card);
    }
    const result=el('div');result.id='score-result';box.append(sliders,result);root.append(box);drawScore();
  }
  function displayScore(score,threshold) {
    const value=Math.abs(score-threshold)<=1e-12?threshold:score,rounded=value.toFixed(4);
    // Show more digits only when rounding would contradict the comparison sign.
    return (Number(rounded)>threshold)===(value>threshold)?rounded:String(value);
  }
  function drawScore() {
    const box=$('score-result');if(!box)return;box.replaceChildren();const cfg=state.effective?.interjection;
    $('score-reset').disabled=!cfg;
    if(!cfg){box.append(el('p',t("pages.console.ui.s099decb1c5")));return;}
    const scope=state.scope<0?state.config:state.config.session_groups[state.scope];
    if(state.scoreScope!==scope){state.scoreScope=scope;state.scoreCustom=false;}
    if(!state.scoreCustom)state.scoreWeights={...cfg.weights};
    const weights=state.scoreWeights;
    for(const key of ['model','activity','energy']){const input=$('score-weight-'+key);if(document.activeElement!==input)input.value=weights[key]??'';}
    $('score-weight-note').textContent=state.scoreCustom?t("pages.console.ui.s8bcb06116e"):t("pages.console.ui.s730b717376");
    if(['model','activity','energy'].some(key=>String(weights[key]??'').trim()===''||!Number.isFinite(Number(weights[key])))){box.append(el('p',t("pages.console.ui.s676312fe81"),'warning'));return;}
    const denom=Object.values(weights).reduce((a,b)=>a+Math.abs(Number(b)),0);
    if(!denom||!Number.isFinite(denom)){box.append(el('p',t("pages.console.ui.saadedfd1c0"),'warning'));return;}
    let score=0;const table=el('table'),head=el('tr');table.className='score-table';[t("pages.console.ui.se2fece1e46"),t("pages.console.ui.sf7e91f57f1"),t("pages.console.ui.s8cf6626e96"),t("pages.console.ui.sc310676744")].forEach(x=>head.append(el('th',x)));table.append(head);
    for(const [key,label] of [['model',t("pages.console.ui.s98fd0cbd9c")],['activity',t("pages.console.ui.s8c0daf7f81")],['energy',t("pages.console.ui.s3bc40569b4")]]){const w=Number(weights[key]),raw=state.samples[key],weighted=Math.abs(w)*(w<0?1-raw:raw);score+=weighted;const tr=el('tr');[label,raw,w,(weighted/denom).toFixed(4)].forEach(x=>tr.append(el('td',String(x))));table.append(tr);}
    score=Math.max(0,Math.min(1,score/denom));
    const threshold=Number(cfg.threshold),hit=score>threshold&&Math.abs(score-threshold)>1e-12;
    const displayed=displayScore(score,threshold);
    const result=el('p',t("pages.console.ui.sb448909ba9")+displayed+(hit?' > ':' ≤ ')+t("pages.console.ui.s83fb0085ca")+cfg.threshold+'：'+(hit?t("pages.console.ui.sc988be8e99"):t("pages.console.ui.se149d965f1")),'score-outcome');
    result.classList.toggle('pass',hit);box.append(table,result,el('small',t("pages.console.ui.sace5de5932"),'muted'));
  }
  const phaseLabels=()=>({decision:t("pages.console.ui.s8ddbcd1ba4"),proactive:t("pages.console.ui.s65884b86b6")});
  function renderPlaceholders(root,phases) {
    const box=section(t("pages.console.ui.s5c1c0d296a"),t("pages.console.ui.sd7a762218e"));box.id='placeholder-panel';
    const target=el('span',t("pages.console.ui.se51dc10ae9"));target.id='placeholder-target';box.querySelector('p.muted').append(document.createTextNode(' '),target);
    const search=el('input');search.type='search';search.placeholder=t("pages.console.ui.sed0d939310");search.setAttribute('aria-label',t("pages.console.ui.s12570cb22d"));const list=el('div',undefined,'placeholder-grid');
    function draw(){list.replaceChildren();const q=search.value.trim().toLowerCase();const rows=state.placeholders.filter(p=>p.phases.some(x=>phases.includes(x))&&(!q||(p.name+p.description).toLowerCase().includes(q)));
      for(const p of rows){const card=el('article',undefined,'placeholder-card');const heading=el('div',undefined,'placeholder-heading');heading.append(el('code',p.token),help(p.name||p.token,t("pages.console.ui.sad2bc2f682")+p.example));card.append(heading,el('p',p.description));const allowed=p.phases.filter(x=>phases.includes(x));card.append(el('small',t("pages.console.ui.s531f9f37a3")+allowed.map(x=>phaseLabels()[x]).join('；'),'allowed-phases'));
        const actions=el('div',undefined,'actions'),copy=el('button',t("pages.console.ui.s4edd1d0087")),insert=el('button',t("pages.console.ui.s022bf3283d"));copy.setAttribute('aria-label',t("pages.console.ui.sc844fa567d")+p.token);copy.onclick=()=>copyText(p.token,notice);
        insert.dataset.insertPhases=JSON.stringify(p.phases);insert.setAttribute('aria-label',t("pages.console.ui.s1f21e94af2")+p.token);insert.disabled=true;insert.onclick=()=>{const f=state.templateFocus;if(!f||!f.input.isConnected||!p.phases.includes(f.phase))return;f.input.setRangeText(p.token,f.input.selectionStart??f.input.value.length,f.input.selectionEnd??f.input.value.length,'end');f.input.dispatchEvent(new Event('input',{bubbles:true}));f.input.focus();notice(t("pages.console.ui.s7d3408fba6")+p.token+t("pages.console.ui.s81163075af"));};actions.append(copy,insert);card.append(actions);list.append(card);}
      if(!rows.length)list.append(el('p',t("pages.console.ui.s6ad96b9189")));updatePlaceholderTarget();}
    search.oninput=draw;box.append(search,list);root.append(box);draw();
  }
  function updatePlaceholderTarget(){const target=$('placeholder-target'),f=state.templateFocus;if(target)target.textContent=f?t("pages.console.ui.sebdaa723b5")+f.label+t("pages.console.ui.s56de6dca39"):t("pages.console.ui.s6d31c58e37");document.querySelectorAll('[data-insert-phases]').forEach(n=>n.disabled=!f||!f.input.isConnected||!JSON.parse(n.dataset.insertPhases).includes(f.phase));}
  function scheduleStrip() { scheduleView.render(); }
  function renderTraces(root) { traceBrowser.render(root); }
  function drawTrace() {
    const steps=$('trace-steps'),detail=$('trace-detail');if(!steps||!detail)return;const scroll={steps:steps.scrollTop,detail:detail.scrollTop};const focusedStep=steps.contains(document.activeElement);steps.replaceChildren();
    if(!state.run){detail.replaceChildren(el('p',t("pages.console.ui.s2f054f1a06"),'empty'));delete detail.dataset.stepKey;return;}
    const progress=state.run.progress;
    if(progress){const phase=el('strong'),wait=el('p',undefined,'muted');phase.id='trace-phase';wait.id='trace-wait';steps.append(phase,wait);updateTraceProgress();}
    if(state.run.history_omitted)steps.append(el('small',t("pages.console.ui.s2660c1fb31"),'muted'));
    if(state.run.steps_omitted)steps.append(el('small',t("pages.console.ui.sf5b0f14662")+state.run.steps_omitted+t("pages.console.ui.s552e0537f0"),'muted'));
    if(state.traceVisibleRun!==state.run.run_id){state.traceVisibleRun=state.run.run_id;state.traceVisible=100;}
    const responseIndex=state.run.steps.findIndex(step=>step.tone==='response');
    if(responseIndex>=0){const jump=el('button',t("pages.console.ui.s2206a2df0d"),'trace-response-jump');jump.onclick=()=>{state.step=responseIndex;state.traceVisible=Math.max(state.traceVisible,responseIndex+1);drawTrace();steps.querySelector('.step.active')?.scrollIntoView({block:'nearest'});};steps.append(jump);}
    const tones={decision:t("pages.console.ui.s0a178561f4"),success:t("pages.console.ui.s51991a5d11"),warning:t("pages.console.ui.saed29aef6d"),error:t("pages.console.ui.s5caf279339"),response:t("pages.console.ui.s66aaed952a")};
    state.run.steps.slice(0,state.traceVisible).forEach((step,index)=>{const b=el('button',undefined,'step'+(state.step===index?' active':''));b.dataset.tone=step.tone||'neutral';b.setAttribute('aria-pressed',String(state.step===index));b.append(el('span',String(index+1).padStart(2,'0'),'step-number'),el('span',window.ActiveMessageI18n.runtime(step.label),'step-title'));if(tones[step.tone]){const badge=el('small',tones[step.tone],'trace-badge');badge.dataset.tone=step.tone;b.append(badge);}b.onclick=()=>{state.step=index;drawTrace();};steps.append(b);});
    if(state.run.steps.length>state.traceVisible){const more=el('button',t("pages.console.ui.s65a92ae2f4")+(state.run.steps.length-state.traceVisible)+t("pages.console.ui.s71bb5f4621"),'trace-more');more.onclick=()=>{state.traceVisible+=100;drawTrace();};steps.append(more);}
    if(focusedStep)steps.querySelector('.step.active')?.focus({preventScroll:true});steps.scrollTop=scroll.steps;
    if(!state.run.steps[state.step]){detail.replaceChildren(el('p',t("pages.console.ui.s96be45cdbf")));delete detail.dataset.stepKey;return;}
    const stepKey=state.run.run_id+':'+state.step+':'+JSON.stringify(state.run.steps[state.step]);
    if(detail.dataset.stepKey===stepKey)return;
    detail.dataset.stepKey=stepKey;
    const runId=state.run.run_id,index=state.step,seq=++state.traceSeq;detail.replaceChildren(el('p',t("pages.console.ui.sabba06ec22"),'muted'));
    api('trace',undefined,{run_id:runId,step:index}).then(step=>{
      if(seq!==state.traceSeq||state.tab!=='traces')return;detail.replaceChildren(el('h3',window.ActiveMessageI18n.runtime(step.label)),el('small',new Date(step.at*1000).toLocaleString(window.ActiveMessageI18n.getLocale())+' · '+window.ActiveMessageI18n.runtime(step.state)));
      if(state.run.sid)detail.append(el('small',S(state.run.sid),'session-name-reference'));const references=SR(JSON.stringify(step.data??{}));if(references)detail.append(el('small',references,'session-name-reference'));
      const record=step.data?.code?step.data:step.data?.['异常']||step.data?.['结果']||step.data?.['开始']||step.data;
      const diagnostic=window.ActiveMessageI18n.diagnostic(record?.code);
      if(diagnostic){detail.append(el('p',window.ActiveMessageI18n.runtime(diagnostic.message),'trace-explanation'));if(diagnostic.action)detail.append(el('p',window.ActiveMessageI18n.runtime(diagnostic.action)));if(diagnostic.tab){const go=el('button',t("pages.console.ui.sb256e67361"));go.onclick=()=>selectTab(diagnostic.tab);detail.append(go);}}
      if(typeof record?.explanation==='string')detail.append(el('p',ST(R(record.explanation)),'trace-explanation'));
      if(step.data?.score?.final!==undefined){const score=step.data.score;detail.append(el('p',t("pages.console.ui.sb448909ba9")+displayScore(Number(score.final),Number(step.data.threshold))+(step.data.triggered?' > ':' ≤ ')+t("pages.console.ui.s60d9bbe4c0")+step.data.threshold,'score-outcome'));}
      if(record?.phase_label){const d=record;detail.append(el('p',t("pages.console.ui.sc3bb2b7166")+R(d.phase_label)+t("pages.console.ui.s6261e0cb27")+d.phase_seconds+t("pages.console.ui.s88568e1855")+d.execution_seconds+t("pages.console.ui.s302e66cfea")+(d.timeout_seconds==null?t("pages.console.ui.s4a6f2fe68b"):t("pages.console.ui.s5420d3887f")+d.timeout_seconds+t("pages.console.ui.sd9ad5055c3"))));detail.append(el('p',t("pages.console.ui.s702d41b438")+d.provider_calls+t("pages.console.ui.sc1ba9be609")+d.tool_calls+t("pages.console.ui.see9a69e60d")+(d.sent?t("pages.console.ui.s0dc8a4fae5"):t("pages.console.ui.s02189d6947"))));if(d.outcome)detail.append(el('p',R(d.outcome)));}
      if(step.tone==='response'&&step.data!==undefined){const response=step.data?.response??step.data,text=typeof response==='string'?response:JSON.stringify(response,null,2);detail.append(el('pre',text,'model-response'));}
      if(step.data!==undefined){const copy=el('button',t("pages.console.ui.see56b61e6d"));copy.onclick=()=>copyText(JSON.stringify(step.data,null,2),notice);detail.append(copy,el('pre',JSON.stringify(step.data,null,2)));}
      else detail.append(el('p',t("pages.console.ui.sd8acf088a4"),'muted'));
      detail.scrollTop=scroll.detail;
    }).catch(error=>{if(seq===state.traceSeq){delete detail.dataset.stepKey;detail.replaceChildren(el('p',error.message,'warning'));}});
  }
  async function refreshStatus(redraw=true) {
    if(statusPending)return statusPending;
    statusPending=(async()=>{
      const runId=state.run?.run_id,seq=state.traceSeq;
      state.status=await api('status',undefined,state.tab==='schedule'?{schedule_sid:scheduleView.selectedSid()}:undefined);
      if(redraw&&state.tab==='traces'&&runId&&seq===state.traceSeq){
        try{
          const run=await api('trace',undefined,{run_id:runId});
          if(state.run?.run_id===runId&&seq===state.traceSeq){
            const changed=JSON.stringify(state.run.steps)!==JSON.stringify(run.steps)||state.run.history_omitted!==run.history_omitted||state.run.steps_omitted!==run.steps_omitted||!!state.run.progress!==!!run.progress;
            state.run=run;state.step=Math.min(state.step,Math.max(0,run.steps.length-1));
            if(changed)drawTrace();else updateTraceProgress();
          }
        }catch(error){if(state.run?.run_id===runId&&seq===state.traceSeq){state.run=null;drawTrace();notice(error.message,true);}}
      }
      if(redraw&&state.tab==='traces')traceBrowser.update();
      else if(redraw&&state.tab==='overview')render();
      else if(redraw&&state.tab==='schedule'){scheduleStrip();await refreshAgenda();await preview(true);}
    })();
    try{return await statusPending;}finally{statusPending=null;}
  }
  function updateTraceProgress(){
    const progress=state.run?.progress;
    if(!progress)return;
    const phase=$('trace-phase'),wait=$('trace-wait');
    if(phase)phase.textContent=t("pages.console.ui.s23ef9f06ba")+R(progress.phase_label);
    if(wait)wait.textContent=t("pages.console.ui.s10c3698b10")+progress.phase_seconds+t("pages.console.ui.s302e66cfea")+(progress.timeout_seconds==null?t("pages.console.ui.s4a6f2fe68b"):t("pages.console.ui.s5420d3887f")+progress.timeout_seconds+t("pages.console.ui.sd9ad5055c3"));
  }
  async function reload(initial=false) {
    if(state.busy)return;
    const firstLoad=initial||!state.config;
    if(state.dirty&&!await dialog({title:t("pages.console.ui.sa858e8aa9d"),message:t("pages.console.ui.s302d9d6687"),confirm:t("pages.console.ui.s6645035702"),danger:true}))return;
    busy(true);state.previewSeq++;clearTimeout(previewTimer);notice('');
    try {
      const data=await api('bootstrap',undefined,initial?undefined:{refresh_names:true});window.ActiveMessageUI.setSessionNames(data.session_names);window.ActiveMessageI18n.load(data.translations);Object.assign(state,{config:data.config,schema:data.schema,schemaSource:clone(data.schema),revision:data.revision,providers:data.providers,placeholders:data.placeholders||[],placeholderSource:clone(data.placeholders||[]),diagnostics:data.diagnostics||{},dirty:false,effective:null});
      state.saved=clone(state.config);acceptAgenda(data.agenda_data);
      if(firstLoad){Object.assign(state.preferences,data.preferences||{});state.live=state.preferences.overview_live===true;traceBrowser.restore();if(tabs().some(t=>t[0]===state.preferences.tab))state.tab=state.preferences.tab;applyTheme();}
      applyLanguage(false);
      $('connection').textContent=t("pages.console.ui.sc139715f77");
      try{await refreshStatus(false);}catch(e){notice(t("pages.console.ui.s45cf57e999")+e.message,true);}
      render();
    } finally {busy(false);previewSoon();}
  }
  $('reload').onclick=()=>reload().catch(fail);
  $('save').onclick=async()=>{
    if(!state.config||state.busy||!state.dirty)return;
    let message=t("pages.console.ui.s4cdfc111e2");
    if(state.config.interjection.decision.jev_endpoint!==state.saved.interjection.decision.jev_endpoint)message+=t("pages.console.ui.s5d2dde0a21");
    if(!await dialog({title:t("pages.console.ui.s6ca27c6855"),message,confirm:t("pages.console.ui.s2af288c513")}))return;
    busy(true);state.previewSeq++;clearTimeout(previewTimer);let saved=false;
    try {
      const result=await api('settings',{config:clone(state.config),revision:state.revision});state.config=result.config;state.revision=result.revision;state.saved=clone(result.config);acceptAgenda(result.agenda_data);state.dirty=false;state.effective=null;saved=true;render();notice(t("pages.console.ui.s68011d1e60"));
      await refreshStatus();
    } catch(error){if(saved)notice(t("pages.console.ui.s132ce04f35")+error.message,true);else{fail(error);if(error.details?.errors)notice(error.message+'\n'+JSON.stringify(error.details.errors,null,2),true);}}
    finally {busy(false);previewSoon();}
  };
  async function startTour() {
    if(!state.config||state.busy||state.tour)return;
    state.tour=true;const previous={tab:state.tab,scope:state.scope,restore:preserveView()};
    const steps=[
      ['overview','overview-intro',t("pages.console.ui.s996b21b3ae"),t("pages.console.ui.s3e571af057")],
      ['groups','groups-intro',t("pages.console.ui.s62b5416c41"),t("pages.console.ui.s87c15e43af")],
      ['interjection','judgment-settings',t("pages.console.ui.sad0aa8e5c7"),t("pages.console.ui.s1bced343f4")],
      ['context','context-settings',t("pages.console.ui.sa0d738333b"),t("pages.console.ui.s510811323f")],
      ['overview','global-switch',t("pages.console.ui.s85d965b80c"),t("pages.console.ui.sff7d2fcc2e")],
      ['interjection','score-lab',t("pages.console.ui.scb72c8da7a"),t("pages.console.ui.se72b383ce2")],
      ['schedule','schedule-preview',t("pages.console.ui.s170d090f28"),t("pages.console.ui.s7ae7badbed")],
      ['schedule','agenda-settings',t("pages.console.ui.s3948b31514"),t("pages.console.ui.s2aea5a7d1d")],
      ['schedule','agenda-calendar',t("pages.console.ui.s318ddcd2a7"),t("pages.console.ui.s5fda122586")],
      ['traces','trace-intro',t("pages.console.ui.s67cac1f720"),t("pages.console.ui.s820c5d267a")]
    ];
    try{
      for(let i=0;i<steps.length;){
        const [tab,target,title,message]=steps[i];state.scope=-1;state.effective=null;selectTab(tab,false);
        const n=$(target);n?.classList.add('tutorial-target');n?.scrollIntoView({block:'start'});
        const next=await dialog({title:(i+1)+' / '+steps.length+'  '+title,message,confirm:i===steps.length-1?t("pages.console.ui.sdd3760c80a"):t("pages.console.ui.sea0ef2ae72"),cancel:t("pages.console.ui.s3eb4f88674"),back:t("pages.console.ui.s75ef1241c0"),backDisabled:i===0,highlight:n});
        n?.classList.remove('tutorial-target');if(!next)break;
        i+=next==='back'?-1:1;
      }
      persistPrefs({tutorial_seen:true});
    } finally {state.tour=false;state.scope=previous.scope;state.effective=null;selectTab(previous.tab,false);previous.restore();}
  }
  function applyLanguage(redraw=true){
    window.ActiveMessageI18n.setLocale(state.preferences.language||'zh-CN');
    $('language').value=window.ActiveMessageI18n.getLocale();
    state.schema=window.ActiveMessageI18n.schema(state.schemaSource);
    state.placeholders=window.ActiveMessageI18n.placeholders(state.placeholderSource);
    $('connection').textContent=t("pages.console.ui.sc139715f77");
    dock.hide();applyTheme();if(redraw){render();refreshDirty();}
  }
  $('language').onchange=()=>{persistPrefs({language:$('language').value});applyLanguage();};
  $('tutorial').onclick=startTour;
  async function init() {
    bridge=window.AstrBotPluginView||window.AstrBotPluginPage;
    if(!bridge){notice(t("pages.console.ui.s851a6adc45"),true);return;}
    const ctx=await bridge.ready();
    // Language resources belong to the framework Page context, not the agenda
    // transaction. Even failed initialization must show readable diagnostics.
    window.ActiveMessageI18n.load(ctx.i18n||bridge.getI18n?.());
    window.ActiveMessageI18n.setLocale('zh-CN');
    latestTheme=typeof ctx.isDark==='boolean'?ctx.isDark:matchMedia('(prefers-color-scheme:dark)').matches;
    const callback=ctx=>{if(typeof ctx.isDark==='boolean')latestTheme=ctx.isDark;applyTheme();};
    if(bridge.onContext)bridge.onContext(callback);else if(bridge.onContextChange)bridge.onContextChange(callback);
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change',e=>{if(typeof bridge.getContext?.()?.isDark!=='boolean'){latestTheme=e.matches;applyTheme();}});
    await reload(true).catch(fail);
    setInterval(()=>{if(!state.tour&&!document.hidden&&!state.busy&&((state.live&&!state.dirty&&state.tab==='overview')||(state.traceLive&&state.tab==='traces')||state.tab==='schedule'))refreshStatus().catch(fail);},5000);
    setInterval(()=>{if(!document.hidden&&state.tab==='schedule')scheduleView.updateClock();},1000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){scheduleView.updateClock();if(state.tab==='schedule')refreshStatus().catch(fail);}});
  }
  const headerObserver=new ResizeObserver(()=>document.documentElement.style.setProperty('--header-height',window.innerWidth<=700?'0px':document.querySelector('header').getBoundingClientRect().height+'px'));
  headerObserver.observe(document.querySelector('header'));
  window.addEventListener('resize',()=>{document.documentElement.style.setProperty('--header-height',window.innerWidth<=700?'0px':document.querySelector('header').getBoundingClientRect().height+'px');if(state.tab==='schedule')scheduleStrip();});
  init().catch(fail);
})();
