/* No remote scripts, no HTML rendering of user data, no model calls from the editor. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; };
  const clone = value => JSON.parse(JSON.stringify(value));
  const get = (obj, path) => path.reduce((o,k)=>o?.[k],obj);
  const blank = v => v==null || v==='' || (Array.isArray(v)&&v.length===0);
  const state = {tab:'overview',scope:-1,dirty:false,config:null,schema:null,effective:null,status:null,run:null,step:0,live:false,previewSeq:0};
  const tabs = [['overview','运行总览'],['traces','决策回放'],['groups','会话组'],['interjection','智能插话'],['proactive','主动聊天'],['schedule','作息与时间'],['context','上下文与诊断']];
  let bridge, previewTimer, latestTheme=false, themeMode='auto';
  try{themeMode=localStorage.getItem('active-message-theme')||'auto';}catch{}
  function notice(text){$('notice').textContent=text||'';}
  function fail(error){
    notice(error.message || String(error));
    if(!state.config){
      $('title').textContent='连接未完成';
      $('content').replaceChildren(el('div','请按上方提示处理后点击“重新载入”。若刚更新插件，请先重载插件，再关闭并重新打开本页面。','empty'));
    }
  }
  async function api(name,body,params){
    // Bridge 已拆除框架的 status/data 外壳，此处读取插件自己的结果。
    const result=body===undefined?await bridge.apiGet(name,params):await bridge.apiPost(name,body);
    if(typeof result?.ok!=='boolean'){
      throw new Error(`“${name}”接口返回格式不匹配。请重载插件并重新打开页面；若仍失败，请提供该接口名称，不必发送配置或上下文正文。`);
    }
    if(!result.ok){const error=new Error(result.error||`“${name}”请求未成功，请查看插件日志。`); error.details=result.data; throw error;}
    return result.data;
  }
  function dirty(){state.dirty=true;$('dirty').hidden=false;$('save').disabled=false;previewSoon();}
  function theme(){const mode=['auto','light','dark'].includes(themeMode)?themeMode:'auto';
    $('theme').value=mode;document.documentElement.dataset.theme=mode==='auto'?(latestTheme?'dark':'light'):mode;}
  $('theme').onchange=()=>{themeMode=$('theme').value;try{localStorage.setItem('active-message-theme',themeMode);}catch{}theme();};
  function defaultObject(fields){const out={};for(const [key,meta] of Object.entries(fields))out[key]=meta.type==='object'?defaultObject(meta.items):clone(meta.default??null);return out;}
  function scopeOptions(){const select=$('scope');select.replaceChildren(new Option('全局设置','-1'));
    state.config.session_groups.forEach((g,i)=>select.add(new Option(`${i+1}. ${g.name||'未命名组'}`,String(i))));
    if(state.scope>=state.config.session_groups.length)state.scope=-1;select.value=String(state.scope);
    $('scope-note').textContent=state.scope<0?'未被会话组覆盖的设置均以此为准。':'空值继承全局；0 是有效覆盖。关闭功能只折叠，不删除覆盖值。';}
  $('scope').onchange=()=>{state.scope=Number($('scope').value);state.effective=null;render();previewSoon();};
  function nav(){const n=$('nav');n.replaceChildren();tabs.forEach(([key,label])=>{const b=el('button',label);b.setAttribute('aria-current',state.tab===key?'page':'false');b.onclick=()=>{state.tab=key;notice('');render();};n.append(b);});}
  function section(title,hint){const s=el('section',undefined,'section');s.append(el('h2',title));if(hint)s.append(el('p',hint,'muted'));return s;}
  function changed(obj,key,value,rerender=false){obj[key]=value;dirty();if(rerender)render();}
  function field(key,meta,obj,path,inherit=false){
    if(meta.condition&&!Object.entries(meta.condition).every(([k,v])=>get(obj,k.split('.'))===v))return null;
    if(meta.type==='object'){
      obj[key]??={};const box=el('details',undefined,'form-section');box.open=true;box.append(el('summary',meta.description||key));
      for(const [k,m]of Object.entries(meta.items)){const child=field(k,m,obj[key],[...path,k],inherit);if(child)box.append(child);}return box;
    }
    const row=el('div',undefined,'field'),label=el('div'),ctl=el('div',undefined,'control');
    const labelText=meta.description||key;label.append(el('div',labelText,'label'));if(meta.hint)label.append(el('div',meta.hint,'hint'));
    let input;const value=obj[key]??meta.default;
    if(meta.type==='list'){
      if(!Array.isArray(obj[key]))obj[key]=[];const list=el('div');
      function draw(){list.replaceChildren();obj[key].forEach((item,index)=>{const wrap=el('div',undefined,'list-item');const area=el('textarea');area.rows=2;area.value=item;area.setAttribute('aria-label',`${labelText} ${index+1}`);area.oninput=()=>{obj[key][index]=area.value;dirty();};const remove=el('button','移除');remove.onclick=()=>{obj[key].splice(index,1);dirty();draw();};wrap.append(area,remove);list.append(wrap);});}
      draw();const add=el('button','添加一项');add.onclick=()=>{obj[key].push('');dirty();draw();};ctl.append(list,add);
    }else if(meta.type==='bool'){
      input=el('input');input.type='checkbox';input.checked=Boolean(value);input.onchange=()=>changed(obj,key,input.checked,true);
    }else if(meta.options||meta._special==='select_provider'){
      input=el('select');const options=meta.options||['',...(state.providers||[]).map(p=>p.id)];
      options.forEach(option=>input.add(new Option(option===''?(inherit?'跟随全局':'请选择'):option,option)));
      if(value&&!options.includes(value))input.add(new Option(`${value}（当前值）`,value));input.value=value??'';
      input.onchange=()=>changed(obj,key,input.value,true);
    }else{
      input=el(meta.type==='text'?'textarea':'input');
      if(meta.secret){input.type='password';input.autocomplete='new-password';input.value=value==='__ACTIVE_MESSAGE_KEEP_SECRET__'?'':(value||'');input.placeholder=value==='__ACTIVE_MESSAGE_KEEP_SECRET__'?'已设置；留空保持不变':'填写 API Key';input.oninput=()=>changed(obj,key,input.value|| (value==='__ACTIVE_MESSAGE_KEEP_SECRET__'?value:''));const clear=el('button','清空凭据','danger');clear.onclick=()=>{obj[key]='';input.value='';input.placeholder='凭据将被清空';dirty();};ctl.append(clear);}
      else{input.value=value??'';if(['int','float'].includes(meta.type)){input.type='number';input.step=meta.type==='int'?'1':'any';}
        input.oninput=()=>changed(obj,key,['int','float'].includes(meta.type)?(input.value===''?'':Number(input.value)):input.value);}
    }
    if(input){input.setAttribute('aria-label',labelText);ctl.prepend(input);}
    if(inherit&&!meta.secret){const hint=el('div',undefined,'effective');hint.dataset.path=JSON.stringify(path);hint._obj=obj;hint._key=key;ctl.append(hint);}
    row.append(label,ctl);return row;
  }
  function appendFields(box,obj,fields,prefix=[],inherit=false){for(const [key,meta] of Object.entries(fields)){const node=field(key,meta,obj,[...prefix,key],inherit);if(node)box.append(node);}}
  function effectiveHints(){document.querySelectorAll('.effective').forEach(n=>{const v=get(state.effective,JSON.parse(n.dataset.path));const prefix=(blank(n._obj[n._key])||(n._key==='decision_mode'&&n._obj[n._key]==='跟随全局'))?'跟随全局':'本组覆盖';n.textContent=`${prefix} · 实际值：${v===undefined?'正在计算…':typeof v==='object'?JSON.stringify(v):String(v)}`;});}
  function previewSoon(){clearTimeout(previewTimer);previewTimer=setTimeout(preview,250);}
  async function preview(){if(!state.config)return;const seq=++state.previewSeq;try{const result=await api('preview',{config:state.config,group_index:state.scope});if(seq!==state.previewSeq)return;state.effective=result.effective;effectiveHints();scheduleStrip();}catch(error){if(seq===state.previewSeq)notice(`生效值预览失败：${error.message}`);}}
  function render(){if(!state.config)return;nav();$('title').textContent=tabs.find(t=>t[0]===state.tab)[1];scopeOptions();$('scope-bar').hidden=['overview','traces','groups'].includes(state.tab);$('dirty').hidden=!state.dirty;
    const root=$('content');root.replaceChildren();
    if(state.tab==='overview')renderOverview(root);else if(state.tab==='traces')renderTraces(root);else if(state.tab==='groups')renderGroups(root);else renderSettings(root);
    effectiveHints();if(!['overview','traces','groups'].includes(state.tab))previewSoon();
  }
  function renderOverview(root){
    const intro=section('先看为什么说，再看说了什么','收到群消息后检查范围、合并消息、读取上下文、判断与算分；只有最终分严格超过阈值才激活原生 Agent。主动聊天则按作息与计划触发。');intro.classList.add('intro');root.append(intro);
    appendFields(intro,state.config,{enabled:state.schema.enabled});
    const d=state.status||{sessions:[],runs:[]};const metrics=el('div',undefined,'metrics');
    [['总开关',d.enabled?'开启':'关闭'],['已知会话',d.sessions.length],['运行中',d.sessions.filter(s=>s.agent_active).length],['临时记录',d.runs.length]].forEach(([name,value])=>{const m=el('div',undefined,'metric');m.append(el('strong',String(value)),el('span',name));metrics.append(m);});root.append(metrics);
    const box=section('会话状态','每个 SID 独立计数。会话组不合并历史，也不共享精力。');const toolbar=el('div',undefined,'inline'),refresh=el('button','刷新状态'),live=el('input');live.type='checkbox';live.checked=state.live;live.onchange=()=>state.live=live.checked;const liveLabel=el('label');liveLabel.append(live,document.createTextNode(' 页面可见时每 5 秒刷新'));refresh.onclick=()=>refreshStatus().catch(fail);toolbar.append(refresh,liveLabel);box.append(toolbar);
    if(!d.sessions.length)box.append(el('div','暂无会话。请先配置 SID，或在已启用的会话中收到一条消息。','empty'));
    else{const wrap=el('div',undefined,'scroll'),table=el('table'),head=el('tr');['会话 / 分组','插话 / 主动','冷却','今日主动','下一次计划','最近原因'].forEach(x=>head.append(el('th',x)));table.append(head);d.sessions.forEach(s=>{const row=el('tr');const sid=el('td',s.sid,'sid');sid.append(el('small',s.group));row.append(sid,el('td',`${s.interjection?'开':'关'} / ${s.proactive?'开':'关'}`),el('td',`${s.cooldown_remaining} 秒`),el('td',`${s.daily_sent} / ${s.daily_limit}`),el('td',s.next_run?new Date(s.next_run).toLocaleString():'未安排'),el('td',s.latest?.explanation||s.latest?.message||'等待消息'));table.append(row);});wrap.append(table);box.append(wrap);}root.append(box);
    if(d.unresolved?.length)root.append(section('尚未解析的 SID',d.unresolved.join('、')+'。请改用完整 SID，或等待明确的平台消息。'));
    if(d.errors&&Object.keys(d.errors).length){const error=section('需要修正的配置');error.append(el('pre',JSON.stringify(d.errors,null,2),'err'));root.append(error);}
  }
  function renderGroups(root){
    root.append(section('会话组与继承','列表为空时使用全局范围；添加任何组后进入白名单。空组没有目标。添加完成后，在各设置子页切换到该组设置详细覆盖。'));
    const fields=state.schema.session_groups.templates.group.items;
    state.config.session_groups.forEach((group,index)=>{const box=section(''),head=el('div',undefined,'group-head');head.append(el('h2',`${index+1}. ${group.name||'未命名组'}`));const remove=el('button','删除此组','danger');remove.onclick=()=>{if(confirm('删除这个会话组？只修改草稿，保存后才生效。')){state.config.session_groups.splice(index,1);state.scope=-1;dirty();render();}};head.append(remove);box.append(head);
      appendFields(box,group,Object.fromEntries(['name','sids','cooldown_override','interjection_enabled','proactive_enabled'].map(k=>[k,fields[k]])));
      const edit=el('button','编辑本组详细设置');edit.onclick=()=>{state.scope=index;state.tab='interjection';render();};box.append(edit);root.append(box);});
    const add=el('button','添加会话组','primary');add.onclick=()=>{state.config.session_groups.push({...defaultObject(fields),__template_key:'group'});dirty();render();};root.append(add);
  }
  function renderSettings(root){
    const group=state.scope>=0?state.config.session_groups[state.scope]:null;const gs=state.schema.session_groups.templates.group.items;
    if(state.tab==='interjection'){
      const box=section('智能插话','只处理普通群消息。正常 @、唤醒和命令交给主框架；不冒充其他发送者。');root.append(box);
      if(group){appendFields(box,group,{interjection_enabled:gs.interjection_enabled});if(!group.interjection_enabled)return;
        appendFields(box,group,{threshold_override:gs.threshold_override,decision_mode:gs.decision_mode},[],false);
        const thresholdRow=box.querySelector('[aria-label="阈值覆盖"]')?.closest('.field');if(thresholdRow){const hint=el('div',undefined,'effective');hint.dataset.path='["interjection","threshold"]';hint._obj=group;hint._key='threshold_override';thresholdRow.querySelector('.control').append(hint);}
        const modeRow=box.querySelector('[aria-label="本组判断模式"]')?.closest('.field');if(modeRow){const hint=el('div',undefined,'effective');hint.dataset.path='["interjection","decision","mode"]';hint._obj=group;hint._key='decision_mode';modeRow.querySelector('.control').append(hint);}
        const over=group.interjection_overrides;for(const [key,meta]of Object.entries(gs.interjection_overrides.items)){const path=key==='activation_prompts'?['activation_prompts']:['interjection',key];const n=field(key,meta,over,path,true);if(n)box.append(n);}
      }else{appendFields(box,state.config.interjection,state.schema.interjection.items,['interjection']);appendFields(box,state.config,{activation_prompts:state.schema.activation_prompts});}
      const explain=section('默认权重与严格阈值','负权重先将该项分数变成 1−原分数，再按绝对权重归一化。最终分等于阈值不触发。默认精力为 0 时，最高分为 0.75，因此暂不插话。');root.append(explain);
    }else if(state.tab==='proactive'||state.tab==='schedule'){
      const isSchedule=state.tab==='schedule',box=section(isSchedule?'作息与时间':'主动聊天',isSchedule?'这里配置已实现的睡眠／正常／活跃时段，不是日历记事本。多个区间用英文逗号分隔；睡眠优先。':'到计划时间才尝试；每日上限只计成功发言的轮次，不等于模型调用次数。');root.append(box);
      if(group){appendFields(box,group,{proactive_enabled:gs.proactive_enabled});if(!group.proactive_enabled)return;}
      const obj=group?group.proactive_overrides:state.config.proactive_chat;
      const metas=group?gs.proactive_overrides.items:state.schema.proactive_chat.items;
      const clocks=['timezone','sleep_hours','active_hours','active_interval_multiplier'];
      appendFields(box,obj,Object.fromEntries(Object.entries(metas).filter(([k])=>isSchedule?clocks.includes(k):!clocks.includes(k))),['proactive_chat'],!!group);
      if(isSchedule){const strip=section('一天的作息');strip.id='schedule-preview';root.append(strip);scheduleStrip();}
    }else{
      const box=section('上下文输入','0 表示全部仍被框架保留的记录；不能找回从未保存或已删除的消息。群媒体通常是文本标记。');root.append(box);
      appendFields(box,group?group.context_overrides:state.config.context,group?gs.context_overrides.items:state.schema.context.items,['context'],!!group);
      if(!group){const diagnostics=section('临时诊断','默认不保留原文。开启后，已登录 Dashboard 的管理者可以查看暂存上下文；不要在共享或不可信的管理界面开启。保存设置会清空旧记录。');appendFields(diagnostics,state.config.diagnostics,state.schema.diagnostics.items,['diagnostics']);root.append(diagnostics);const limits=section('共享运行资源','并发额度属于整个插件，不按会话组重复分配。');appendFields(limits,state.config.runtime,state.schema.runtime.items,['runtime']);root.append(limits);}
    }
  }
  function scheduleStrip(){const box=$('schedule-preview');if(!box||!state.effective)return;box.replaceChildren(el('h2','一天的作息'));
    const cfg=state.effective.proactive_chat;function inside(spec,m){return (spec||'').split(',').filter(Boolean).some(part=>{const [a,b]=part.trim().split('-').map(x=>{const [h,m]=x.split(':').map(Number);return h*60+m;});return a===b||(a<b?m>=a&&m<b:m>=a||m<b);});}
    try{const bar=el('div',undefined,'timebar');for(let m=0;m<1440;m+=15){const kind=inside(cfg.sleep_hours,m)?'sleep':inside(cfg.active_hours,m)?'active':'normal';const block=el('span',undefined,kind);block.title=`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')} · ${kind==='sleep'?'睡眠':kind==='active'?'活跃':'正常'}`;bar.append(block);}box.append(bar);const hours=el('div',undefined,'hours');['00:00','06:00','12:00','18:00','24:00'].forEach(x=>hours.append(el('span',x)));box.append(hours,el('p',`蓝灰：睡眠；青绿：活跃；浅灰：正常。时区：${cfg.timezone||'跟随框架'}。活跃间隔约 ${Math.round(cfg.min_interval_minutes*cfg.active_interval_multiplier*10)/10}～${Math.round(cfg.max_interval_minutes*cfg.active_interval_multiplier*10)/10} 分钟。`,'hint'));}catch{box.append(el('p','时间格式暂不正确，请修正后预览。','err'));}
  }
  function renderTraces(root){
    const intro=section('沿着一次决策往下看','输入、判断、算分、Agent 与发送分别记录。插件钩子快照不是最终网络报文；原生框架或其他插件可能继续修改请求。');const actions=el('div',undefined,'actions'),refresh=el('button','刷新记录'),clear=el('button','清空临时记录','danger');refresh.onclick=()=>refreshStatus().catch(fail);clear.onclick=async()=>{if(!confirm('清空本插件暂存的诊断记录？不删除原生聊天历史。'))return;try{await api('clear',{});state.run=null;await refreshStatus();}catch(e){fail(e);}};actions.append(refresh,clear,el('span',state.status?.capture_raw?'原文采集：开启':'原文采集：关闭','tag'));intro.append(actions);root.append(intro);
    const grid=el('div',undefined,'trace-layout'),list=el('section',undefined,'trace-pane'),steps=el('section',undefined,'trace-pane'),detail=el('section',undefined,'trace-pane');steps.id='trace-steps';detail.id='trace-detail';list.append(el('h3','会话与运行记录'));const search=el('input',undefined,'search');search.placeholder='筛选 SID 或运行结果';search.setAttribute('aria-label','筛选运行记录');list.append(search);const results=el('div');list.append(results);
    function drawList(){results.replaceChildren();const runs=(state.status?.runs||[]).filter(r=>(r.sid+' '+r.status).includes(search.value));if(!runs.length)results.append(el('p','暂无匹配记录。收到消息或到达主动时间后会出现。','empty'));runs.forEach(run=>{const b=el('button',`${run.kind} · ${run.status}`,'trace-item'+(state.run?.run_id===run.run_id?' active':''));b.append(el('small',run.sid),el('small',new Date(run.created_at*1000).toLocaleTimeString()));b.onclick=async()=>{try{state.run=await api('trace',undefined,{run_id:run.run_id});state.step=0;drawList();drawTrace();}catch(e){fail(e);}};results.append(b);});}search.oninput=drawList;drawList();grid.append(list,steps,detail);root.append(grid);drawTrace();
  }
  function drawTrace(){const steps=$('trace-steps'),detail=$('trace-detail');if(!steps)return;steps.replaceChildren(el('h3','决策步骤'));detail.replaceChildren(el('h3','输入与输出'));if(!state.run){steps.append(el('p','选择左侧的一次运行。','empty'));return;}
    if(state.run.steps_omitted)steps.append(el('p',`还有 ${state.run.steps_omitted} 个步骤超过单轮 100 步诊断上限，未记录。`,'hint'));
    state.run.steps.forEach((step,index)=>{const b=el('button',undefined,'step'+(state.step===index?' active':''));b.append(el('span',String(index+1).padStart(2,'0'),'number'),el('span',step.label));b.onclick=()=>{state.step=index;drawTrace();};steps.append(b);});
    const step=state.run.steps[state.step];if(!step){detail.append(el('p','本次没有保留步骤。','empty'));return;}detail.append(el('p',step.label),el('small',`${new Date(step.at*1000).toLocaleString()} · ${step.state}`));
    if(step.data?.score?.final!==undefined){const score=step.data.score;const result=el('section',undefined,'section');result.append(el('h3',`最终分 ${Number(score.final).toFixed(4)} ${step.data.triggered?'>':'≤'} 阈值 ${step.data.threshold}`));const table=el('table');const head=el('tr');['因子','原始分','权重','有效分'].forEach(x=>head.append(el('th',x)));table.append(head);[['model','模型'],['activity','群活跃'],['energy','精力']].forEach(([key,label])=>{const row=el('tr');[label,score[key],score.weights?.[key],score.effective?.[key]].forEach(x=>row.append(el('td',typeof x==='number'?Number(x.toFixed(4)).toString():String(x))));table.append(row);});result.append(table,el('p',step.data.triggered?'本次超过阈值，进入原生 Agent。':'本次未严格超过阈值，不插话。','hint'));detail.append(result);}
    if(step.data!==undefined){const copy=el('button','复制本步 JSON');copy.onclick=async()=>{try{await navigator.clipboard.writeText(JSON.stringify(step.data,null,2));notice('已复制本步数据，请注意其中可能含私聊信息。');}catch{notice('浏览器未允许复制，可在下方选择文本。');}};const actions=el('div',undefined,'actions');actions.append(copy);detail.append(actions);detail.append(el('pre',JSON.stringify(step.data,null,2)));}
    else detail.append(el('p',`${step.state}。${step.bytes?`原数据约 ${step.bytes} 字节。`:''}页面不会用摘要冒充全文。`,'empty'));
  }
  async function refreshStatus(){state.status=await api('status');if(['overview','traces'].includes(state.tab))render();}
  async function reload(){if(state.dirty&&!confirm('放弃未保存的草稿并重新载入？'))return;notice('');const data=await api('bootstrap');Object.assign(state,{config:data.config,schema:data.schema,revision:data.revision,providers:data.providers,dirty:false,effective:null});$('save').disabled=true;state.savedEndpoint=state.config.interjection.decision.jev_endpoint;state.savedCapture=state.config.diagnostics.capture_raw;await refreshStatus();render();}
  $('reload').onclick=()=>reload().catch(fail);
  $('save').onclick=async()=>{try{
    if(!confirm('保存并生效？当前等待中的判断会取消，主动时间会重新安排，临时诊断记录会清空；发送计数保留。'))return;
    const endpoint=state.config.interjection.decision.jev_endpoint;
    if(endpoint!==state.savedEndpoint&&!confirm(`接口地址将设为 ${endpoint}。Jev 模式会向该地址发送 Key 和上下文，确认可信？`))return;
    if(state.config.diagnostics.capture_raw&&!state.savedCapture&&!confirm('开启后，管理界面可查看临时原始上下文。确认开启？'))return;
    const result=await api('settings',{config:state.config,revision:state.revision});state.config=result.config;state.revision=result.revision;state.savedEndpoint=endpoint;state.savedCapture=state.config.diagnostics.capture_raw;state.dirty=false;$('save').disabled=true;notice('配置已保存并生效。已有发送计数保留，下一次主动时间将重新安排。');state.effective=null;render();await refreshStatus();
  }catch(error){fail(error);if(error.details?.errors)notice(error.message+'\n'+JSON.stringify(error.details.errors,null,2));}};
  async function init(){bridge=window.AstrBotPluginView||window.AstrBotPluginPage;if(!bridge){notice('未检测到 AstrBot 页面接口。请从 Dashboard 的插件页面入口打开；直接打开 HTML 不会连接真实插件。');return;}
    const ctx=await bridge.ready();latestTheme=typeof ctx.isDark==='boolean'?ctx.isDark:matchMedia('(prefers-color-scheme:dark)').matches;
    const callback=ctx=>{if(typeof ctx.isDark==='boolean')latestTheme=ctx.isDark;theme();};if(bridge.onContext)bridge.onContext(callback);else if(bridge.onContextChange)bridge.onContextChange(callback);
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change',event=>{if(typeof bridge.getContext?.()?.isDark!=='boolean'){latestTheme=event.matches;theme();}});theme();await reload();state.savedEndpoint=state.config.interjection.decision.jev_endpoint;state.savedCapture=state.config.diagnostics.capture_raw;
    setInterval(()=>{if(state.live&&!document.hidden&&!state.dirty&&state.tab==='overview')refreshStatus().catch(fail);},5000);
  }
  window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
  init().catch(fail);
})();
