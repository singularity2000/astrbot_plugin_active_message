/* Native AstrBot Pages client. All user/model text is rendered with textContent. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const {node: el, dialog, copyText, help, helpNote, hideHelp} = window.ActiveMessageUI;
  const clone = value => JSON.parse(JSON.stringify(value));
  const get = (obj, path) => path.reduce((o,k) => o?.[k], obj);
  const blank = v => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.every(x => !String(x).trim()));
  const tabs = [['overview','运行总览'],['traces','决策回放'],['groups','会话组'],['interjection','智能插话'],['proactive','主动聊天'],['schedule','作息与日程'],['context','上下文与诊断']];
  const state = {tab:'overview',scope:-1,dirty:false,busy:false,config:null,schema:null,effective:null,status:null,
    run:null,step:0,traceSeq:0,previewSeq:0,live:false,traceLive:false,preferences:{theme:'auto'},placeholders:[],templateFocus:null,
    samples:{model:0.8,activity:0.8,energy:0.6},tour:false};
  const traceBrowser=createTraceBrowser({state,el,section,refreshStatus,api,fail,drawTrace,persistPrefs});
  const scheduleView=createScheduleStrip({state,el});
  let statusPending=null;
  let bridge, previewTimer, latestTheme=false, fieldId=0, prefsQueue=Promise.resolve();
  const dock=window.createPlaceholderDock({catalog:()=>state.placeholders,report:notice});
  let draggedGroup=null;
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
    function kind(run){return run.kind==='主动聊天'?'proactive':run.kind==='智能插话'?'interjection':run.status==='不是普通群消息，或已由正常唤醒／命令流程处理'?'ordinary':'other';}
    function outcomes(run){
      const values=[];
      if(run.status==='进行中')values.push('running');
      if(run.progress?.sent||/^已发送/.test(run.status))values.push('sent');
      if(/失败|超时|不可用|未确认|未退出|判断未成功|任务已取消|执行被取消/.test(run.status))values.push('error');
      if(!values.length)values.push('quiet');
      return values;
    }
    function matches(run){
      const index=groupIndex(run);
      return (!filters.group||(filters.group==='ungrouped'?index===null:groupKey(index)===filters.group))
        &&run.sid.toLowerCase().includes(filters.sid.trim().toLowerCase())
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
      const options=[['','全部'],...groups.map(g=>[g.key??String(g.index),g.name||'未命名组'])];
      if(groups.length&&runs.some(r=>groupIndex(r)===null))options.push(['ungrouped','未归组']);
      const optionKey=JSON.stringify(options);
      if(groupSelect.dataset.options!==optionKey){groupSelect.replaceChildren(...options.map(([value,text])=>new Option(text,value)));groupSelect.dataset.options=optionKey;if(!options.some(([key])=>key===filters.group))filters.group='';groupSelect.value=filters.group;}
      const matching=runs.filter(matches),signature=JSON.stringify(matching.map(r=>[r.run_id,r.status,r.kind,r.created_at]));
      if(state.run&&!matching.some(run=>run.run_id===state.run.run_id)){
        state.traceSeq++;state.run=null;state.step=0;drawTrace();
      }
      summary.textContent='匹配 '+matching.length+' / '+runs.length+' 条保留记录；已发送后又失败的任务同时归入“已发送”和“异常”。';
      if(force||signature!==renderedIds){
        const scroll=list.scrollTop,buttons=matching.map(run=>{
          const b=el('button',run.kind+' · '+run.status,'trace-item');b.dataset.runId=run.run_id;b.append(el('small',run.sid),el('small',new Date(run.created_at*1000).toLocaleString()));
          b.onclick=async()=>{const seq=++state.traceSeq;try{const value=await api('trace',undefined,{run_id:run.run_id});if(seq!==state.traceSeq||state.tab!=='traces')return;const current=(state.status?.runs||[]).find(r=>r.run_id===run.run_id);if(!current||!matches(current))return;state.run=value;state.step=0;highlight();drawTrace();}catch(e){if(seq===state.traceSeq)fail(e);}};return b;
        });
        list.replaceChildren(...buttons);if(!matching.length)list.append(el('p',runs.length?'没有匹配记录，请调整筛选。':'暂无记录；收到消息或主动计划到期后会出现。','empty'));list.scrollTop=scroll;renderedIds=signature;
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
      host=section('查看为什么开口或没有开口','先筛选记录，再选择一次运行查看步骤。筛选和自动刷新会按账号自动记住，无需保存配置。文字快照始终临时采集；单次模型尝试失败不代表整轮失败。');host.id='trace-intro';
      const toolbar=el('div',undefined,'trace-toolbar'),actions=el('div',undefined,'actions'),refresh=el('button','刷新记录'),label=el('label'),live=el('input');refresh.onclick=()=>refreshStatus().catch(fail);live.type='checkbox';live.checked=state.traceLive;live.onchange=()=>{state.traceLive=live.checked;save();};label.append(live,document.createTextNode(' 页面可见时每 5 秒刷新'));actions.append(refresh,label);toolbar.append(actions);host.append(toolbar);
      const bar=el('div',undefined,'trace-filter-bar');groupSelect=el('select');groupSelect.setAttribute('aria-label','筛选会话组');groupSelect.onchange=()=>{filters.group=groupSelect.value;save();update(true);};
      const sid=el('input');sid.type='search';sid.placeholder='支持模糊搜索';sid.setAttribute('aria-label','搜索 SID');sid.maxLength=1000;sid.value=filters.sid;sid.oninput=()=>{filters.sid=sid.value;update(true);clearTimeout(searchTimer);searchTimer=setTimeout(save,300);};sid.onchange=()=>{clearTimeout(searchTimer);save();};
      const time=el('select');time.setAttribute('aria-label','记录时间范围');for(const [value,caption] of [[0,'不限'],[5,'最近 5 分钟'],[30,'最近 30 分钟'],[60,'最近 1 小时'],[180,'最近 3 小时'],[360,'最近 6 小时'],[720,'最近 12 小时'],[1440,'最近 24 小时']])time.add(new Option(caption,String(value)));time.value=String(filters.minutes);time.onchange=()=>{filters.minutes=Number(time.value);save();update(true);};
      function labeled(caption,control){const label=el('label',caption);label.append(control);return label;}bar.append(labeled('会话组',groupSelect),labeled('SID',sid),labeled('时间',time));toolbar.append(bar);
      const choices=el('div',undefined,'trace-choice-row');choices.append(multi('事件类型',[['ordinary','正常唤醒／非普通群消息'],['other','其他前置跳过'],['interjection','智能插话'],['proactive','主动聊天']],filters.kinds),multi('执行结果',[['running','进行中'],['sent','已发送'],['quiet','未发送／跳过'],['error','异常']],filters.results));host.append(choices);
      summary=el('small',undefined,'trace-filter-summary');host.append(summary);root.append(host);
      const grid=el('div',undefined,'trace-grid');list=el('section',undefined,'trace-list');list.setAttribute('aria-label','运行记录');const steps=el('div',undefined,'trace-steps');steps.id='trace-steps';const detail=el('section',undefined,'trace-detail');detail.id='trace-detail';grid.append(list,steps,detail);root.append(grid);renderedIds='';update(true);drawTrace();
    }};
  }

  /* 按真实分钟划分作息色段；当前时间使用服务端预览时区。 */
  function createScheduleStrip({state,el}) {
    let clock=null,receivedAt=0,selectedSid='',scopeKey='',renderedDate='',selectedAt='',reallocating=false;
    const statuses={pending:'待尝试',running:'进行中',sent:'已发送',quiet:'完成，未发送',failed:'未完成',skipped:'已跳过',missed:'已错过'};
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
      const reason=reallocating?'正在处理重新分配…':state.tour?'新手引导期间仅供查看。':state.busy?'请等待当前操作完成。':
        !selected?'请先选择一个已有预约的会话。':
        !plan?'正在读取预约信息；若持续不可用，请重载插件并刷新页面。':
        selected.schedule_timezone!==clock?.timezone?'所选会话时区与时间轴不同，请先在作息设置中统一时区。':
        plan.reason||((plan.date!==today||!count)?'今天没有未来且尚未尝试的预约。':
          count!==plan.count?'预约时间已到，正在等待状态刷新。':'');
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
        const confirmed=await dialog({title:'重新分配主动聊天？',message:'会话：'+sid+'\n日期：'+plan.date+'（'+plan.timezone+'）\n\n将把今天未来、尚未开始的 '+plan.count+' 次预约，在剩余的绿色活跃时段内重新随机安排。已经开始、结束、失败、跳过或错过的机会都不动，不增加次数。\n\n按已生效的作息安排，页面中未保存的配置不参与。确认后直接保存今天的预约，不修改配置，也不需要点击顶部“保存并生效”。到点仍会检查日程、冷却等条件，不保证一定发出消息。',confirm:'重新分配',cancel:'取消'});
        if(!confirmed)return;
        locked=true;busy(true);
        const result=await api('redistribute',{sid,revision,schedule_revision:scheduleRevision});saved=true;
        if(statusPending)await statusPending;
        await refreshStatus();
        notice('已重新分配 '+result.date+' 的 '+result.count+' 次主动聊天预约，仅影响会话 '+sid+'。');
      }catch(error){
        notice(saved?'预约已保存，但页面刷新失败，请刷新查看最新时间：'+error.message:error.message,true);
        if(!saved)try{if(statusPending)await statusPending;await refreshStatus();}catch{}
      }finally{reallocating=false;if(locked)busy(false);if(state.tab==='schedule')render();}
    }
    function updateClock(){
      const marker=document.getElementById('schedule-now');if(!marker||!clock)return;
      const now=current(),point=moment(now);if(renderedDate&&point.day!==renderedDate){render();return;}
      marker.style.left=point.minute/1440*100+'%';marker.dataset.edge=point.minute<120?'start':point.minute>1320?'end':'middle';marker.querySelector('span').textContent='现在 '+format(point.minute);marker.setAttribute('aria-label','当前时间 '+format(point.minute)+'，'+clock.timezone);
      document.querySelectorAll('.schedule-slot[data-status=pending]').forEach(n=>{n.classList.toggle('awaiting-sync',Number(n.dataset.at)<=now.getTime());});
      updateReallocation();
    }
    function render(){
      const box=document.getElementById('schedule-preview');if(!box||!state.effective)return;
      const scopedGroup=state.scope>=0?state.config.session_groups[state.scope]:null;
      if(scopedGroup&&!state.saved.session_groups.some(g=>g.agenda_id===scopedGroup.agenda_id)){
        box.replaceChildren(el('h2','一天的作息'),el('p','请先保存这个新会话组，再查看实际作息与预约。','muted'));return;
      }
      const focus=document.activeElement,focusAt=box.contains(focus)?focus?.dataset?.at:null,focusedSelect=focus?.id==='schedule-session';
      box.replaceChildren(el('h2','一天的作息 · 已生效设置'));const cfg=(state.liveEffective||state.effective).routine;
      try{
        const sleep=ranges(cfg.sleep_hours),active=ranges(cfg.active_hours),inside=(items,m)=>items.some(([a,b])=>a===b||(a<b?m>=a&&m<b:m>=a||m<b)),kind=m=>inside(sleep,m)?'sleep':inside(active,m)?'active':'normal';
        const boundaries=[...new Set([0,1440,...sleep.flat(),...active.flat()])].sort((a,b)=>a-b),segments=[];
        for(let i=0;i<boundaries.length-1;i++){const start=boundaries[i],end=boundaries[i+1],status=kind(start),last=segments.at(-1);if(last?.status===status)last.end=end;else segments.push({start,end,status});}
        const names={sleep:'睡眠',normal:'正常 · 智能插话',active:'活跃 · 智能插话+主动聊天'},axis=el('div',undefined,'schedule-axis'),labels=el('div',undefined,'schedule-boundaries');
        const labelPoints=[...segments.map(s=>s.start),1440],lastByRow=[],width=Math.max(180,box.clientWidth-24),labelWidth=38;
        labelPoints.forEach(m=>{const percent=m/1440*100,x=percent/100*width,left=m===0?0:m===1440?width-labelWidth:x-labelWidth/2;let row=lastByRow.findIndex(end=>left>=end+6);if(row<0)row=lastByRow.length;lastByRow[row]=left+labelWidth;const label=el('span',format(m));label.style.left=percent+'%';label.style.top=row*19+'px';label.dataset.edge=m===0?'start':m===1440?'end':'middle';labels.append(label);});
        labels.style.height=(Math.max(...[...labels.children].map(n=>parseInt(n.style.top)),0)+22)+'px';axis.append(labels);
        const track=el('div',undefined,'schedule-track'),bar=el('div',undefined,'timebar');segments.forEach(s=>{const segment=el('span',undefined,s.status);segment.style.flex=String(s.end-s.start);segment.title=format(s.start)+'～'+format(s.end)+' '+names[s.status];segment.setAttribute('aria-label',segment.title);bar.append(segment);});track.append(bar);
        const options=sessions(),newScope=state.scope<0?'global':state.config.session_groups[state.scope]?.agenda_id||'draft';
        if(newScope!==scopeKey){scopeKey=newScope;selectedSid='';}if(!options.some(s=>s.sid===selectedSid))selectedSid=options[0]?.sid||'';
        const selected=options.find(s=>s.sid===selectedSid),toolbar=el('div',undefined,'schedule-plan-toolbar');
        if(options.length){const label=el('label','预约会话 '),select=el('select');select.id='schedule-session';select.setAttribute('aria-label','查看哪个会话的聊天预约');options.forEach(s=>select.add(new Option(s.sid,s.sid)));select.value=selectedSid;select.onchange=()=>{selectedSid=select.value;selectedAt='';render();refreshStatus().catch(fail);};label.append(select);toolbar.append(label);}
        const now=current(),today=moment(now).day;renderedDate=today;
        const slots=(selected?.schedule||[]).filter(row=>moment(new Date(row.at)).day===today);
        const explanation=el('p','点选一条预约竖线，查看时间和结果。','schedule-slot-detail');explanation.id='schedule-slot-detail';explanation.setAttribute('aria-live','polite');
        slots.forEach(row=>{const date=new Date(row.at),point=moment(date),marker=el('button',undefined,'schedule-slot');marker.type='button';marker.dataset.at=String(date.getTime());marker.dataset.status=row.status;marker.style.left=point.minute/1440*100+'%';const text=format(point.minute)+' · '+(statuses[row.status]||row.status)+(row.reason?' · '+row.reason:'');marker.title=text+'\n'+selected.sid;marker.setAttribute('aria-label',marker.title);marker.onclick=()=>{selectedAt=row.at;explanation.textContent=text;};if(selectedAt===row.at)explanation.textContent=text;track.append(marker);});
        const marker=el('div',undefined,'schedule-now');marker.id='schedule-now';marker.append(el('span','现在'));track.append(marker);axis.append(track);
        toolbar.append(el('small',today+' · '+slots.length+' 个预约点'));box.append(toolbar,axis);
        const legend=el('div',undefined,'schedule-legend');for(const [key,name] of Object.entries(names)){const item=el('span',name);item.className=key;legend.append(item);}legend.append(el('span','预约点','planned'),el('small','时区：'+(clock?.timezone||cfg.timezone||'跟随框架')));
        const footer=el('div',undefined,'schedule-footer'),action=el('div',undefined,'schedule-reallocation'),button=el('button','重新分配主动聊天'),hint=el('small');
        button.id='redistribute-proactive';button.onclick=redistribute;hint.id='redistribute-hint';button.setAttribute('aria-describedby',hint.id);hint.setAttribute('role','status');action.append(button,hint);footer.append(legend,action);box.append(footer);
        let note=!selected?'本范围还没有可展示的会话，请先保存会话组或等待该会话收到消息。':!selected.proactive||!state.status?.enabled?'本会话主动聊天尚未启用或暂不可用。':!slots.length?'今天没有待展示的预约。请检查活跃时段；当天较晚启动时可能没有剩余机会。':'细竖线是本会话今天的实际预约，每 5 秒同步结果；灰色表示已过去，绿色表示已发送。';
        if(state.dirty)note+=' 时间轴和重新分配使用已生效的设置，不使用页面中尚未保存的配置。';
        box.append(el('p',note,'muted'));if(slots.length)box.append(explanation);
        if(selected?.schedule_timezone&&selected.schedule_timezone!==clock?.timezone)box.append(el('small','预约点按上方预览时区显示；该会话实际时区为 '+selected.schedule_timezone+'。','muted'));
        updateClock();if(focusedSelect)document.getElementById('schedule-session')?.focus({preventScroll:true});else if(focusAt)box.querySelector('[data-at="'+focusAt+'"]')?.focus({preventScroll:true});
      }catch{box.append(el('p','请先修正作息时间格式，再查看预览。','warning'));}
    }
    return {setClock(value){clock=value;receivedAt=Date.now();},selectedSid(){const options=sessions();return options.find(s=>s.sid===selectedSid)?.sid||options[0]?.sid||'';},updateClock,render};
  }

  function notice(text, bad=false) {
    $('notice').textContent=text || ''; $('notice').hidden=!text; $('notice').classList.toggle('error',bad);
  }
  function fail(error) { notice(error?.message || String(error),true);if(!state.config)$('connection').textContent='连接未完成，请检查提示后重新载入'; }
  async function api(name, body, params) {
    if(!bridge)throw new Error('尚未连接 AstrBot。请从 AstrBot 管理界面打开页面后重试。');
    const result=body===undefined ? await bridge.apiGet(name,params) : await bridge.apiPost(name,body);
    if(typeof result?.ok!=='boolean')throw new Error('“'+name+'”接口版本不匹配。请重载插件并重新打开页面。');
    if(!result.ok){const error=new Error(result.error || '请求未完成。'); error.details=result.data; throw error;}
    return result.data;
  }
  function persistPrefs(patch) {
    Object.assign(state.preferences,patch);
    prefsQueue=prefsQueue.then(()=>api('preferences',patch)).catch(error=>notice('当前操作已完成，但位置或外观尚未记住：'+error.message,true));
  }
  function applyTheme() {
    const mode=state.preferences.theme || 'auto';
    const effective=mode==='auto' ? (latestTheme?'dark':'light') : mode;
    const label=effective==='dark'?'深色':'浅色';
    document.documentElement.dataset.theme=effective;
    $('theme').textContent=mode==='auto'?'跟随框架（'+label+'）':label;
    $('theme').title='点击切换为'+({auto:'浅色',light:'深色',dark:'跟随框架'}[mode]);
    $('theme').setAttribute('aria-label','当前配色：'+$('theme').textContent+'；'+$('theme').title);
  }
  $('theme').onclick=()=>{persistPrefs({theme:({auto:'light',light:'dark',dark:'auto'}[state.preferences.theme])||'auto'});applyTheme();};
  function busy(value) {
    if(value)dock.hide();
    state.busy=value; $('content').inert=value; $('nav').inert=value; $('scope').disabled=value;
    $('reload').disabled=value; $('save').disabled=value || !state.dirty;
    $('save').textContent=value?'正在处理…':'保存并生效';
  }
  function refreshDirty() {
    const locations=changeTracker.compare(state.config,state.saved,state.schema);state.dirty=locations.length>0;
    $('dirty').hidden=!state.dirty;$('dirty-summary').hidden=!state.dirty;$('save').disabled=state.busy||!state.dirty;
    if(locations.length!==lastChangeLocations.length||locations.some((v,i)=>v!==lastChangeLocations[i])){
      const list=$('dirty-locations'),scroll=list.scrollLeft;list.replaceChildren(...locations.map(text=>el('li',text)));
      list.scrollLeft=scroll;$('dirty-count').textContent=locations.length+' 处';lastChangeLocations=locations;
    }
  }
  function dirty() { state.previewSeq++;refreshDirty();previewSoon(); }
  function acceptAgenda(data){
    if(data.config_revision!==state.revision)throw new Error('会话组或设置已在另一处变更，请重新载入页面。');
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
    if(state.busy)throw new Error('请等待当前操作完成。');
    busy(true);state.previewSeq++;clearTimeout(previewTimer);
    try{
      const data=await api('agenda',{...patch,revision,config_revision:state.revision});
      acceptAgenda(data);render();notice('日程已保存，后续运行按新日程处理；无需再点顶部保存。');
    }finally{busy(false);previewSoon();}
  }
  function changed(obj,key,value,redraw=false) { obj[key]=value;dirty();if(redraw)render(); }
  function section(title,hint) { const s=el('section',undefined,'section'),heading=el('h2',title);s.append(heading);if(hint)s.append(el('p',hint,'muted'));return s; }
  function defaultObject(fields) { const out={};for(const [key,meta] of Object.entries(fields))out[key]=meta.type==='object'?defaultObject(meta.items):clone(meta.default??null);return out; }
  function selectTab(tab,persist=true) {
    if(!tabs.some(t=>t[0]===tab))return;
    state.tab=tab;state.traceSeq++;state.previewSeq++;notice('');render();window.scrollTo(0,0);if(tab==='schedule')refreshStatus().catch(fail);if(persist)persistPrefs({tab});
  }
  function nav() {
    $('nav').replaceChildren();
    tabs.forEach(([key,label])=>{const b=el('button',label);b.id='nav-'+key;b.setAttribute('aria-current',state.tab===key?'page':'false');b.onclick=()=>selectTab(key);$('nav').append(b);});
  }
  function scopeOptions() {
    const select=$('scope');select.replaceChildren(new Option('全局设置','-1'));
    state.config.session_groups.forEach((g,i)=>select.add(new Option((i+1)+'. '+(g.name||'未命名组'),String(i))));
    if(state.scope>=state.config.session_groups.length)state.scope=-1;
    select.value=String(state.scope);
    $('scope-note').textContent=state.scope<0?'为跟随全局的会话设置默认行为':'正在编辑本组；日程天数和条数填“跟随全局”继承，其他参数通常留空继承';
    $('scope-note').title=$('scope-note').textContent;
    select.title=select.selectedOptions[0]?.textContent||'';
    $('scope-effective').textContent='';
    $('scope-bar').classList.toggle('group-scope',state.scope>=0);
  }
  $('scope').onchange=()=>{state.scope=Number($('scope').value);state.calendarSid='';state.effective=null;state.previewSeq++;render();if(state.tab==='schedule')refreshStatus().catch(fail);};
  function phaseFor(path) {
    if(path.includes('decision')&&['prompt','jev_state_template'].includes(path.at(-1)))return 'decision';
    if(path.at(-1)==='activation_prompts')return 'activation';
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
      enabled:'打开后才会运行；仍受插件总开关和实际触发条件限制。',
      threshold:'最终分必须高于这个值才会插话；等于也不触发。',
      decision_mode:'留空跟随全局；LLM 使用已有聊天模型，Jev 使用专用判断模型。',
      provider_id:'仅用于智能插话判断；最终回复仍由原会话的模型生成。',
      daily_limit:'每个会话每天安排的聊天机会（1～1000）；每次随机选时间，错过或失败不补位。',
      timezone:'用于作息、日程和每日次数统计，例如 Asia/Shanghai。',
      sleep_hours:'睡眠时段不主动聊天，也不智能插话；正常 @ 回复照常。本组留空跟随全局，填“无”表示不设置。',
      active_hours:'只有活跃时段可以主动找人聊；本组留空跟随全局，填“无”表示不主动聊天。',
      history_messages:'只限制判断参考资料，不删改聊天历史；0 表示先选全部。',
      recent_messages:'需要 AstrBot 已开启群消息历史保存；0 表示先选全部。',
      missing_group_history:'skip 更稳妥；runtime 会使用可能不完整的插件短期摘要。',
      proactive_timeout_seconds:'留空跟随主框架；填写正整数才增加插件整轮时限，不改变模型和工具自身的限制。',
      agenda_mode:'跟随全局、只开启或只关闭本组日程功能；关闭不会删除日程。',
      preview_days:'默认 7；留空不限；0 关闭自动日程背景，仍可使用工具。',
      max_items:'留空不限制；正整数分别限制当前与未来安排条数。',
      agenda_preview_days:'默认填入“跟随全局”；填写数字覆盖全局；留空表示本组不限；填 0 关闭自动日程背景，仍可使用日程工具。',
      agenda_max_items:'默认填入“跟随全局”；填写正整数覆盖全局；留空表示本组不限。',
      outside_scope:'允许范围外会话知晓全局日程、查询并创建自己的日程。',
      background_description:'所有会话共用；留空恢复默认，日程 JSON 自动附加。',
      repeat:'不重复、每天、每周、每年或 Cron；不熟悉 Cron 时建议选每天或每周。',
      time_mode:'全天整天有效；时段按起止时间有效，结束早于开始表示跨午夜。',
      pause_interjection:'勾选后，日程期间暂停插件自行插话；正常 @ 回复不受影响。',
      pause_proactive:'勾选后，日程期间暂停插件自行主动聊天；正常 @ 回复不受影响。'
    };
    if(inherit&&path[0]==='agenda'&&['preview_days','max_items'].includes(key))return critical['agenda_'+key];
    if(!critical[key])return '';
    return inherit?'留空跟随全局；'+critical[key].replace(/^本组留空跟随全局；/,'') : critical[key];
  }
  function field(key,meta,obj,path,inherit=false) {
    if(meta.type==='object') {
      obj[key]??={};const box=el('details',undefined,'form-section');box.open=true;const heading=el('summary',meta.description||key);if(meta.hint)heading.append(help(meta.description||key,meta.hint));box.append(heading);
      const fields=el('div',undefined,'form-fields');appendFields(fields,obj[key],meta.items,path,inherit);box.append(fields);return box;
    }
    const row=el('div',undefined,'field');row.dataset.path=path.join('.');
    const labelBox=el('div',undefined,'field-label'),ctl=el('div',undefined,'control');
    const id='field-'+(++fieldId),label=el('label',meta.description||key);label.htmlFor=id;labelBox.append(label);
    if(meta.hint){labelBox.append(help(meta.description||key,meta.hint,id+'-hint'));const inline=inlineHint(path,meta.hint,inherit);if(inline)labelBox.append(el('small',inline,'field-hint'));}
    const value=obj[key]??meta.default, phase=phaseFor(path);let input;
    if(phase)row.classList.add('template-field');
    if(phase||['text','list'].includes(meta.type)||key==='jev_endpoint')row.classList.add('field-wide');
    if(meta.type==='bool')row.classList.add('toggle-field');
    if(meta.type==='list') {
      if(!Array.isArray(obj[key]))obj[key]=[];
      label.removeAttribute('for');label.id=id+'-label';
      const list=el('div',undefined,'list-control');list.setAttribute('role','group');list.setAttribute('aria-labelledby',label.id);
      function draw() {
        list.replaceChildren();
        obj[key].forEach((item,index)=>{
          const wrap=el('div',undefined,'list-item'),area=el('textarea');area.rows=phase?4:2;area.value=item;area.id=id+'-'+index;
          area.setAttribute('aria-label',(meta.description||key)+' '+(index+1));area.oninput=()=>{obj[key][index]=area.value;dirty();};bindTemplate(area,phase,meta.description);
          const remove=el('button','移除');remove.onclick=()=>{obj[key].splice(index,1);dirty();draw();};wrap.append(area,remove);list.append(wrap);
        });
      }
      draw();const add=el('button',phase?'添加一套提示词':'添加一项');add.id=id;add.onclick=()=>{obj[key].push('');dirty();draw();[...list.querySelectorAll('textarea')].at(-1)?.focus();};ctl.append(list,add);
    } else if(meta.type==='bool') {
      input=el('input');input.type='checkbox';input.checked=Boolean(value);input.onchange=()=>changed(obj,key,input.checked,true);
      if(['enabled','interjection.enabled','proactive_chat.enabled','agenda.enabled'].includes(path.join('.'))){input.classList.add('capsule-switch');input.setAttribute('role','switch');}
    } else if(meta.options||meta._special==='select_provider') {
      input=el('select');const options=meta.options||['',...(state.providers||[]).map(p=>p.id)];
      const optionLabels={llm:'LLM · 聊天模型判断',jev:'Jev · 专用判断模型',skip:'跳过本轮并提示',runtime:'使用不完整的短期摘要'};
      options.forEach(option=>input.add(new Option(option===''?(inherit?'跟随全局':'请选择'):(optionLabels[option]||option),option)));
      if(value&&!options.includes(value))input.add(new Option(String(value)+'（当前值）',value));input.value=value??'';
      input.onchange=()=>changed(obj,key,input.value,true);
    } else {
      input=el(meta.type==='text'?'textarea':'input');input.value=value??'';if(phase)input.rows=5;
      if(meta.secret) {
        input.type='password';input.autocomplete='new-password';input.value=value==='__ACTIVE_MESSAGE_KEEP_SECRET__'?'':(value||'');
        input.placeholder=value==='__ACTIVE_MESSAGE_KEEP_SECRET__'?'已设置；留空保持不变':'填写 API Key';
        input.oninput=()=>changed(obj,key,input.value||(value==='__ACTIVE_MESSAGE_KEEP_SECRET__'?value:''));
        const clear=el('button','清空凭据','danger');clear.onclick=async()=>{if(await dialog({title:'清空这项凭据？',message:'只修改草稿，保存后才会生效。',confirm:'清空',danger:true})){obj[key]='';input.value='';input.placeholder='保存后将清空';dirty();}};ctl.append(clear);
      } else {
        if(['int','float'].includes(meta.type)){input.type='number';input.step=meta.type==='int'?'1':'any';}
        if(key==='proactive_timeout_seconds'){input.inputMode='numeric';input.placeholder='留空：跟随主框架';}
        if(['preview_days','max_items','agenda_preview_days','agenda_max_items'].includes(key)){
          input.placeholder=key.startsWith('agenda_')?'跟随全局 / 数字 / 留空不限':'留空：不限制';
        }
        input.oninput=()=>changed(obj,key,['int','float'].includes(meta.type)?(input.value===''?'':Number(input.value)):input.value);
        bindTemplate(input,phase,meta.description);
      }
    }
    if(input){input.id=id;input.setAttribute('aria-label',meta.description||key);if(meta.hint)input.setAttribute('aria-describedby',id+'-hint');ctl.prepend(input);}
    if(inherit&&!meta.secret){
      const hint=el('div',undefined,'effective');hint.dataset.path=JSON.stringify(path);hint._obj=obj;hint._key=key;
      const badge=el('span',undefined,'override-badge'),valueText=el('span',undefined,'effective-value'),reset=el('button','恢复跟随全局','inherit-reset');
      reset.onclick=()=>{obj[key]=clone(meta.default??'');dirty();render();};hint.append(badge,valueText,reset);ctl.append(hint);
    }
    row.append(labelBox,ctl);return row;
  }
  function appendFields(box,obj,fields,prefix=[],inherit=false) { for(const [key,meta] of Object.entries(fields))if(!meta.invisible)box.append(field(key,meta,obj,[...prefix,key],inherit)); }
  function briefValue(value,unlimited=false){
    if(value===undefined)return '计算中…';
    if(unlimited&&blank(value))return '不限';
    if(typeof value==='boolean')return value?'开启':'关闭';
    if(Array.isArray(value))return value.length+' 项';
    const text=String(value??'');return text.length>90?text.slice(0,90)+'…':(text||'空');
  }
  function effectiveHints() {
    let count=0;
    document.querySelectorAll('.effective').forEach(n=>{
      const path=JSON.parse(n.dataset.path),value=n._obj[n._key],agendaNumber=['agenda_preview_days','agenda_max_items'].includes(n._key),overridden=agendaNumber?value!=='跟随全局':!blank(value)&&value!=='跟随全局';
      const globalValue=get(state.config,path),effective=get(state.effective,path),same=JSON.stringify(globalValue)===JSON.stringify(effective);
      n.closest('.field').classList.toggle('overridden',overridden);if(overridden)count++;
      n.querySelector('.override-badge').textContent=overridden?(same?'本组固定 · 当前与全局相同':'本组覆盖'):'跟随全局';
      const text=n.querySelector('.effective-value');text.textContent=(overridden?'全局：'+briefValue(globalValue,agendaNumber)+' → ':'')+'实际值：'+briefValue(effective,agendaNumber);
      n.querySelector('.inherit-reset').hidden=!overridden;
    });
    const summary=$('override-count');if(summary)summary.textContent='本页覆盖 '+count+' 项';
    if(state.effective){
      const cfg=state.effective;
      $('scope-effective').textContent=(cfg.enabled?'':'插件总开关已关闭。')+'当前草稿：智能插话 '+(cfg.enabled&&cfg.interjection.enabled?'开启':'关闭')+'；主动聊天 '+(cfg.enabled&&cfg.proactive_chat.enabled?'开启':'关闭')+'。';
      $('scope-effective').title=$('scope-effective').textContent;
    }
  }
  function showValidation(errors,warnings=[]) {
    const box=$('validation');if(!box)return;box.replaceChildren();
    const entries=Object.entries(errors||{}).flatMap(([feature,rows])=>rows.map(([path,hint])=>({feature,path,hint})));
    document.querySelectorAll('.field').forEach(row=>{const invalid=entries.some(e=>e.path===row.dataset.path);row.classList.toggle('invalid',invalid);row.querySelectorAll('input,textarea,select').forEach(n=>n.setAttribute('aria-invalid',String(invalid)));});
    if(entries.length){box.append(el('h3','这些设置需要修正'));entries.forEach(e=>box.append(el('p',e.path+'：'+e.hint)));}
    warnings.forEach(w=>box.append(el('p',w.message,'warning')));box.hidden=!entries.length&&!warnings.length;
  }
  function previewSoon() { clearTimeout(previewTimer);previewTimer=setTimeout(preview,250); }
  async function preview() {
    if(!state.config||state.busy)return;
    const seq=++state.previewSeq,scope=state.scope;
    try {
      const result=await api('preview',{config:clone(state.config),group_index:scope,...(state.tab==='schedule'?{calendar_month:state.calendarMonth||'',calendar_sid:state.calendarSid||'',...agendaUI.previewParams()}:{})});
      if(seq!==state.previewSeq||scope!==state.scope)return;
      state.effective=result.effective;state.liveEffective=result.live_effective||null;scheduleView.setClock(result.live_schedule_clock||result.schedule_clock);effectiveHints();showValidation(result.errors,result.warnings);drawScore();scheduleStrip();if(result.calendar)agendaUI.update(result.calendar,result.agenda_list);
    } catch(error){if(seq===state.previewSeq)notice('草稿预览未完成：'+error.message,true);}
  }
  function render() {
    if(!state.config)return;
    hideHelp();dock.hide();fieldId=0;state.templateFocus=null;nav();scopeOptions();$('title').textContent=tabs.find(t=>t[0]===state.tab)[1];
    $('scope-bar').hidden=['overview','traces','groups'].includes(state.tab);refreshDirty();
    const root=$('content');root.replaceChildren();root.classList.toggle('only-overrides',!!state.onlyOverrides&&state.scope>=0&&!['overview','traces','groups','schedule'].includes(state.tab));
    if(state.scope>=0&&!['overview','traces','groups','schedule'].includes(state.tab)){const bar=el('div',undefined,'override-summary'),count=el('strong'),toggle=el('button',state.onlyOverrides?'显示所有参数':'只看本组覆盖');count.id='override-count';toggle.onclick=()=>{state.onlyOverrides=!state.onlyOverrides;render();};bar.append(count,toggle);root.append(bar);}
    if(state.tab==='overview')renderOverview(root);else if(state.tab==='traces')renderTraces(root);else if(state.tab==='groups')renderGroups(root);else renderSettings(root);
    if(state.tab!=='traces'){const v=el('aside',undefined,'validation-summary');v.id='validation';v.hidden=true;root.append(v);}
    effectiveHints();if(state.tab!=='traces')previewSoon();
  }
  function renderOverview(root) {
    const intro=section('什么时候开口，由插件把关','智能插话：在群聊中接话。主动聊天：隔一段时间主动找人聊。插件只决定何时唤醒机器人；回复仍由 AstrBot 原来的聊天助手生成，沿用原会话的人格、历史和可用工具。');intro.classList.add('intro');intro.id='overview-intro';
    const flow=el('div',undefined,'flow');['收到消息','读取文字与已有转述','判断与加权','超过阈值才开口'].forEach(t=>flow.append(el('span',t)));intro.append(flow);
    const top=el('div',undefined,'overview-top'),control=el('section',undefined,'overview-switch');control.id='global-switch';control.setAttribute('aria-label','插件总开关');
    control.append(field('enabled',{...state.schema.enabled,hint:''},state.config,['enabled']),el('small','关闭时停用插话、主动聊天和日程。'));
    top.append(intro,control);root.append(top);
    if(!state.preferences.tutorial_seen){const welcome=section('第一次使用？','用一分钟认识范围、开关和决策回放。教程不会改配置，也不会发送消息。');const b=el('button','开始新手引导','primary');b.onclick=startTour;welcome.append(b);root.append(welcome);}
    const d=state.status||{sessions:[],runs:[]};const box=section('已保存配置的会话状态','下表是运行状态，不是尚未保存的草稿。每个 SID 独立计数；开关开启代表允许运行，不保证立即发言。');
    const tools=el('div',undefined,'actions'),refresh=el('button','刷新状态'),live=el('input');live.type='checkbox';live.checked=state.live;live.onchange=()=>{state.live=live.checked;persistPrefs({overview_live:state.live});};const label=el('label');label.append(live,document.createTextNode(' 页面可见时每 5 秒刷新'));refresh.onclick=()=>refreshStatus().catch(fail);tools.append(refresh,label);box.append(tools);
    if(!d.sessions.length)box.append(el('p','还没有可展示的会话。可先添加完整 SID，或等待支持的会话收到消息。','empty'));
    else {
      const wrap=el('div',undefined,'scroll'),table=el('table'),head=el('tr');['会话 / 分组','智能插话 / 主动聊天','还需等待','今日主动尝试（轮）','下次尝试时间','最近一次结果'].forEach(x=>head.append(el('th',x)));table.append(head);
      d.sessions.forEach(s=>{const row=el('tr'),sid=el('td',s.sid,'sid');sid.append(el('small',s.group));row.append(sid,el('td',(s.interjection?'开':'关')+' / '+(s.proactive?'开':'关')),el('td',s.cooldown_remaining+' 秒'),el('td',s.daily_sent+' / '+s.daily_limit),el('td',s.next_run?new Date(s.next_run).toLocaleString():'未安排'),el('td',s.latest?.explanation||s.latest?.message||'等待消息'));table.append(row);});wrap.append(table);box.append(wrap);
    }
    root.append(box);
    if(d.unresolved?.length)root.append(section('尚未识别的会话 SID',d.unresolved.join('、')+'。可改用完整 SID，或等待对应平台的消息。',false));
    for(const w of d.warnings||[])root.append(section('范围提醒',w.message,false));
    if(d.errors&&Object.keys(d.errors).length){const b=section('已保存配置存在问题');b.append(el('pre',JSON.stringify(d.errors,null,2)));root.append(b);}
  }
  function moveGroup(from,to){
    const groups=state.config.session_groups;if(from<0||to<0||from>=groups.length||to>=groups.length||from===to)return;
    const scrollPosition={left:window.scrollX,top:window.scrollY};
    const selected=state.scope>=0?groups[state.scope]:null;const [item]=groups.splice(from,1);groups.splice(to,0,item);
    state.scope=selected?groups.indexOf(selected):-1;draggedGroup=null;dirty();render();notice('已调整会话组顺序；保存后同步到配置文件。');
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
    const intro=section('会话组：选择生效范围','不添加任何组时，插件可在所有支持的已知会话中运行；添加任意组后，只在组内列出的会话中运行。空组可以保存，但不会作用于任何会话。建议先添加一个测试组。');intro.id='groups-intro';root.append(intro);
    intro.append(el('small','拖动卡片手柄或使用上移／下移调整顺序；保存后生效。','muted'));
    const fields=state.schema.session_groups.templates.group.items,grid=el('div',undefined,'group-grid');root.append(grid);
    state.config.session_groups.forEach((group,index)=>{
      const box=section((index+1)+'. '+(group.name||'未命名组')),head=el('div',undefined,'actions'),heading=el('div',undefined,'group-card-heading');box.classList.add('group-card');box.dataset.groupIndex=String(index);heading.append(box.querySelector('h2'));box.append(heading);
      const handle=el('button','⠿ 排序','drag-handle');handle.draggable=true;handle.setAttribute('aria-label','拖动排序：'+(group.name||'未命名组'));
      handle.ondragstart=e=>{draggedGroup=group;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(index));box.classList.add('dragging');};
      handle.ondragend=()=>{draggedGroup=null;document.querySelectorAll('.dragging,.drop-target').forEach(n=>n.classList.remove('dragging','drop-target'));};
      box.ondragover=e=>{if(draggedGroup&&draggedGroup!==group){e.preventDefault();e.dataTransfer.dropEffect='move';box.classList.add('drop-target');}};
      box.ondragleave=e=>{if(!box.contains(e.relatedTarget))box.classList.remove('drop-target');};
      box.ondrop=e=>{e.preventDefault();if(draggedGroup)moveGroup(state.config.session_groups.indexOf(draggedGroup),index);};
      const up=el('button','↑ 上移'),down=el('button','↓ 下移');up.disabled=index===0;down.disabled=index===state.config.session_groups.length-1;
      up.onclick=()=>moveGroup(index,index-1);down.onclick=()=>moveGroup(index,index+1);head.append(handle,up,down);
      const edit=el('button','编辑本组详细设置');edit.onclick=()=>{state.scope=index;state.effective=null;selectTab('interjection');};
      const remove=el('button','删除此组','danger');remove.onclick=async()=>{if(await dialog({title:'删除这个会话组？',message:'只修改配置草稿；点击顶部保存时，才删除该组及其专属日程和排除记录。删除最后一个组会恢复全局范围，请注意影响。',confirm:'删除此组',danger:true})){state.config.session_groups.splice(index,1);state.scope=-1;dirty();render();}};head.append(edit,remove);heading.append(head);
      const fieldsBox=el('div',undefined,'group-fields');appendFields(fieldsBox,group,Object.fromEntries(['name','sids','interjection_mode','proactive_mode','cooldown_override'].map(k=>[k,fields[k]])));box.append(fieldsBox);
      const choices=[['智能插话',group.interjection_mode],['主动聊天',group.proactive_mode]],summary=el('div',undefined,'group-choice-summary');
      for(const [name,value] of choices){const badge=el('span',name+'：'+value,value==='跟随全局'?'tag':'override-badge');summary.append(badge);}box.append(summary);
      if(!blank(group.cooldown_override))box.append(el('small','本组覆盖共享冷却：'+group.cooldown_override+' 秒','override-badge'));
      if(!group.sids.some(s=>String(s).trim()))box.append(el('p','本组没有 SID，不会作用于任何会话；仍可保存。','warning'));grid.append(box);
    });
    const add=el('button','添加会话组','primary');add.id='add-group';add.onclick=()=>{state.config.session_groups.push({...defaultObject(fields),__template_key:'group'});dirty();render();};root.append(add);
  }
  function renderSettings(root) {
    const group=state.scope>=0?state.config.session_groups[state.scope]:null,gs=state.schema.session_groups.templates.group.items;
    if(state.tab==='interjection') {
      const box=section('智能插话','只处理普通群消息。正常 @、唤醒和命令交给主框架。关闭本功能不会清空参数。');box.id='feature-settings';root.append(box);
      if(group) {
        box.append(field('interjection_mode',gs.interjection_mode,group,['interjection','enabled'],true));
        box.append(field('threshold_override',gs.threshold_override,group,['interjection','threshold'],true));
        box.append(field('decision_mode',gs.decision_mode,group,['interjection','decision','mode'],true));
        for(const [key,meta] of Object.entries(gs.interjection_overrides.items))box.append(field(key,meta,group.interjection_overrides,key==='activation_prompts'?['activation_prompts']:['interjection',key],true));
        appendFields(box,group.decision_overrides,gs.decision_overrides.items,['interjection','decision'],true);
        for(const key of ['weights','activity','energy']){const b=section(gs['interjection_'+key].description);appendFields(b,group['interjection_'+key],gs['interjection_'+key].items,['interjection',key],true);box.append(b);}
      } else {
        appendFields(box,state.config.interjection,state.schema.interjection.items,['interjection']);appendFields(box,state.config,{activation_prompts:state.schema.activation_prompts});
      }
      renderScore(root);renderPlaceholders(root,['decision','activation']);
    } else if(['proactive','schedule'].includes(state.tab)) {
      const isSchedule=state.tab==='schedule',configKey=isSchedule?'routine':'proactive_chat',groupKey=isSchedule?'routine_overrides':'proactive_overrides';
      const box=section(isSchedule?'作息管理':'主动聊天',isSchedule?'睡眠时安静，正常时只参与已有话题，活跃时也可以主动找人聊。正常 @ 回复与原生未来任务照常；睡眠与活跃重叠时优先睡眠。':'每天按活跃总时长分配聊天机会，各份随机选一个时间。到点才尝试，机器人也可以选择不发；错过或失败的机会直接过去，第二天重新安排。');box.id='feature-settings';root.append(box);
      if(group&&!isSchedule)box.append(field('proactive_mode',gs.proactive_mode,group,['proactive_chat','enabled'],true));
      const obj=group?group[groupKey]:state.config[configKey],metas=group?gs[groupKey].items:state.schema[configKey].items;
      appendFields(box,obj,metas,[configKey],!!group);
      if(isSchedule){const strip=section('一天的作息');strip.id='schedule-preview';root.append(strip);scheduleStrip();agendaUI.render(root,group);}else renderPlaceholders(root,['proactive']);
    } else {
      const box=section('聊天参考资料','设置判断模型和插件补充资料能读取多少聊天记录；不会删改 AstrBot 保存的聊天历史，也不替代聊天助手原本的上下文。没有文字说明的图片、音频等只保留类型标签。');box.id='context-settings';root.append(box);
      appendFields(box,group?group.context_overrides:state.config.context,group?gs.context_overrides.items:state.schema.context.items,['context'],!!group);
      if(!group){const diag=section('运行记录与排查','执行阶段和文字快照始终临时采集，可查看请求、响应、工具结果与发送情况。快照可能包含聊天正文，已知密钥和媒体编码会隐藏，过长文字会标明缩减。');appendFields(diag,state.config.diagnostics,state.schema.diagnostics.items,['diagnostics']);root.append(diag);const resources=section('运行资源与超时','设置所有会话合计的并发额度。主动聊天额外总时限默认留空，模型和工具沿用主框架自身的限制；填写正整数才增加插件整轮时限，不影响智能插话的判断请求超时。');appendFields(resources,state.config.runtime,state.schema.runtime.items,['runtime']);root.append(resources);}
    }
    root.querySelectorAll('.section,.form-fields').forEach(box=>{
      if(box.querySelector(':scope > .field'))box.classList.add('settings-grid');
    });
  }
  function renderScore(root) {
    const box=section('用一组分数试试看','这只是试算，不调用模型、不发送消息，也不保存下面的示例分数。精力不是禁言开关；最终结果取决于当前权重和阈值。');box.id='score-lab';
    const sliders=el('div',undefined,'score-sliders');
    for(const [key,label] of [['model','模型判断'],['activity','群活跃'],['energy','机器人精力']]){
      const wrap=el('label',label),input=el('input'),output=el('output',String(state.samples[key]));input.type='range';input.min=0;input.max=1;input.step=.01;input.value=state.samples[key];input.setAttribute('aria-label','试算'+label);
      input.oninput=()=>{state.samples[key]=Number(input.value);output.textContent=input.value;drawScore();};wrap.append(input,output);sliders.append(wrap);
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
    if(!cfg){box.append(el('p','等待计算当前生效参数…'));return;}
    const weights=cfg.weights,denom=Object.values(weights).reduce((a,b)=>a+Math.abs(Number(b)),0);
    if(!denom||!Number.isFinite(denom)){box.append(el('p','请先设置至少一个非零的有效权重。','warning'));return;}
    let score=0;const table=el('table'),head=el('tr');['评分项目','示例分数','当前权重','计入总分的分值'].forEach(x=>head.append(el('th',x)));table.append(head);
    for(const [key,label] of [['model','模型'],['activity','活跃'],['energy','精力']]){const w=Number(weights[key]),raw=state.samples[key],weighted=Math.abs(w)*(w<0?1-raw:raw);score+=weighted;const tr=el('tr');[label,raw,w,(weighted/denom).toFixed(4)].forEach(x=>tr.append(el('td',String(x))));table.append(tr);}
    score=Math.max(0,Math.min(1,score/denom));
    const threshold=Number(cfg.threshold),hit=score>threshold&&Math.abs(score-threshold)>1e-12;
    const displayed=displayScore(score,threshold);
    const result=el('p','最终分 '+displayed+(hit?' > ':' ≤ ')+'当前阈值 '+cfg.threshold+'：'+(hit?'评分通过':'评分未通过'),'score-outcome');
    result.classList.toggle('pass',hit);box.append(table,result,el('small','负权重会先把该项变成 1−原分。评分通过后，仍要检查开关、发言后等待时间和聊天助手状态。','muted'));
  }
  const phaseLabels={decision:'判断提示词／判断补充模板',activation:'智能插话发言提示词',proactive:'主动聊天提示词／任务说明'};
  function renderPlaceholders(root,phases) {
    const box=section('占位符大全','占位符就像自动填空：运行时会换成这次会话的真实内容。复制时要保留两侧花括号，不需要懂代码。');box.id='placeholder-panel';
    const target=el('p','先点一个提示词输入框，便可把适用的占位符直接插入光标位置。','muted');target.id='placeholder-target';
    const search=el('input');search.type='search';search.placeholder='搜索用途或名称，例如“时间”“精力”';search.setAttribute('aria-label','搜索占位符');const list=el('div',undefined,'placeholder-grid');
    function draw(){list.replaceChildren();const q=search.value.trim().toLowerCase();const rows=state.placeholders.filter(p=>p.phases.some(x=>phases.includes(x))&&(!q||(p.name+p.description).toLowerCase().includes(q)));
      for(const p of rows){const card=el('article',undefined,'placeholder-card');const heading=el('div',undefined,'placeholder-heading');heading.append(el('code',p.token),help(p.name||p.token,'示例：'+p.example));card.append(heading,el('p',p.description));const allowed=p.phases.filter(x=>phases.includes(x));card.append(el('small','可用于：'+allowed.map(x=>phaseLabels[x]).join('；'),'allowed-phases'));
        const actions=el('div',undefined,'actions'),copy=el('button','复制'),insert=el('button','插入');copy.setAttribute('aria-label','复制 '+p.token);copy.onclick=()=>copyText(p.token,notice);
        insert.dataset.insertPhases=JSON.stringify(p.phases);insert.setAttribute('aria-label','插入 '+p.token);insert.disabled=true;insert.onclick=()=>{const f=state.templateFocus;if(!f||!f.input.isConnected||!p.phases.includes(f.phase))return;f.input.setRangeText(p.token,f.input.selectionStart??f.input.value.length,f.input.selectionEnd??f.input.value.length,'end');f.input.dispatchEvent(new Event('input',{bubbles:true}));f.input.focus();notice('已插入 '+p.token+'；保存后生效。');};actions.append(copy,insert);card.append(actions);list.append(card);}
      if(!rows.length)list.append(el('p','没有匹配的占位符，试试其他关键词。'));updatePlaceholderTarget();}
    search.oninput=draw;box.append(target,search,list);root.append(box);draw();
  }
  function updatePlaceholderTarget(){const target=$('placeholder-target'),f=state.templateFocus;if(target)target.textContent=f?'插入位置：'+f.label+'。不适用于该输入框的“插入”按钮会禁用。':'先点一个提示词输入框，再点击“插入”；也可以只复制后自行粘贴。';document.querySelectorAll('[data-insert-phases]').forEach(n=>n.disabled=!f||!f.input.isConnected||!JSON.parse(n.dataset.insertPhases).includes(f.phase));}
  function scheduleStrip() { scheduleView.render(); }
  function renderTraces(root) { traceBrowser.render(root); }
  function drawTrace() {
    const steps=$('trace-steps'),detail=$('trace-detail');if(!steps||!detail)return;const scroll={steps:steps.scrollTop,detail:detail.scrollTop};const focusedStep=steps.contains(document.activeElement);steps.replaceChildren();
    if(!state.run){detail.replaceChildren(el('p','选择左侧的一次运行，即可查看它的经过。','empty'));delete detail.dataset.stepKey;return;}
    const progress=state.run.progress;
    if(progress){const phase=el('strong'),wait=el('p',undefined,'muted');phase.id='trace-phase';wait.id='trace-wait';steps.append(phase,wait);updateTraceProgress();}
    if(state.run.history_omitted)steps.append(el('small','先前步骤已被容量／时限淘汰；当前执行状态仍可查看。','muted'));
    if(state.run.steps_omitted)steps.append(el('small','本轮达到记录上限，已省略 '+state.run.steps_omitted+' 个过程记录；保留结束摘要。','muted'));
    if(state.traceVisibleRun!==state.run.run_id){state.traceVisibleRun=state.run.run_id;state.traceVisible=100;}
    const tones={decision:'关键判断',success:'成功',warning:'留意',error:'异常'};
    state.run.steps.slice(0,state.traceVisible).forEach((step,index)=>{const b=el('button',undefined,'step'+(state.step===index?' active':''));b.dataset.tone=step.tone||'neutral';b.setAttribute('aria-pressed',String(state.step===index));b.append(el('span',String(index+1).padStart(2,'0'),'step-number'),el('span',step.label,'step-title'));if(tones[step.tone]){const badge=el('small',tones[step.tone],'trace-badge');badge.dataset.tone=step.tone;b.append(badge);}b.onclick=()=>{state.step=index;drawTrace();};steps.append(b);});
    if(state.run.steps.length>state.traceVisible){const more=el('button','继续显示（还有 '+(state.run.steps.length-state.traceVisible)+' 步）','trace-more');more.onclick=()=>{state.traceVisible+=100;drawTrace();};steps.append(more);}
    if(focusedStep)steps.querySelector('.step.active')?.focus({preventScroll:true});steps.scrollTop=scroll.steps;
    if(!state.run.steps[state.step]){detail.replaceChildren(el('p','本轮没有保留步骤。'));delete detail.dataset.stepKey;return;}
    const stepKey=state.run.run_id+':'+state.step+':'+JSON.stringify(state.run.steps[state.step]);
    if(detail.dataset.stepKey===stepKey)return;
    detail.dataset.stepKey=stepKey;
    const runId=state.run.run_id,index=state.step,seq=++state.traceSeq;detail.replaceChildren(el('p','正在读取这一步…','muted'));
    api('trace',undefined,{run_id:runId,step:index}).then(step=>{
      if(seq!==state.traceSeq||state.tab!=='traces')return;detail.replaceChildren(el('h3',step.label),el('small',new Date(step.at*1000).toLocaleString()+' · '+step.state));
      if(step.data?.score?.final!==undefined){const score=step.data.score;detail.append(el('p','最终分 '+displayScore(Number(score.final),Number(step.data.threshold))+(step.data.triggered?' > ':' ≤ ')+'阈值 '+step.data.threshold,'score-outcome'));}
      if(step.data?.phase_label){const d=step.data;detail.append(el('p','阶段：'+d.phase_label+' · 本阶段 '+d.phase_seconds+' 秒 · 执行 '+d.execution_seconds+' 秒 · '+(d.timeout_seconds==null?'跟随主框架，无插件整轮截止时间':'插件整轮上限 '+d.timeout_seconds+' 秒')));detail.append(el('p','模型调用 '+d.provider_calls+' 次 · 工具调用 '+d.tool_calls+' 次 · '+(d.sent?'已确认发送':'尚未确认发送')));if(d.outcome)detail.append(el('p',d.outcome));}
      if(step.data!==undefined){const copy=el('button','复制这一步');copy.onclick=()=>copyText(JSON.stringify(step.data,null,2),notice);detail.append(copy,el('pre',JSON.stringify(step.data,null,2)));}
      else detail.append(el('p','本步没有保留正文，可能已受容量或长度限制。','muted'));
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
      else if(redraw&&state.tab==='schedule'){scheduleStrip();await refreshAgenda();}
    })();
    try{return await statusPending;}finally{statusPending=null;}
  }
  function updateTraceProgress(){
    const progress=state.run?.progress;
    if(!progress)return;
    const phase=$('trace-phase'),wait=$('trace-wait');
    if(phase)phase.textContent='当前：'+progress.phase_label;
    if(wait)wait.textContent='本阶段已等待 '+progress.phase_seconds+' 秒 · '+(progress.timeout_seconds==null?'跟随主框架，无插件整轮截止时间':'插件整轮上限 '+progress.timeout_seconds+' 秒');
  }
  async function reload(initial=false) {
    if(state.busy)return;
    if(state.dirty&&!await dialog({title:'放弃未保存的修改？',message:'重新载入已保存的配置，当前草稿会被替换。',confirm:'放弃并载入',danger:true}))return;
    busy(true);state.previewSeq++;clearTimeout(previewTimer);notice('');
    try {
      const data=await api('bootstrap');Object.assign(state,{config:data.config,schema:data.schema,revision:data.revision,providers:data.providers,placeholders:data.placeholders||[],dirty:false,effective:null});
      state.saved=clone(state.config);acceptAgenda(data.agenda_data);
      if(initial){Object.assign(state.preferences,data.preferences||{});state.live=state.preferences.overview_live===true;traceBrowser.restore();if(tabs.some(t=>t[0]===state.preferences.tab))state.tab=state.preferences.tab;applyTheme();}
      $('connection').textContent='已连接 · 配置与运行状态分开显示';
      try{await refreshStatus(false);}catch(e){notice('配置已载入，运行状态暂时不可用：'+e.message,true);}
      render();
    } finally {busy(false);previewSoon();}
  }
  $('reload').onclick=()=>reload().catch(fail);
  $('save').onclick=async()=>{
    if(!state.config||state.busy||!state.dirty)return;
    let message='保存页面中的配置修改；日程操作已单独保存。若删除了会话组，也会删除该组专属日程和排除记录。保存配置会取消等待中的判断，并清空此前采集的步骤；当天已结束的机会和已用额度会保留。只有作息、时区或每日额度变化时，才重新抽取后续预约。';
    if(state.config.interjection.decision.jev_endpoint!==state.saved.interjection.decision.jev_endpoint)message+=' Jev 接口地址发生变化；请求会向该地址发送凭据与判断材料，请确认可信。';
    if(!await dialog({title:'保存并生效？',message,confirm:'保存并生效'}))return;
    busy(true);state.previewSeq++;clearTimeout(previewTimer);let saved=false;
    try {
      const result=await api('settings',{config:clone(state.config),revision:state.revision});state.config=result.config;state.revision=result.revision;state.saved=clone(result.config);acceptAgenda(result.agenda_data);state.dirty=false;state.effective=null;saved=true;render();notice('配置已保存并生效。当天已结束的机会和已用额度保留，可在作息时间轴查看预约。');
      await refreshStatus();
    } catch(error){if(saved)notice('保存已成功，但运行状态刷新失败：'+error.message,true);else{fail(error);if(error.details?.errors)notice(error.message+'\n'+JSON.stringify(error.details.errors,null,2),true);}}
    finally {busy(false);previewSoon();}
  };
  async function startTour() {
    if(!state.config||state.busy||state.tour)return;
    state.tour=true;const previous={tab:state.tab,scope:state.scope};
    const steps=[
      ['overview','overview-intro','两种开口方式','智能插话回应正在进行的话题；主动聊天在合适的时间主动找人聊天。教程只介绍，不会发送消息。'],
      ['groups','groups-intro','先决定在哪些会话生效','建议先添加一个测试组，填入测试会话的 SID（会话地址）。只要添加了组，插件就只在组内会话生效；没有任何组时，范围是所有支持的已知会话。排序只调整列表位置，保存后生效。'],
      ['overview','global-switch','总开关始终有效','最上方“启用主动会话插件”关闭时，所有会话都停止。本组“开启／关闭”只覆盖相应的智能插话、主动聊天或日程功能开关；选择“跟随全局”则使用对应默认值。'],
      ['interjection','score-lab','分数不是发言概率','用示例滑块观察权重与阈值。精力为零只是这一项低，并不一定阻止插话。等于阈值不触发。'],
      ['interjection','feature-settings','判断和说话是两步','“判断提示词”指导模型打分；“智能插话发言提示词列表”指导机器人如何接话。顶部可切换会话组，单独填写判断提示词和补充模板；留空跟随全局，醒目的徽标标出本组覆盖。'],
      ['interjection','placeholder-panel','不用背占位符','点击提示词输入框，底部临时助手只显示这个输入框可用的占位符。点击插入光标位置，有选中文字则替换；Esc 收起。这里的大全可以查说明与示例。'],
      ['schedule','schedule-preview','看懂一天的作息','睡眠时安静，正常时只智能插话，活跃时也会主动找人聊。每天把有效活跃时间分成若干份，每份随机预约一次；错过或失败的机会当天结束。细竖线显示所选会话实际预约，点一下可看时间和结果；蓝色标记是现在。一个组有多个会话时，可用下拉框切换。色带与预约点都展示已生效的设置；配置草稿保存后才会改变作息。'],
      ['schedule','agenda-settings','先从一条午休开始','开启日程功能，添加午休，选起止时间和重复方式；每周可以勾选多天。按需要暂停插件插话或主动聊天；都不勾选时只让机器人知道。不创建或拦截原生未来任务。'],
      ['schedule','agenda-calendar','日程独立保存，日历展示已保存安排','添加或编辑日程后，点弹窗里的“保存日程”就保存了，无需再点顶部保存。删除、排除和恢复继承也直接保存。日历按已生效的设置计算；开关、时区和会话组等配置仍需点顶部“保存并生效”。'],
      ['context','context-settings','判断材料不必越多越好','复用已有文字与图片转述，按预算去掉较旧材料。这里不会删改原生历史，真正发言仍由 AstrBot 原来的聊天助手完成。'],
      ['traces','trace-intro','看懂为什么没有开口','选一轮运行，点击“刷新记录”更新阶段和耗时。已发送或正常完成但未发送均占用一次每日主动额度。等待模型、一次尝试未成功、整轮最终失败和因睡眠放弃发送是不同情况；可按会话组、部分 SID、事件类型、执行结果和时间筛选。筛选和自动刷新开关会按登录账号自动记住，重新打开也会恢复，不用保存配置。刷新会保留阅读位置。同一次模型或工具调用的开始、结果和耗时合在一步中；不同次调用分别记录。关键判断用金色提示，发送成功为绿色，异常为红色。单轮最多保存 1000 步，较长记录可点“继续显示”；保留时间和总容量也会影响可查看的内容。文字快照始终临时采集。']
    ];
    try{
      for(let i=0;i<steps.length;){
        const [tab,target,title,message]=steps[i];state.scope=-1;state.effective=null;selectTab(tab,false);
        const n=$(target);n?.classList.add('tutorial-target');n?.scrollIntoView({block:'center'});
        const next=await dialog({title:(i+1)+' / '+steps.length+'  '+title,message,confirm:i===steps.length-1?'我知道了':'下一步',cancel:'跳过教程',back:'上一步',backDisabled:i===0,highlight:n});
        n?.classList.remove('tutorial-target');if(!next)break;
        i+=next==='back'?-1:1;
      }
      persistPrefs({tutorial_seen:true});
    } finally {state.tour=false;state.scope=previous.scope;state.effective=null;selectTab(previous.tab,false);}
  }
  $('tutorial').onclick=startTour;
  async function init() {
    bridge=window.AstrBotPluginView||window.AstrBotPluginPage;
    if(!bridge){notice('未检测到 AstrBot 页面接口。请从 AstrBot 管理界面的插件页面入口打开，直接打开 HTML 无法连接。',true);return;}
    const ctx=await bridge.ready();latestTheme=typeof ctx.isDark==='boolean'?ctx.isDark:matchMedia('(prefers-color-scheme:dark)').matches;
    const callback=ctx=>{if(typeof ctx.isDark==='boolean')latestTheme=ctx.isDark;applyTheme();};
    if(bridge.onContext)bridge.onContext(callback);else if(bridge.onContextChange)bridge.onContextChange(callback);
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change',e=>{if(typeof bridge.getContext?.()?.isDark!=='boolean'){latestTheme=e.matches;applyTheme();}});
    await reload(true);
    setInterval(()=>{if(!state.tour&&!document.hidden&&!state.busy&&((state.live&&!state.dirty&&state.tab==='overview')||(state.traceLive&&state.tab==='traces')||state.tab==='schedule'))refreshStatus().catch(fail);},5000);
    setInterval(()=>{if(!document.hidden&&state.tab==='schedule')scheduleView.updateClock();},1000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){scheduleView.updateClock();if(state.tab==='schedule')refreshStatus().catch(fail);}});
  }
  const headerObserver=new ResizeObserver(()=>document.documentElement.style.setProperty('--header-height',window.innerWidth<=700?'0px':document.querySelector('header').getBoundingClientRect().height+'px'));
  headerObserver.observe(document.querySelector('header'));
  window.addEventListener('resize',()=>{document.documentElement.style.setProperty('--header-height',window.innerWidth<=700?'0px':document.querySelector('header').getBoundingClientRect().height+'px');if(state.tab==='schedule')scheduleStrip();});
  init().catch(fail);
})();
