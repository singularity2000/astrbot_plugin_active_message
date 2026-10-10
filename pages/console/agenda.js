/* Schedule editor and read-only calendar. Dates/recurrence are evaluated by Python, not reimplemented here. */
(() => {
  'use strict';
  const {node:el,dialog,help,helpNote}=window.ActiveMessageUI;
  const weekdays=['周一','周二','周三','周四','周五','周六','周日'];
  const clone=v=>JSON.parse(JSON.stringify(v));
  const shortTime=value=>value?.slice(11,16)||'';
  const timeText=row=>row.all_day?'全天':shortTime(row.start)+'–'+shortTime(row.end)+(row.start.slice(0,10)!==row.end.slice(0,10)?'（跨日）':'');
  const shortHint=text=>{const value=String(text||'').replace(/\s+/g,' ').trim();const first=value.split(/[。！？]/)[0];return (first||value).slice(0,88)+(first&&first.length>88?'…':'');};

  function newId(){const bytes=new Uint8Array(12);crypto.getRandomValues(bytes);return 'event_'+Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');}
  window.createAgendaUI=({state,dirty,render,previewSoon,field,section})=>{
    let group=null,calendar=null,selected='';
    function globalItems(){return state.config.agenda.events.filter(e=>!e.group_id);}
    function items(){return state.config.agenda.events;}
    function hasId(id,except){return state.config.agenda.events.some(e=>e!==except&&e.id===id);}
    function freshId(){let id;do{id=newId();}while(hasId(id)||state.config.session_groups.some(g=>g.agenda_id===id));return id;}
    function mark(){dirty();render();}
    function monthMove(delta){
      const [y,m]=(state.calendarMonth||calendar?.month).split('-').map(Number),d=new Date(Date.UTC(y,m-1+delta,1));
      if(d.getUTCFullYear()<1900||d.getUTCFullYear()>2199)return;
      state.calendarMonth=d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');state.previewSeq++;selected='';previewSoon();
      const heading=document.getElementById('calendar-heading');if(heading)heading.textContent=state.calendarMonth+' · 计算中…';
    }
    async function edit(original=null){
      const fields=state.schema.agenda.items.events.templates.event.items;
      const draft=original?clone(original):Object.fromEntries(Object.entries(fields).map(([k,m])=>[k,clone(m.default)]));
      if(!original){draft.id=freshId();draft.start_date=calendar?.today||new Date().toLocaleDateString('sv-SE');draft.weekdays=[weekdays[(new Date(draft.start_date+'T12:00:00').getDay()+6)%7]];}
      else if(typeof draft.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(draft.id)||hasId(draft.id,original))draft.id=freshId();
      draft.__template_key='event';
      const ownerId=group?(group.agenda_id||freshId()):'';draft.group_id=ownerId;
      const form=el('div',undefined,'agenda-editor'),error=el('p',undefined,'warning');error.hidden=true;
      const inputs={};
      function control(key,type=null){
        const meta=fields[key],wrap=el('div',undefined,'agenda-editor-field');wrap.dataset.eventField=key;
        const label=el('label',meta.description),id='agenda-'+key;label.htmlFor=id;let input;
        if(meta.options){input=el('select');meta.options.forEach(value=>input.add(new Option(value,value)));}
        else{input=el(meta.type==='text'?'textarea':'input');if(input.tagName==='INPUT')input.type=meta.type==='bool'?'checkbox':type||'text';}
        input.id=id;input.setAttribute('aria-label',meta.description);
        if(input.type==='checkbox')input.checked=!!draft[key];else input.value=draft[key];
        if(['start_date','until'].includes(key)){input.min='1900-01-01';input.max='2199-12-31';}
        if(key==='title')input.maxLength=80;if(key==='description')input.maxLength=1000;if(key==='cron')input.maxLength=160;
        if(key==='cron_duration_minutes'){input.min=1;input.max=1440;input.step=1;}
        input.oninput=()=>{draft[key]=input.type==='checkbox'?input.checked:meta.type==='int'?(input.value===''?'':Number(input.value)):input.value;};
        input.onchange=()=>{input.oninput();if(key==='repeat'&&draft.repeat==='Cron'){draft.time_mode='时段';inputs.time_mode.value='时段';}visibility();};
        inputs[key]=input;const heading=el('div',undefined,'help-label');heading.append(label);if(meta.hint){heading.append(help(meta.description,meta.hint,id+'-hint'));input.setAttribute('aria-describedby',id+'-hint');heading.append(el('small',shortHint(meta.hint),'field-hint'));}wrap.append(heading,input);form.append(wrap);return wrap;
      }
      control('title');
      const scopeField=el('div',undefined,'agenda-editor-field'),scopeLabel=el('label','日程适用范围'),scopeSelect=el('select');scopeLabel.htmlFor='agenda-scope';scopeSelect.id='agenda-scope';scopeSelect.setAttribute('aria-label','日程适用范围');scopeSelect.add(new Option('全局：适用会话（可在组内排除）','global'));
      state.config.session_groups.forEach((g,i)=>scopeSelect.add(new Option((i+1)+'. '+g.name,String(i))));scopeSelect.value=group?String(state.config.session_groups.indexOf(group)):'global';
      const scopeHeading=el('div',undefined,'help-label');scopeHeading.append(scopeLabel,help('日程适用范围','默认使用页面顶部的范围。全局日程可供插件生效范围内的会话使用；各组可单独排除不需要的日程。'),el('small','全局日程可供生效范围内的会话使用，各组可单独排除。','field-hint'));scopeField.append(scopeHeading,scopeSelect);form.append(scopeField);
      control('enabled');
      control('start_date','date');control('until','date');control('repeat');control('time_mode');
      control('start_time','time');control('end_time','time');
      const weekly=el('fieldset',undefined,'agenda-editor-field weekday-picker');weekly.dataset.eventField='weekdays';const weeklyLegend=el('legend','每周哪些天');weeklyLegend.append(help('每周哪些天',fields.weekdays.hint),el('small','仅选择“每周”时使用，可多选。','field-hint'));weekly.append(weeklyLegend);
      weekdays.forEach(day=>{const label=el('label'),input=el('input');input.type='checkbox';input.checked=draft.weekdays.includes(day);input.setAttribute('aria-label',day);input.onchange=()=>{draft.weekdays=weekdays.filter(d=>d===day?input.checked:draft.weekdays.includes(d));};label.append(input,el('span',day));weekly.append(label);});form.append(weekly);
      control('cron');control('cron_duration_minutes','number');control('description');control('pause_interjection');control('pause_proactive');form.append(error);
      function visibility(){
        for(const key of ['start_time','end_time'])form.querySelector('[data-event-field="'+key+'"]').hidden=draft.time_mode!=='时段'||draft.repeat==='Cron';
        weekly.hidden=draft.repeat!=='每周';inputs.time_mode.disabled=draft.repeat==='Cron';
        for(const key of ['cron','cron_duration_minutes'])form.querySelector('[data-event-field="'+key+'"]').hidden=draft.repeat!=='Cron';
        form.querySelector('[data-event-field="until"]').hidden=draft.repeat==='不重复';
      }
      visibility();
      function validate(){
        let message='';
        if(!draft.title.trim())message='请填写日程名称。';
        else if(!/^[A-Za-z0-9_-]{1,80}$/.test(draft.id)||hasId(draft.id,original))message='日程关联信息异常，请关闭窗口后重新打开。';
        else if(!inputs.start_date.validity.valid||!draft.start_date||(draft.repeat!=='不重复'&&(!inputs.until.validity.valid||(draft.until&&draft.until<draft.start_date))))message='请检查开始日期和截止日期。';
        else if(draft.repeat==='每周'&&!draft.weekdays.length)message='每周重复至少选择一天。';
        else if(draft.repeat==='Cron'&&(draft.cron.trim().split(/\s+/).length!==5||!Number.isInteger(draft.cron_duration_minutes)||draft.cron_duration_minutes<1||draft.cron_duration_minutes>1440))message='Cron 需要五段表达式，并填写 1～1440 的持续分钟。';
        else if(draft.repeat!=='Cron'&&draft.time_mode==='时段'&&(!draft.start_time||!draft.end_time||draft.start_time===draft.end_time))message='请填写不同的起止时间；结束早于开始时跨午夜。';
        error.textContent=message;error.hidden=!message;if(message)error.scrollIntoView({block:'nearest'});return !message;
      }
      if(!await dialog({title:original?'编辑日程':'添加日程',message:'只修改草稿，点击页面右上角“保存并生效”后才用于运行。不会创建未来任务。',content:form,confirm:'加入页面草稿',validate}))return;
      const list=items();
      if(scopeSelect.value==='global')draft.group_id='';else{const owner=state.config.session_groups[Number(scopeSelect.value)];owner.agenda_id||=(owner===group?ownerId:freshId());draft.group_id=owner.agenda_id;}
      if(original){const index=list.indexOf(original);if(index<0)return;if(!original.group_id)state.config.session_groups.forEach(g=>{g.agenda_exclusions=draft.group_id?g.agenda_exclusions.filter(id=>id!==original.id):g.agenda_exclusions.map(id=>id===original.id?draft.id:id);});list[index]=draft;}
      else list.push(draft);
      mark();
    }
    function describe(event){
      const repeat=event.repeat==='每周'?'每周 '+event.weekdays.join('、'):event.repeat==='Cron'?'Cron '+event.cron:event.repeat;
      const clock=event.repeat==='Cron'?'每次 '+event.cron_duration_minutes+' 分钟':event.time_mode==='全天'?'全天':event.start_time+'–'+event.end_time+(event.end_time<event.start_time?'（次日结束）':'');
      return event.start_date+' 起 · '+repeat+' · '+clock+(event.until&&event.repeat!=='不重复'?' · 截止 '+event.until:'');
    }
    function renderList(box){
      const rows=[...globalItems().map(event=>({event,inherited:!!group})),...(group?state.config.agenda.events.filter(e=>group.agenda_id&&e.group_id===group.agenda_id).map(event=>({event,inherited:false})):[])];
      if(rows.length){
        const list=el('div',undefined,'agenda-list');
        for(const {event,inherited} of rows){
          const excluded=inherited&&group.agenda_exclusions.includes(event.id),row=el('article',undefined,'agenda-row');if(excluded||!event.enabled)row.classList.add('agenda-muted');
          const info=el('div',undefined,'agenda-row-info'),heading=el('div',undefined,'agenda-row-heading');heading.append(el('strong',event.title||'未命名日程'),el('span',inherited?'来自全局':group?'本组新增':'全局','tag'));
          if(excluded)heading.append(el('span','本组已排除','tag'));if(!event.enabled)heading.append(el('span','未启用','tag'));
          info.append(heading,el('small',describe(event)));const effects=[];if(event.pause_interjection)effects.push('暂停插话');if(event.pause_proactive)effects.push('暂停主动聊天');info.append(el('small',effects.length?effects.join(' · '):'仅让机器人知道，不改变主动行为'));if(event.description)info.append(el('p',event.description,'agenda-description'));
          const actions=el('div',undefined,'agenda-row-actions');
          if(inherited){const toggle=el('button',excluded?'恢复继承':'本组排除');toggle.onclick=()=>{group.agenda_exclusions=excluded?group.agenda_exclusions.filter(id=>id!==event.id):[...group.agenda_exclusions,event.id];mark();};actions.append(toggle);}
          else{const editButton=el('button','编辑'),remove=el('button','删除','danger');editButton.onclick=()=>edit(event);remove.onclick=async()=>{if(await dialog({title:'删除这条日程？',message:'只删除插件日程，不操作任何原生未来任务。保存后生效。',confirm:'删除',danger:true})){const list=items(),index=list.indexOf(event);if(index>=0)list.splice(index,1);if(!group)state.config.session_groups.forEach(g=>{g.agenda_exclusions=g.agenda_exclusions.filter(id=>id!==event.id);});mark();}};actions.append(editButton,remove);}
          row.append(info,actions);list.append(row);
        }box.append(list);
      }
      if(!group){
        const orphaned=state.config.agenda.events.filter(e=>e.group_id&&!state.config.session_groups.some(g=>g.agenda_id===e.group_id));
        if(orphaned.length){
          box.append(el('p',orphaned.length+' 条日程找不到会话组，不会自动退回全局。请重新关联或删除。','warning'));
          for(const event of orphaned){
            const row=el('div',undefined,'agenda-row'),actions=el('div',undefined,'agenda-row-actions');row.append(el('span',(event.title||'未命名日程')+' · 原会话组已删除或不存在'));
            const repair=el('button','重新关联'),remove=el('button','删除','danger');
            repair.onclick=async()=>{const select=el('select');select.setAttribute('aria-label','重新关联到哪个范围');select.add(new Option('请选择适用范围',''));select.add(new Option('全局：适用会话（可在组内排除）','global'));state.config.session_groups.forEach((g,i)=>select.add(new Option((i+1)+'. '+g.name,String(i))));
              if(await dialog({title:'重新关联日程',message:'明确选择范围后才会重新生效。选择全局会让继承它的会话都能看到这条日程。',content:select,confirm:'加入页面草稿',validate:()=>!!select.value})){
                if(select.value==='global')event.group_id='';else{const owner=state.config.session_groups[Number(select.value)];owner.agenda_id||=freshId();event.group_id=owner.agenda_id;}mark();
              }
            };
            remove.onclick=async()=>{if(await dialog({title:'删除这条未关联日程？',message:'只修改插件配置草稿，不影响原生未来任务。',confirm:'删除',danger:true})){state.config.agenda.events=state.config.agenda.events.filter(e=>e!==event);mark();}};actions.append(repair,remove);row.append(actions);box.append(row);
          }
        }
      }
      if(!rows.length)box.append(el('p','还没有日程。先添加一条，例如每周一至周五的午休。','empty'));
      if(group){const missing=group.agenda_exclusions.filter(id=>!globalItems().some(e=>e.id===id));if(missing.length){const note=el('p',missing.length+' 条已排除日程不存在，可清理这些失效选择。','warning'),clear=el('button','清理无效排除');clear.onclick=()=>{group.agenda_exclusions=group.agenda_exclusions.filter(id=>!missing.includes(id));mark();};box.append(note,clear);}}
    }
    function drawCalendar(){
      const box=document.getElementById('agenda-calendar');if(!box||!calendar)return;
      box.replaceChildren();
      const toolbar=el('div',undefined,'calendar-toolbar'),prev=el('button','‹ 上月'),next=el('button','下月 ›'),today=el('button','今天'),heading=el('h3',calendar.month);heading.id='calendar-heading';
      prev.onclick=()=>monthMove(-1);next.onclick=()=>monthMove(1);today.onclick=()=>{state.calendarMonth='';selected='';state.previewSeq++;previewSoon();};
      const monthPicker=el('input');monthPicker.type='month';monthPicker.min='1900-01';monthPicker.max='2199-12';monthPicker.value=calendar.month;monthPicker.setAttribute('aria-label','跳转日历月份');monthPicker.className='calendar-month-picker';monthPicker.onchange=()=>{if(!monthPicker.value||!monthPicker.validity.valid)return;state.calendarMonth=monthPicker.value;state.previewSeq++;selected='';heading.textContent=state.calendarMonth+' · 计算中…';previewSoon();};
      toolbar.append(heading,monthPicker,prev,today,next);box.append(toolbar,el('p','日历预览 · '+calendar.timezone+' · '+(calendar.enabled?'日程意识已开启':'日程意识未开启，以下仅预览配置'),'muted'));
      if(calendar.errors?.length){box.append(el('p','日程配置尚有错误，修正后才会计算日历。','warning'));return;}
      const grid=el('div',undefined,'calendar-grid');grid.setAttribute('aria-label',calendar.month+' 日历，周一至周日');
      weekdays.forEach(day=>grid.append(el('div',day,'calendar-weekday')));
      if(!calendar.days.some(d=>d.date===selected))selected=calendar.today.startsWith(calendar.month)?calendar.today:calendar.month+'-01';
      for(const day of calendar.days){
        const cell=el('button',undefined,'calendar-day');if(!day.date.startsWith(calendar.month))cell.classList.add('outside-month');if(day.date===calendar.today)cell.classList.add('is-today');if(day.date===selected)cell.classList.add('selected');cell.setAttribute('aria-pressed',String(day.date===selected));
        const visible=day.events;cell.setAttribute('aria-label',day.date+'，'+visible.length+' 项日程');cell.append(el('span',String(Number(day.date.slice(8))),'calendar-date'));
        visible.slice(0,3).forEach(e=>{const label=el('span',e.title,'calendar-event');label.title=e.origin+' · '+e.title+' · '+timeText(e);cell.append(label);});
        if(visible.length>3)cell.append(el('small','另有 '+(visible.length-3)+' 项'));
        cell.onclick=()=>{selected=day.date;drawCalendar();};grid.append(cell);
      }
      box.append(grid,helpNote('日历时区说明',calendar.timezone_note));
      const detail=el('div',undefined,'calendar-details');detail.append(el('h3',selected+' 的日程'));
      const rows=calendar.days.find(d=>d.date===selected)?.events||[];
      if(!rows.length)detail.append(el('p','当天没有适用的日程。','muted'));
      for(const row of rows){const card=el('article',undefined,'calendar-detail');card.append(el('strong',row.title),el('span',row.origin,'tag'));card.append(el('p',(row.all_day?'全天':row.times.map(t=>timeText(t)+(t.start.slice(0,10)<selected?'（'+t.start.slice(5,10)+' 开始，延续至当天）':'')).join('；'))+(row.more?'；当天还有更多轮次（仅展示前三次）':'')));
        const source=state.config.agenda.events.find(e=>e.id===row.id);if(source?.description)card.append(el('p',source.description,'agenda-description'));
        card.append(el('small',[row.pause_interjection?'暂停智能插话':'',row.pause_proactive?'暂停主动聊天':''].filter(Boolean).join(' · ')||'只提供日程背景，不改变主动行为'));detail.append(card);}
      box.append(detail);
      const status=document.getElementById('agenda-now');if(status){status.replaceChildren();status.append(el('strong','日程状态预览 · '+shortTime(calendar.snapshot.now)));if(!state.config.enabled)status.append(el('p','插件总开关已关闭；以下只预览规则，不代表实际已运行。','muted'));const current=calendar.snapshot.current;if(!calendar.enabled)status.append(el('p','日程意识已关闭：机器人不会收到日程背景，日程里的暂停规则也不生效。'));else if(!current.length)status.append(el('p','现在没有正在进行的日程。'));else current.forEach(row=>status.append(el('p',row.title+' · '+timeText(row)+' · '+([row.pause_interjection?'暂停插话':'',row.pause_proactive?'暂停主动聊天':''].filter(Boolean).join('、')||'只提供日程背景'))));if(calendar.snapshot.truncated)status.append(el('small','日程较多时，提供给机器人的当前安排和近日安排各最多十二项；暂停插话或主动聊天的规则仍会检查全部日程。'));}
    }
    return {
      render(root,selectedGroup){
        group=selectedGroup;calendar=null;
        const gs=state.schema.session_groups.templates.group.items,box=section('日程管理','机器人午休、群里聚餐、私聊约定，都在这里添加。写清楚是谁的安排，机器人回复时就能参考；也可在日程期间暂停智能插话或主动聊天。这不是定时提醒；需要准时提醒时，请使用 AstrBot 的原生未来任务。');box.id='agenda-settings';
        box.append(group?field('agenda_mode',gs.agenda_mode,group,['agenda','enabled'],true):field('enabled',state.schema.agenda.items.enabled,state.config.agenda,['agenda','enabled']));
        const actions=el('div',undefined,'actions'),add=el('button',group?'添加本组日程':'添加全局日程','primary');add.onclick=()=>edit();actions.append(add);box.append(actions);
        if(group)box.append(el('small','本组日历 = 全局日程 + 本组新增 − 本组排除。编辑全局日程请切换到全局设置。','muted'));
        renderList(box);root.append(box);const current=el('div',undefined,'agenda-now');current.id='agenda-now';current.append(el('p','正在计算当前日程…'));root.append(current);
        const month=section('日历预览','按当前草稿显示日程，点击日期查看详情；不能直接在日历中改日程。请在上方列表中编辑，检查无误后点击“保存并生效”。');month.id='agenda-calendar';month.append(el('p','正在计算日历…','muted'));root.append(month);
      },
      update(data){calendar=data;state.calendarMonth=data.month;drawCalendar();}
    };
  };
})();
