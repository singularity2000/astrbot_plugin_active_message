/* Native AstrBot Pages client. All user/model text is rendered with textContent. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const {node: el, dialog, copyText} = window.ActiveMessageUI;
  const clone = value => JSON.parse(JSON.stringify(value));
  const get = (obj, path) => path.reduce((o,k) => o?.[k], obj);
  const blank = v => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.every(x => !String(x).trim()));
  const tabs = [['overview','运行总览'],['traces','决策回放'],['groups','会话组'],['interjection','智能插话'],['proactive','主动聊天'],['schedule','作息与时间'],['context','上下文与诊断']];
  const state = {tab:'overview',scope:-1,dirty:false,busy:false,config:null,schema:null,effective:null,status:null,
    run:null,step:0,traceSeq:0,previewSeq:0,live:false,preferences:{theme:'auto'},placeholders:[],templateFocus:null,
    samples:{model:0.8,activity:0.8,energy:0.6},tour:false};
  let bridge, previewTimer, latestTheme=false, fieldId=0, prefsQueue=Promise.resolve();

  function notice(text, bad=false) {
    $('notice').textContent=text || ''; $('notice').hidden=!text; $('notice').classList.toggle('error',bad);
  }
  function fail(error) { notice(error?.message || String(error),true);if(!state.config)$('connection').textContent='连接未完成，请检查提示后重新载入'; }
  async function api(name, body, params) {
    if(!bridge)throw new Error('尚未连接 AstrBot。请从 Dashboard 打开页面后重试。');
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
    const mode=state.preferences.theme || 'auto'; $('theme').value=mode;
    document.documentElement.dataset.theme=mode==='auto' ? (latestTheme?'dark':'light') : mode;
  }
  $('theme').onchange=()=>{persistPrefs({theme:$('theme').value});applyTheme();};
  function busy(value) {
    state.busy=value; $('content').inert=value; $('nav').inert=value; $('scope').disabled=value;
    $('reload').disabled=value; $('save').disabled=value || !state.dirty;
    $('save').textContent=value?'正在处理…':'保存并生效';
  }
  function dirty() { state.previewSeq++; state.dirty=true; $('dirty').hidden=false; $('save').disabled=state.busy; previewSoon(); }
  function changed(obj,key,value,redraw=false) { obj[key]=value;dirty();if(redraw)render(); }
  function section(title,hint) { const s=el('section',undefined,'section');s.append(el('h2',title));if(hint)s.append(el('p',hint,'muted'));return s; }
  function defaultObject(fields) { const out={};for(const [key,meta] of Object.entries(fields))out[key]=meta.type==='object'?defaultObject(meta.items):clone(meta.default??null);return out; }
  function selectTab(tab,persist=true) {
    if(!tabs.some(t=>t[0]===tab))return;
    state.tab=tab;state.traceSeq++;state.previewSeq++;notice('');render();window.scrollTo(0,0);if(persist)persistPrefs({tab});
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
    $('scope-note').textContent=state.scope<0?'为跟随全局的会话设置默认行为':'正在编辑本组；留空的参数跟随全局';
    $('scope-effective').textContent='';
    $('scope-bar').classList.toggle('group-scope',state.scope>=0);
  }
  $('scope').onchange=()=>{state.scope=Number($('scope').value);state.effective=null;state.previewSeq++;render();};
  function phaseFor(path) {
    if(path.includes('decision')&&['prompt','jev_state_template'].includes(path.at(-1)))return 'decision';
    if(path.at(-1)==='activation_prompts')return 'activation';
    if(path.includes('proactive_chat')&&['prompts','task_prompt'].includes(path.at(-1)))return 'proactive';
    return null;
  }
  function bindTemplate(input,phase,label) {
    if(!phase)return;
    input.dataset.templatePhase=phase;
    input.addEventListener('focus',()=>{state.templateFocus={input,phase,label};updatePlaceholderTarget();});
  }
  function field(key,meta,obj,path,inherit=false) {
    if(meta.type==='object') {
      obj[key]??={};const box=el('details',undefined,'form-section');box.open=true;box.append(el('summary',meta.description||key));
      appendFields(box,obj[key],meta.items,path,inherit);return box;
    }
    const row=el('div',undefined,'field');row.dataset.path=path.join('.');
    const labelBox=el('div',undefined,'field-label'),ctl=el('div',undefined,'control');
    const id='field-'+(++fieldId),label=el('label',meta.description||key);label.htmlFor=id;labelBox.append(label);
    if(meta.hint) {
      const help=el('details',undefined,'field-help'),toggle=el('summary','说明');toggle.title=meta.hint;toggle.setAttribute('aria-label',(meta.description||key)+'的说明');
      const text=el('p',meta.hint);text.id=id+'-hint';help.append(toggle,text);if(meta.obvious_hint)help.open=true;labelBox.append(help);
    }
    const value=obj[key]??meta.default, phase=phaseFor(path);let input;
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
        input.oninput=()=>changed(obj,key,['int','float'].includes(meta.type)?(input.value===''?'':Number(input.value)):input.value);
        bindTemplate(input,phase,meta.description);
      }
    }
    if(input){input.id=id;input.setAttribute('aria-label',meta.description||key);if(meta.hint)input.setAttribute('aria-describedby',id+'-hint');ctl.prepend(input);}
    if(inherit&&!meta.secret){const hint=el('small',undefined,'effective');hint.dataset.path=JSON.stringify(path);hint._obj=obj;hint._key=key;ctl.append(hint);}
    row.append(labelBox,ctl);return row;
  }
  function appendFields(box,obj,fields,prefix=[],inherit=false) { for(const [key,meta] of Object.entries(fields))box.append(field(key,meta,obj,[...prefix,key],inherit)); }
  function effectiveHints() {
    document.querySelectorAll('.effective').forEach(n=>{
      const v=get(state.effective,JSON.parse(n.dataset.path));const prefix=blank(n._obj[n._key])||n._obj[n._key]==='跟随全局'?'跟随全局':'本组覆盖';
      n.textContent=prefix+' · 实际值：'+(v===undefined?'计算中…':typeof v==='boolean'?(v?'开启':'关闭'):typeof v==='object'?JSON.stringify(v):String(v));
    });
    if(state.effective){
      const cfg=state.effective;
      const text=(cfg.enabled?'':'插件总开关已关闭。')+'草稿许可：智能插话 '+(cfg.enabled&&cfg.interjection.enabled?'开启':'关闭')+'；主动聊天 '+(cfg.enabled&&cfg.proactive_chat.enabled?'开启':'关闭')+'。保存后生效，仍须满足触发条件。';
      $('scope-effective').textContent=text;
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
      const result=await api('preview',{config:clone(state.config),group_index:scope});
      if(seq!==state.previewSeq||scope!==state.scope)return;
      state.effective=result.effective;effectiveHints();showValidation(result.errors,result.warnings);drawScore();scheduleStrip();
    } catch(error){if(seq===state.previewSeq)notice('草稿预览未完成：'+error.message,true);}
  }
  function render() {
    if(!state.config)return;
    fieldId=0;state.templateFocus=null;nav();scopeOptions();$('title').textContent=tabs.find(t=>t[0]===state.tab)[1];
    $('scope-bar').hidden=['overview','traces','groups'].includes(state.tab);$('dirty').hidden=!state.dirty;
    const root=$('content');root.replaceChildren();
    if(state.tab==='overview')renderOverview(root);else if(state.tab==='traces')renderTraces(root);else if(state.tab==='groups')renderGroups(root);else renderSettings(root);
    if(state.tab!=='traces'){const v=el('aside',undefined,'validation-summary');v.id='validation';v.hidden=true;root.append(v);}
    effectiveHints();if(state.tab!=='traces')previewSoon();
  }
  function renderOverview(root) {
    const intro=section('先决定何时开口，再交给原生 Agent','智能插话看当前话题与分数；主动聊天看作息与计划。两者共用发送冷却，但不替代人格、历史或工具。');intro.classList.add('intro');intro.id='overview-intro';
    const flow=el('div',undefined,'flow');['收到消息','读取文字与已有转述','判断与加权','超过阈值才开口'].forEach(t=>flow.append(el('span',t)));intro.append(flow);root.append(intro);
    if(!state.preferences.tutorial_seen){const welcome=section('第一次使用？','用一分钟认识范围、开关和决策回放。教程不会改配置，也不会发送消息。');const b=el('button','开始新手引导','primary');b.onclick=startTour;welcome.append(b);root.append(welcome);}
    const control=section('插件总开关','关闭后，所有会话的智能插话和主动聊天都停止。本组只能覆盖对应的全局功能开关，不能覆盖这个总开关。');control.id='global-switch';appendFields(control,state.config,{enabled:state.schema.enabled});root.append(control);
    const d=state.status||{sessions:[],runs:[]};const box=section('已保存配置的会话状态','下表是运行状态，不是尚未保存的草稿。每个 SID 独立计数；开关开启代表允许运行，不保证立即发言。');
    const tools=el('div',undefined,'actions'),refresh=el('button','刷新状态'),live=el('input');live.type='checkbox';live.checked=state.live;live.onchange=()=>state.live=live.checked;const label=el('label');label.append(live,document.createTextNode(' 页面可见时每 5 秒刷新'));refresh.onclick=()=>refreshStatus().catch(fail);tools.append(refresh,label);box.append(tools);
    if(!d.sessions.length)box.append(el('p','还没有可展示的会话。可先添加完整 SID，或等待支持的会话收到消息。','empty'));
    else {
      const wrap=el('div',undefined,'scroll'),table=el('table'),head=el('tr');['会话 / 分组','插话 / 主动','冷却','今日主动','下一次计划','最近原因'].forEach(x=>head.append(el('th',x)));table.append(head);
      d.sessions.forEach(s=>{const row=el('tr'),sid=el('td',s.sid,'sid');sid.append(el('small',s.group));row.append(sid,el('td',(s.interjection?'开':'关')+' / '+(s.proactive?'开':'关')),el('td',s.cooldown_remaining+' 秒'),el('td',s.daily_sent+' / '+s.daily_limit),el('td',s.next_run?new Date(s.next_run).toLocaleString():'未安排'),el('td',s.latest?.explanation||s.latest?.message||'等待消息'));table.append(row);});wrap.append(table);box.append(wrap);
    }
    root.append(box);
    if(d.unresolved?.length)root.append(section('尚未解析的 SID',d.unresolved.join('、')+'。可改用完整 SID，或等待对应平台的消息。'));
    for(const w of d.warnings||[])root.append(section('范围提醒',w.message));
    if(d.errors&&Object.keys(d.errors).length){const b=section('已保存配置存在问题');b.append(el('pre',JSON.stringify(d.errors,null,2)));root.append(b);}
  }
  function renderGroups(root) {
    const intro=section('会话组：范围与独立选择','没有任何组时使用全局范围；添加任意组后进入白名单。空组允许保存，但不会匹配目标。');intro.id='groups-intro';root.append(intro);
    const fields=state.schema.session_groups.templates.group.items;
    state.config.session_groups.forEach((group,index)=>{
      const box=section((index+1)+'. '+(group.name||'未命名组')),head=el('div',undefined,'actions');
      const edit=el('button','编辑本组详细设置');edit.onclick=()=>{state.scope=index;state.effective=null;selectTab('interjection');};
      const remove=el('button','删除此组','danger');remove.onclick=async()=>{if(await dialog({title:'删除这个会话组？',message:'只修改草稿，保存后才生效。删除最后一个组会恢复全局范围，请注意影响。',confirm:'删除此组',danger:true})){state.config.session_groups.splice(index,1);state.scope=-1;dirty();render();}};head.append(edit,remove);box.append(head);
      appendFields(box,group,Object.fromEntries(['name','sids','interjection_mode','proactive_mode','cooldown_override'].map(k=>[k,fields[k]])));
      if(!group.sids.some(s=>String(s).trim()))box.append(el('p','本组没有 SID，不会作用于任何会话；仍可保存。','warning'));root.append(box);
    });
    const add=el('button','添加会话组','primary');add.id='add-group';add.onclick=()=>{state.config.session_groups.push({...defaultObject(fields),__template_key:'group'});dirty();render();};root.append(add);
  }
  function renderSettings(root) {
    const group=state.scope>=0?state.config.session_groups[state.scope]:null,gs=state.schema.session_groups.templates.group.items;
    if(state.tab==='interjection') {
      const box=section('智能插话','只处理普通群消息。正常 @、唤醒和命令交给主框架。关闭本功能不会清空参数。');box.id='feature-settings';root.append(box);
      if(group) {
        appendFields(box,group,{interjection_mode:gs.interjection_mode});
        box.append(field('threshold_override',gs.threshold_override,group,['interjection','threshold'],true));
        box.append(field('decision_mode',gs.decision_mode,group,['interjection','decision','mode'],true));
        for(const [key,meta] of Object.entries(gs.interjection_overrides.items))box.append(field(key,meta,group.interjection_overrides,key==='activation_prompts'?['activation_prompts']:['interjection',key],true));
        for(const key of ['weights','activity','energy']){const b=section(gs['interjection_'+key].description);appendFields(b,group['interjection_'+key],gs['interjection_'+key].items,['interjection',key],true);box.append(b);}
      } else {
        appendFields(box,state.config.interjection,state.schema.interjection.items,['interjection']);appendFields(box,state.config,{activation_prompts:state.schema.activation_prompts});
      }
      renderScore(root);renderPlaceholders(root,group?['activation']:['decision','activation']);
    } else if(['proactive','schedule'].includes(state.tab)) {
      const clocks=['timezone','sleep_hours','active_hours','active_interval_multiplier'],isSchedule=state.tab==='schedule';
      const box=section(isSchedule?'作息与时间':'主动聊天',isSchedule?'这是每天重复的睡眠与活跃时段，不是日历。睡眠优先；多个时段用英文逗号分隔。':'到计划时间才尝试。每日上限统计成功发言的轮次，不是模型调用次数。');box.id='feature-settings';root.append(box);
      if(group)appendFields(box,group,{proactive_mode:gs.proactive_mode});
      const obj=group?group.proactive_overrides:state.config.proactive_chat,metas=group?gs.proactive_overrides.items:state.schema.proactive_chat.items;
      appendFields(box,obj,Object.fromEntries(Object.entries(metas).filter(([k])=>isSchedule?clocks.includes(k):!clocks.includes(k))),['proactive_chat'],!!group);
      if(isSchedule){const strip=section('一天的作息');strip.id='schedule-preview';root.append(strip);scheduleStrip();}else renderPlaceholders(root,['proactive']);
    } else {
      const box=section('判断材料：文字优先，预算可调','这里限制判断模型和插件补充资料，不删除原生历史，也不替代真正发言的 Agent 上下文。没有转述的媒体只保留标签。');box.id='context-settings';root.append(box);
      appendFields(box,group?group.context_overrides:state.config.context,group?gs.context_overrides.items:state.schema.context.items,['context'],!!group);
      if(!group){const diag=section('诊断快照','文字快照仅在内存暂存。媒体编码与已知凭据始终隐藏；超长文字明确标记缩减。');appendFields(diag,state.config.diagnostics,state.schema.diagnostics.items,['diagnostics']);root.append(diag);const resources=section('全插件共享的运行资源','并发数对所有会话共同生效。调大并发不能解决单次上下文过大的问题。');appendFields(resources,state.config.runtime,state.schema.runtime.items,['runtime']);root.append(resources);}
    }
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
  function drawScore() {
    const box=$('score-result');if(!box)return;box.replaceChildren();const cfg=state.effective?.interjection;
    if(!cfg){box.append(el('p','等待计算当前生效参数…'));return;}
    const weights=cfg.weights,denom=Object.values(weights).reduce((a,b)=>a+Math.abs(Number(b)),0);
    if(!denom||!Number.isFinite(denom)){box.append(el('p','请先设置至少一个非零的有效权重。','warning'));return;}
    let score=0;const table=el('table'),head=el('tr');['因子','示例原分','当前权重','加权贡献'].forEach(x=>head.append(el('th',x)));table.append(head);
    for(const [key,label] of [['model','模型'],['activity','活跃'],['energy','精力']]){const w=Number(weights[key]),raw=state.samples[key],contribution=Math.abs(w)*(w<0?1-raw:raw)/denom;score+=contribution;const tr=el('tr');[label,raw,w,contribution.toFixed(4)].forEach(x=>tr.append(el('td',String(x))));table.append(tr);}
    const hit=score>Number(cfg.threshold),result=el('p','最终分 '+score.toFixed(4)+(hit?' > ':' ≤ ')+'当前阈值 '+cfg.threshold+'：'+(hit?'评分通过':'评分未通过'),'score-outcome');
    result.classList.toggle('pass',hit);box.append(table,result,el('small','负权重会先把该项变成 1−原分。评分通过后，仍要检查开关、冷却和 Agent 状态。'));
  }
  const phaseLabels={decision:'判断提示词／判断补充模板',activation:'插话激活提示词',proactive:'主动聊天提示词／任务说明'};
  function renderPlaceholders(root,phases) {
    const box=section('占位符大全','占位符就像自动填空：运行时会换成这次会话的真实内容。只复制花括号内外的完整标记，不需要懂代码。');box.id='placeholder-panel';
    const target=el('p','先点一个提示词输入框，便可把适用的占位符直接插入光标位置。','muted');target.id='placeholder-target';
    const search=el('input');search.type='search';search.placeholder='搜索用途或名称，例如“时间”“精力”';search.setAttribute('aria-label','搜索占位符');const list=el('div',undefined,'placeholder-grid');
    function draw(){list.replaceChildren();const q=search.value.trim().toLowerCase();const rows=state.placeholders.filter(p=>p.phases.some(x=>phases.includes(x))&&(!q||(p.name+p.description).toLowerCase().includes(q)));
      for(const p of rows){const card=el('article',undefined,'placeholder-card');card.append(el('code',p.token),el('p',p.description),el('small','示例：'+p.example));const allowed=p.phases.filter(x=>phases.includes(x));card.append(el('small','可用于：'+allowed.map(x=>phaseLabels[x]).join('；'),'allowed-phases'));
        const actions=el('div',undefined,'actions'),copy=el('button','复制'),insert=el('button','插入');copy.setAttribute('aria-label','复制 '+p.token);copy.onclick=()=>copyText(p.token,notice);
        insert.dataset.insertPhases=JSON.stringify(p.phases);insert.setAttribute('aria-label','插入 '+p.token);insert.disabled=true;insert.onclick=()=>{const f=state.templateFocus;if(!f||!f.input.isConnected||!p.phases.includes(f.phase))return;f.input.setRangeText(p.token,f.input.selectionStart??f.input.value.length,f.input.selectionEnd??f.input.value.length,'end');f.input.dispatchEvent(new Event('input',{bubbles:true}));f.input.focus();notice('已插入 '+p.token+'；保存后生效。');};actions.append(copy,insert);card.append(actions);list.append(card);}
      if(!rows.length)list.append(el('p','没有匹配的占位符，试试其他关键词。'));updatePlaceholderTarget();}
    search.oninput=draw;box.append(target,search,list);root.append(box);draw();
  }
  function updatePlaceholderTarget(){const target=$('placeholder-target'),f=state.templateFocus;if(target)target.textContent=f?'插入位置：'+f.label+'。不适用于该输入框的“插入”按钮会禁用。':'先点一个提示词输入框，再点击“插入”；也可以只复制后自行粘贴。';document.querySelectorAll('[data-insert-phases]').forEach(n=>n.disabled=!f||!f.input.isConnected||!JSON.parse(n.dataset.insertPhases).includes(f.phase));}
  function scheduleStrip() {
    const box=$('schedule-preview');if(!box||!state.effective)return;box.replaceChildren(el('h2','一天的作息'));const cfg=state.effective.proactive_chat;
    function inside(spec,m){return (spec||'').split(',').filter(Boolean).some(part=>{const [a,b]=part.trim().split('-').map(x=>{const [h,n]=x.split(':').map(Number);return h*60+n;});return a===b||(a<b?m>=a&&m<b:m>=a||m<b);});}
    try{const bar=el('div',undefined,'timebar');for(let m=0;m<1440;m+=15){const kind=inside(cfg.sleep_hours,m)?'sleep':inside(cfg.active_hours,m)?'active':'normal',block=el('span',undefined,kind);block.title=String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')+' · '+({sleep:'睡眠',active:'活跃',normal:'正常'}[kind]);bar.append(block);}box.append(bar);const hours=el('div',undefined,'hours');['00:00','06:00','12:00','18:00','24:00'].forEach(t=>hours.append(el('span',t)));box.append(hours,el('p','蓝灰：睡眠；青绿：活跃；浅灰：正常。时区：'+(cfg.timezone||'跟随框架')+'。活跃间隔约 '+Math.round(cfg.min_interval_minutes*cfg.active_interval_multiplier*10)/10+'～'+Math.round(cfg.max_interval_minutes*cfg.active_interval_multiplier*10)/10+' 分钟。','muted'));}catch{box.append(el('p','请先修正时间格式，再查看预览。','warning'));}
  }
  function renderTraces(root) {
    const intro=section('沿着一次决策往下看','先看本轮在哪一步停止，再看输入大小、排队、模型响应与评分。正文按步骤读取，不再一次加载全部大段上下文。');intro.id='trace-intro';const actions=el('div',undefined,'actions'),refresh=el('button','刷新记录'),clear=el('button','清空临时记录','danger');refresh.onclick=()=>refreshStatus().catch(fail);
    clear.onclick=async()=>{if(!await dialog({title:'清空临时记录？',message:'只清空本插件内存中的诊断，不删除原生聊天历史。',confirm:'清空',danger:true}))return;try{await api('clear',{});state.run=null;state.traceSeq++;await refreshStatus();notice('临时记录已清空。');}catch(e){fail(e);}};
    actions.append(refresh,clear,el('span',state.status?.capture_raw?'文字快照：开启':'文字快照：关闭','tag'));intro.append(actions);root.append(intro);
    const grid=el('div',undefined,'trace-grid'),list=el('section',undefined,'trace-list'),search=el('input');search.type='search';search.placeholder='搜索会话或结果';search.setAttribute('aria-label','搜索运行记录');const results=el('div');list.append(search,results);
    const steps=el('div',undefined,'trace-steps');steps.id='trace-steps';const detail=el('section',undefined,'trace-detail');detail.id='trace-detail';grid.append(list,steps,detail);root.append(grid);
    function drawList(){results.replaceChildren();const runs=(state.status?.runs||[]).filter(r=>(r.sid+' '+r.kind+' '+r.status).includes(search.value));if(!runs.length)results.append(el('p','暂无匹配记录。收到消息或计划到期后会出现。','empty'));
      runs.forEach(run=>{const b=el('button',run.kind+' · '+run.status,'trace-item');b.append(el('small',run.sid),el('small',new Date(run.created_at*1000).toLocaleTimeString()));b.onclick=async()=>{const seq=++state.traceSeq;try{const value=await api('trace',undefined,{run_id:run.run_id});if(seq!==state.traceSeq||state.tab!=='traces')return;state.run=value;state.step=0;drawTrace();}catch(e){if(seq===state.traceSeq)fail(e);}};results.append(b);});}
    search.oninput=drawList;drawList();drawTrace();
  }
  function drawTrace() {
    const steps=$('trace-steps'),detail=$('trace-detail');if(!steps||!detail)return;steps.replaceChildren();detail.replaceChildren();
    if(!state.run){detail.append(el('p','选择左侧的一次运行，即可查看它的经过。','empty'));return;}
    state.run.steps.forEach((step,index)=>{const b=el('button',String(index+1).padStart(2,'0')+'  '+step.label,'step'+(state.step===index?' active':''));b.onclick=()=>{state.step=index;drawTrace();};steps.append(b);});
    if(!state.run.steps[state.step]){detail.append(el('p','本轮没有保留步骤。'));return;}
    const runId=state.run.run_id,index=state.step,seq=++state.traceSeq;detail.append(el('p','正在读取这一步…','muted'));
    api('trace',undefined,{run_id:runId,step:index}).then(step=>{
      if(seq!==state.traceSeq||state.tab!=='traces')return;detail.replaceChildren(el('h3',step.label),el('small',new Date(step.at*1000).toLocaleString()+' · '+step.state));
      if(step.data?.score?.final!==undefined){const score=step.data.score;detail.append(el('p','最终分 '+Number(score.final).toFixed(4)+(step.data.triggered?' > ':' ≤ ')+'阈值 '+step.data.threshold,'score-outcome'));}
      if(step.data!==undefined){const copy=el('button','复制这一步');copy.onclick=()=>copyText(JSON.stringify(step.data,null,2),notice);detail.append(copy,el('pre',JSON.stringify(step.data,null,2)));}
      else detail.append(el('p','本步没有保留正文。若未开启文字快照，可在“上下文与诊断”中开启后等待下一次运行。','muted'));
    }).catch(error=>{if(seq===state.traceSeq){detail.replaceChildren(el('p',error.message,'warning'));}});
  }
  async function refreshStatus(redraw=true) { state.status=await api('status');if(redraw&&['overview','traces'].includes(state.tab))render(); }
  async function reload(initial=false) {
    if(state.busy)return;
    if(state.dirty&&!await dialog({title:'放弃未保存的修改？',message:'重新载入已保存的配置，当前草稿会被替换。',confirm:'放弃并载入',danger:true}))return;
    busy(true);state.previewSeq++;clearTimeout(previewTimer);notice('');
    try {
      const data=await api('bootstrap');Object.assign(state,{config:data.config,schema:data.schema,revision:data.revision,providers:data.providers,placeholders:data.placeholders||[],dirty:false,effective:null});
      state.saved=clone(state.config);
      if(initial){Object.assign(state.preferences,data.preferences||{});if(tabs.some(t=>t[0]===state.preferences.tab))state.tab=state.preferences.tab;applyTheme();}
      $('connection').textContent='已连接 · 配置与运行状态分开显示';
      try{await refreshStatus(false);}catch(e){notice('配置已载入，运行状态暂时不可用：'+e.message,true);}
      render();
    } finally {busy(false);previewSoon();}
  }
  $('reload').onclick=()=>reload().catch(fail);
  $('save').onclick=async()=>{
    if(!state.config||state.busy||!state.dirty)return;
    let message='保存后取消等待中的判断，重排主动时间并清空临时诊断；已发送计数保留。';
    if(state.config.interjection.decision.jev_endpoint!==state.saved.interjection.decision.jev_endpoint)message+=' Jev 接口地址发生变化；请求会向该地址发送凭据与判断材料，请确认可信。';
    if(state.config.diagnostics.capture_raw&&!state.saved.diagnostics.capture_raw)message+=' 将开启临时文字快照，登录管理界面的用户可查看。';
    if(!await dialog({title:'保存并生效？',message,confirm:'保存并生效'}))return;
    busy(true);state.previewSeq++;clearTimeout(previewTimer);let saved=false;
    try {
      const result=await api('settings',{config:clone(state.config),revision:state.revision});state.config=result.config;state.revision=result.revision;state.saved=clone(result.config);state.dirty=false;state.effective=null;saved=true;render();notice('配置已保存并生效。发送计数保留，下一次主动时间将重新安排。');
      await refreshStatus();
    } catch(error){if(saved)notice('保存已成功，但运行状态刷新失败：'+error.message,true);else{fail(error);if(error.details?.errors)notice(error.message+'\n'+JSON.stringify(error.details.errors,null,2),true);}}
    finally {busy(false);previewSoon();}
  };
  async function startTour() {
    if(!state.config||state.busy||state.tour)return;
    state.tour=true;const previous={tab:state.tab,scope:state.scope};
    const steps=[
      ['overview','overview-intro','两种开口方式','智能插话回应正在进行的话题；主动聊天在合适的时间主动找人聊天。教程只介绍，不会发送消息。'],
      ['groups','groups-intro','先决定在哪些会话生效','不添加组就是全局范围；添加组后只处理白名单。空组可保存，但没有目标。'],
      ['overview','global-switch','总开关始终有效','最上方“启用主动会话插件”关闭时，所有会话都停止。本组“开启／关闭”只覆盖全局的智能插话或主动聊天开关；选择“跟随全局”则使用对应默认值。'],
      ['interjection','score-lab','分数不是发言概率','用示例滑块观察权重与阈值。精力为零只是这一项低，并不一定阻止插话。等于阈值不触发。'],
      ['context','context-settings','判断材料不必越多越好','复用已有文字与图片转述，按预算去掉较旧材料。这里不会删改原生历史，真正发言仍由原生 Agent 完成。'],
      ['traces','trace-intro','看懂为什么没有开口','选一轮运行，再逐步查看。关闭、冷却、排队过期、模型故障和未过阈值是不同原因。编辑完成后，再使用右上角“保存并生效”。']
    ];
    try{
      for(let i=0;i<steps.length;i++){
        const [tab,target,title,message]=steps[i];state.scope=-1;state.effective=null;selectTab(tab,false);
        const n=$(target);n?.classList.add('tutorial-target');n?.scrollIntoView({block:'center'});
        const next=await dialog({title:(i+1)+' / '+steps.length+'  '+title,message,confirm:i===steps.length-1?'我知道了':'下一步',cancel:'跳过教程',highlight:n});
        n?.classList.remove('tutorial-target');if(!next)break;
      }
      persistPrefs({tutorial_seen:true});
    } finally {state.tour=false;state.scope=previous.scope;state.effective=null;selectTab(previous.tab,false);}
  }
  $('tutorial').onclick=startTour;
  async function init() {
    bridge=window.AstrBotPluginView||window.AstrBotPluginPage;
    if(!bridge){notice('未检测到 AstrBot 页面接口。请从 Dashboard 的插件页面入口打开，直接打开 HTML 无法连接。',true);return;}
    const ctx=await bridge.ready();latestTheme=typeof ctx.isDark==='boolean'?ctx.isDark:matchMedia('(prefers-color-scheme:dark)').matches;
    const callback=ctx=>{if(typeof ctx.isDark==='boolean')latestTheme=ctx.isDark;applyTheme();};
    if(bridge.onContext)bridge.onContext(callback);else if(bridge.onContextChange)bridge.onContextChange(callback);
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change',e=>{if(typeof bridge.getContext?.()?.isDark!=='boolean'){latestTheme=e.matches;applyTheme();}});
    await reload(true);
    setInterval(()=>{if(state.live&&!state.tour&&!document.hidden&&!state.dirty&&!state.busy&&state.tab==='overview')refreshStatus().catch(fail);},5000);
  }
  const headerObserver=new ResizeObserver(()=>document.documentElement.style.setProperty('--header-height',window.innerWidth<=700?'0px':document.querySelector('header').getBoundingClientRect().height+'px'));
  headerObserver.observe(document.querySelector('header'));
  window.addEventListener('resize',()=>document.documentElement.style.setProperty('--header-height',window.innerWidth<=700?'0px':document.querySelector('header').getBoundingClientRect().height+'px'));
  init().catch(fail);
})();
