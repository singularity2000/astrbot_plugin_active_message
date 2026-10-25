/* Schedule editor and read-only calendar. Dates/recurrence are evaluated by Python, not reimplemented here. */
(() => {
  'use strict';
  const {t,runtime:R,value:V}=window.ActiveMessageI18n;
  const {node:el,dialog,help,helpNote,preserveView,sessionLabel:S,sessionText:ST,sessionReferences:SR}=window.ActiveMessageUI;
  const weekdays=['周一','周二','周三','周四','周五','周六','周日'];
  const clone=v=>JSON.parse(JSON.stringify(v));
  const shortTime=value=>value?.slice(11,16)||'';
  const timeText=row=>row.all_day?V('全天'):shortTime(row.start)+'–'+shortTime(row.end)+(row.start.slice(0,10)!==row.end.slice(0,10)?t("pages.console.ui.s9e0f835af4"):'');
  const shortHint=text=>{const value=String(text||'').replace(/\s+/g,' ').trim();const first=value.split(/[。！？]/)[0];return (first||value).slice(0,88)+(first&&first.length>88?'…':'');};

  function newId(){const bytes=new Uint8Array(12);crypto.getRandomValues(bytes);return 'event_'+Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');}
  window.createAgendaUI=({state,render,previewSoon,field,section,persistPrefs,saveAgenda,refreshAgenda,fail})=>{
    let group=null,calendar=null,selected='',injection=null,injectionSid=null,injectionDraft=null,injectionScope='';
    const listUI=window.createAgendaListUI({state,edit,describe,saveAgenda,refreshAgenda,fail,previewSoon,persistPrefs});
    function globalItems(){return state.config.agenda.events.filter(e=>!e.group_id&&!e.target_sids?.length);}
    function hasId(id,except){return state.config.agenda.events.some(e=>e.id===id&&e.id!==except?.id);}
    function freshId(){let id;do{id=newId();}while(hasId(id)||state.config.session_groups.some(g=>g.agenda_id===id));return id;}
    function monthMove(delta){
      const [y,m]=(state.calendarMonth||calendar?.month).split('-').map(Number),d=new Date(Date.UTC(y,m-1+delta,1));
      if(d.getUTCFullYear()<1900||d.getUTCFullYear()>2199)return;
      state.calendarMonth=d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');state.previewSeq++;selected='';previewSoon();
      const heading=document.getElementById('calendar-heading');if(heading)heading.textContent=state.calendarMonth+t("pages.console.ui.sb44e425e82");
    }
    async function edit(original=null){
      const revision=state.agendaRevision;
      const fields=state.schema.agenda.items.events.templates.event.items;
      const draft=original?clone(original):Object.fromEntries(Object.entries(fields).map(([k,m])=>[k,clone(m.default)]));
      if(!original){draft.id=freshId();draft.start_date=calendar?.today||new Date().toLocaleDateString('sv-SE');draft.weekdays=[weekdays[(new Date(draft.start_date+'T12:00:00').getDay()+6)%7]];}
      else if(typeof draft.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(draft.id)||hasId(draft.id,original))draft.id=freshId();
      draft.__template_key='event';
      const ownerId=group?.agenda_id||'';if(!original)draft.group_id=ownerId;
      const form=el('div',undefined,'agenda-editor'),error=el('p',undefined,'warning');error.hidden=true;
      const inputs={};
      function control(key,type=null){
        const meta=fields[key],wrap=el('div',undefined,'agenda-editor-field');wrap.dataset.eventField=key;
        const label=el('label',meta.description),id='agenda-'+key;label.htmlFor=id;let input;
        if(meta.options){input=el('select');meta.options.forEach((value,index)=>input.add(new Option(meta.labels?.[index]||V(value),value)));}
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
      const scopeField=el('div',undefined,'agenda-editor-field'),scopeLabel=el('label',t("pages.console.ui.s2fc4bfb9c4")),scopeSelect=el('select');scopeLabel.htmlFor='agenda-scope';scopeSelect.id='agenda-scope';scopeSelect.setAttribute('aria-label',t("pages.console.ui.s2fc4bfb9c4"));scopeSelect.add(new Option(t("pages.console.ui.s8e90eb10aa"),'global'));
      state.saved.session_groups.forEach((g,i)=>scopeSelect.add(new Option((i+1)+'. '+g.group_name,String(i))));const originalOwner=state.saved.session_groups.findIndex(g=>g.agenda_id===draft.group_id);scopeSelect.value=draft.group_id&&originalOwner>=0?String(originalOwner):'global';
      const scopeHeading=el('div',undefined,'help-label');scopeHeading.append(scopeLabel,help(t("pages.console.ui.s2fc4bfb9c4"),t("pages.console.ui.s682cd9abc9")),el('small',t("pages.console.ui.s358202994a"),'field-hint'));scopeField.append(scopeHeading,scopeSelect);form.append(scopeField);
      const sidField=el('div',undefined,'agenda-editor-field agenda-sids'),sidLabel=el('label',t("pages.console.ui.sb3c0d83186")),sidInput=el('textarea');sidInput.id='agenda-target-sids';sidInput.rows=3;sidInput.value=(draft.target_sids||[]).join('\n');sidInput.placeholder=t("pages.console.ui.s5d155e30e5");sidLabel.htmlFor=sidInput.id;
      const sidNames=el('small',SR(sidInput.value),'session-name-reference');sidInput.oninput=()=>{sidNames.textContent=SR(sidInput.value);};
      sidField.append(sidLabel,sidInput,sidNames,el('small',t("pages.console.ui.s0f68b508e4"),'field-hint'));form.append(sidField);
      control('enabled');
      control('start_date','date');control('until','date');control('repeat');control('time_mode');
      control('start_time','time');control('end_time','time');
      const weekly=el('fieldset',undefined,'agenda-editor-field weekday-picker');weekly.dataset.eventField='weekdays';const weeklyLegend=el('legend',t("pages.console.ui.s38ef329cac"));weeklyLegend.append(help(t("pages.console.ui.s38ef329cac"),fields.weekdays.hint),el('small',t("pages.console.ui.s067ca6e19d"),'field-hint'));weekly.append(weeklyLegend);
      weekdays.forEach(day=>{const label=el('label'),input=el('input');input.type='checkbox';input.checked=draft.weekdays.includes(day);input.setAttribute('aria-label',V(day));input.onchange=()=>{draft.weekdays=weekdays.filter(d=>d===day?input.checked:draft.weekdays.includes(d));};label.append(input,el('span',V(day)));weekly.append(label);});form.append(weekly);
      control('cron');control('cron_duration_minutes','number');control('description');control('pause_interjection');control('pause_proactive');form.append(error);
      function visibility(){
        sidField.hidden=scopeSelect.value!=='global';sidInput.disabled=!state.saved.agenda.outside_scope||scopeSelect.value!=='global';
        for(const key of ['start_time','end_time'])form.querySelector('[data-event-field="'+key+'"]').hidden=draft.time_mode!=='时段'||draft.repeat==='Cron';
        weekly.hidden=draft.repeat!=='每周';inputs.time_mode.disabled=draft.repeat==='Cron';
        for(const key of ['cron','cron_duration_minutes'])form.querySelector('[data-event-field="'+key+'"]').hidden=draft.repeat!=='Cron';
        form.querySelector('[data-event-field="until"]').hidden=draft.repeat==='不重复';
      }
      scopeSelect.onchange=visibility;
      visibility();
      function validate(){
        let message='';
        if(!draft.title.trim())message=t("pages.console.ui.safef6fbc1f");
        else if(!/^[A-Za-z0-9_-]{1,80}$/.test(draft.id)||hasId(draft.id,original))message=t("pages.console.ui.sc70607a5de");
        else if(!inputs.start_date.validity.valid||!draft.start_date||(draft.repeat!=='不重复'&&(!inputs.until.validity.valid||(draft.until&&draft.until<draft.start_date))))message=t("pages.console.ui.s59d58025d2");
        else if(draft.repeat==='每周'&&!draft.weekdays.length)message=t("pages.console.ui.sdd91f8b660");
        else if(draft.repeat==='Cron'&&(draft.cron.trim().split(/\s+/).length!==5||!Number.isInteger(draft.cron_duration_minutes)||draft.cron_duration_minutes<1||draft.cron_duration_minutes>1440))message=t("pages.console.ui.s110abf53db");
        else if(draft.repeat!=='Cron'&&draft.time_mode==='时段'&&(!draft.start_time||!draft.end_time||draft.start_time===draft.end_time))message=t("pages.console.ui.s252bd170c2");
        if(!message&&scopeSelect.value==='global'&&!sidInput.disabled){const sids=sidInput.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(sids.some(s=>!/^([^:]+):(GroupMessage|FriendMessage):(.+)$/.test(s)))message=t("pages.console.ui.s9a366aad61");else if(new Set(sids).size!==sids.length)message=t("pages.console.ui.s86b5094b30");else draft.target_sids=sids;}
        error.textContent=message;error.hidden=!message;if(message)error.scrollIntoView({block:'nearest'});return !message;
      }
      await dialog({title:original?t("pages.console.ui.s828694045f"):t("pages.console.ui.sbccfe76f69"),message:t("pages.console.ui.s17bac77310"),content:form,confirm:t("pages.console.ui.sc4487483b2"),validate,submit:async()=>{
        if(scopeSelect.value==='global')draft.group_id='';else{draft.group_id=state.saved.session_groups[Number(scopeSelect.value)].agenda_id;draft.target_sids=[];}
        await saveAgenda({action:'upsert',event:clone(draft),original_id:original?.id??null},revision);
      }});
    }
    function describe(event){
      const repeat=event.repeat==='每周'?t("pages.console.ui.sf4769eab79")+event.weekdays.map(V).join(', '):event.repeat==='Cron'?'Cron '+event.cron:V(event.repeat);
      const clock=event.repeat==='Cron'?t("pages.console.ui.sfe8167d5a5")+event.cron_duration_minutes+t("pages.console.ui.s5b0acd185d"):event.time_mode==='全天'?V('全天'):event.start_time+'–'+event.end_time+(event.end_time<event.start_time?t("pages.console.ui.se525bbc5cc"):'');
      return event.start_date+(event.repeat==='不重复'?' · ':t("pages.console.ui.s8c221140c6")+repeat+' · ')+clock+(event.until&&event.repeat!=='不重复'?t("pages.console.ui.sc12174659c")+event.until:'');
    }
    function renderList(box){
      const browser=el('div',undefined,'agenda-browser');browser.id='agenda-browser';box.append(browser);listUI.render(browser,group);
      if(!group){
        const orphaned=state.config.agenda.events.filter(e=>e.group_id&&!state.saved.session_groups.some(g=>g.agenda_id===e.group_id));
        if(orphaned.length)box.append(el('p',orphaned.length+t("pages.console.ui.s06f76a7466"),'warning'));
      }
      if(group){const missing=group.agenda_exclusions.filter(id=>!globalItems().some(e=>e.id===id));if(missing.length){const note=el('p',missing.length+t("pages.console.ui.s3e68a9156a"),'warning'),clear=el('button',t("pages.console.ui.s39221fb2ea"));clear.onclick=()=>saveAgenda({action:'clean_exclusions',group_id:group.agenda_id}).catch(fail);box.append(note,clear);}}
    }
    function drawCalendar(){
      const box=document.getElementById('agenda-calendar');if(!box||!calendar)return;
      const restore=preserveView();
      box.replaceChildren();
      const toolbar=el('div',undefined,'calendar-toolbar'),prev=el('button',t("pages.console.ui.sf789ada6e7")),next=el('button',t("pages.console.ui.s5440e4b874")),today=el('button',t("pages.console.ui.s17e83cc25e")),heading=el('h3',calendar.month);heading.id='calendar-heading';
      const sessionPicker=el('select');sessionPicker.className='calendar-session-picker';sessionPicker.setAttribute('aria-label',t("pages.console.ui.s748c5008e4"));sessionPicker.add(new Option(group?t("pages.console.ui.s450c5058e1"):t("pages.console.ui.s7a399b3205"),''));
      const targetSids=[...new Set(state.config.agenda.events.flatMap(e=>e.target_sids||[]))].filter(s=>!group||group.sids.includes(s)||group.sids.includes(s.split(':').slice(2).join(':')));targetSids.forEach(s=>sessionPicker.add(new Option(S(s),s)));sessionPicker.value=state.calendarSid||'';sessionPicker.onchange=()=>{state.calendarSid=sessionPicker.value;state.previewSeq++;previewSoon();};toolbar.append(sessionPicker);
      prev.onclick=()=>monthMove(-1);next.onclick=()=>monthMove(1);today.onclick=()=>{state.calendarMonth='';selected='';state.previewSeq++;previewSoon();};
      const monthPicker=el('input');monthPicker.type='month';monthPicker.min='1900-01';monthPicker.max='2199-12';monthPicker.value=calendar.month;monthPicker.setAttribute('aria-label',t("pages.console.ui.s2c2647d420"));monthPicker.className='calendar-month-picker';monthPicker.onchange=()=>{if(!monthPicker.value||!monthPicker.validity.valid)return;state.calendarMonth=monthPicker.value;state.previewSeq++;selected='';heading.textContent=state.calendarMonth+t("pages.console.ui.sb44e425e82");previewSoon();};
      const navigation=el('div',undefined,'calendar-navigation');navigation.append(prev,today,next);
      toolbar.append(heading,monthPicker,navigation);box.append(toolbar,el('p',t("pages.console.ui.sdbb134a49e")+calendar.timezone+' · '+(calendar.enabled?t("pages.console.ui.s7b2d2ca095"):t("pages.console.ui.s66dcd67009")),'muted'));
      if(calendar.errors?.length){box.append(el('p',t("pages.console.ui.s6b6ab10d76"),'warning'));restore();return;}
      const grid=el('div',undefined,'calendar-grid');grid.setAttribute('aria-label',calendar.month+t("pages.console.ui.sdc6a2f2fff"));
      weekdays.forEach(day=>grid.append(el('div',V(day),'calendar-weekday')));
      if(!calendar.days.some(d=>d.date===selected))selected=calendar.today.startsWith(calendar.month)?calendar.today:calendar.month+'-01';
      for(const day of calendar.days){
        const cell=el('button',undefined,'calendar-day');cell.id='calendar-day-'+day.date;if(!day.date.startsWith(calendar.month))cell.classList.add('outside-month');if(day.date===calendar.today)cell.classList.add('is-today');if(day.date===selected)cell.classList.add('selected');cell.setAttribute('aria-pressed',String(day.date===selected));
        const visible=day.events;cell.setAttribute('aria-label',day.date+'，'+visible.length+t("pages.console.ui.saf693c5c85"));cell.append(el('span',String(Number(day.date.slice(8))),'calendar-date'));
        visible.slice(0,3).forEach(e=>{const label=el('span',e.title,'calendar-event');label.title=e.origin+' · '+e.title+' · '+timeText(e);cell.append(label);});
        if(visible.length>3)cell.append(el('small',t("pages.console.ui.sa298c26e33")+(visible.length-3)+t("pages.console.ui.s12de8e1252")));
        cell.onclick=()=>{selected=day.date;drawCalendar();};grid.append(cell);
      }
      box.append(grid,helpNote(t("pages.console.ui.s36bfa3f645"),calendar.timezone_note));
      const detail=el('div',undefined,'calendar-details');detail.append(el('h3',selected+t("pages.console.ui.sf944ce6285")));
      const rows=calendar.days.find(d=>d.date===selected)?.events||[];
      if(!rows.length)detail.append(el('p',t("pages.console.ui.s55ecd5dcb5"),'muted'));
      for(const row of rows){const card=el('article',undefined,'calendar-detail');card.append(el('strong',row.title),el('span',ST(R(row.origin)),'tag'));card.append(el('p',(row.all_day?V('全天'):row.times.map(occurrence=>timeText(occurrence)+(occurrence.start.slice(0,10)<selected?'('+occurrence.start.slice(5,10)+t("pages.console.ui.s0948f31159"):'')).join('；'))+(row.more?t("pages.console.ui.s6091ddf56e"):'')));
        const source=state.config.agenda.events.find(e=>e.id===row.id);if(source?.description)card.append(el('p',source.description,'agenda-description'));
        const effects=[row.pause_interjection?t("pages.console.ui.s2e10c4f555"):'',row.pause_proactive?t("pages.console.ui.s016ccdd7f6"):''].filter(Boolean);if(effects.length)card.append(el('small',effects.join(' · ')));detail.append(card);}
      box.append(detail);
      restore();
    }
    function drawInjection(){
      const box=document.getElementById('agenda-now');if(!box||!injection)return;
      const scrolls=[...box.querySelectorAll('ul,pre')].map(n=>({id:n.id,top:n.scrollTop,left:n.scrollLeft}));
      const expanded=box.querySelector('#agenda-injection-raw')?.open;
      const pickerWasOpen=box.querySelector('#agenda-injection-sid')?.getAttribute('aria-expanded')==='true';
      box.replaceChildren();box.dataset.reason=injection.reason;
      const head=el('div',undefined,'agenda-context-head'),heading=el('h2',t('pages.console.ui.injection_title'));
      heading.append(help(t('pages.console.ui.injection_title'),t('pages.console.ui.injection_help'),'agenda-injection-help'));
      head.append(heading);if(injection.reason==='select_session')head.append(el('small',t('pages.console.ui.injection_reason_select_session'),'agenda-context-select-hint'));if(injection.now)head.append(el('small',shortTime(injection.now)+' · '+injection.timezone));box.append(head);
      const toolbar=el('div',undefined,'agenda-context-toolbar'),label=el('label',t('pages.console.ui.injection_chat')),picker=el('div',undefined,'agenda-session-picker'),input=el('input'),clear=el('button','×','agenda-session-clear'),options=el('div',undefined,'agenda-session-options');
      input.id='agenda-injection-sid';input.type='text';input.value=injectionDraft??injection.sid;input.placeholder=t('pages.console.ui.injection_sid_placeholder');input.autocomplete='off';input.spellcheck=false;label.htmlFor=input.id;options.id='agenda-injection-options';options.hidden=true;
      clear.id='agenda-injection-clear';clear.type='button';clear.setAttribute('aria-label',t('pages.console.ui.injection_clear'));clear.title=t('pages.console.ui.injection_clear');clear.hidden=!input.value;
      input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',options.id);input.setAttribute('aria-expanded','false');options.setAttribute('role','listbox');options.setAttribute('aria-label',t('pages.console.ui.injection_chat'));
      const change=()=>{const value=input.value.trim();if(value===injectionSid)return;injectionSid=value;state.previewSeq++;box.setAttribute('aria-busy','true');box.querySelector('.agenda-context-body')?.remove();previewSoon();};
      let active=-1;
      const close=()=>{options.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
      const choose=sid=>{input.value=sid;injectionDraft=sid;clear.hidden=!sid;updateName();close();change();input.focus({preventScroll:true});};
      clear.onmousedown=e=>e.preventDefault();clear.onclick=()=>choose('');
      function showOptions(filter=false){
        options.replaceChildren();active=-1;input.removeAttribute('aria-activedescendant');
        const query=filter?input.value.trim().toLowerCase():'';
        injection.sessions.filter(sid=>S(sid).toLowerCase().includes(query)).forEach((sid,index)=>{
          const option=el('button',S(sid));option.type='button';option.id='agenda-session-option-'+index;option.tabIndex=-1;option.setAttribute('role','option');option.setAttribute('aria-selected','false');option.title=S(sid);option.dataset.sid=sid;
          option.onmousedown=e=>e.preventDefault();option.onclick=()=>choose(sid);options.append(option);
        });
        options.hidden=!options.children.length;input.setAttribute('aria-expanded',String(!options.hidden));
      }
      input.onclick=()=>showOptions();input.oninput=()=>{injectionDraft=input.value;clear.hidden=!input.value;updateName();showOptions(true);};
      input.onblur=e=>{if(picker.contains(e.relatedTarget))return;close();if(!input.value.trim()||/^[^:]+:(GroupMessage|FriendMessage):.+$/.test(input.value.trim()))change();};
      input.onkeydown=e=>{
        if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();if(options.hidden)showOptions();const rows=[...options.children];if(!rows.length)return;active=(active+(e.key==='ArrowDown'?1:active<0?0:-1)+rows.length)%rows.length;rows.forEach((row,index)=>row.setAttribute('aria-selected',String(index===active)));input.setAttribute('aria-activedescendant',rows[active].id);rows[active].scrollIntoView({block:'nearest'});}
        else if(e.key==='Enter'){e.preventDefault();const row=options.children[active];if(!options.hidden&&row)choose(row.dataset.sid);else{close();change();}}
        else if(e.key==='Escape'&&!options.hidden){e.preventDefault();e.stopPropagation();close();}
        else if(e.key==='Tab')close();
      };
      const selectedName=el('small',SR(input.value),'session-name-reference agenda-session-name');
      const updateName=()=>{selectedName.textContent=SR(input.value);input.title=S(input.value);};updateName();
      picker.append(input,clear,options);toolbar.append(label,picker,selectedName);box.append(toolbar);if(pickerWasOpen)showOptions(input.value!==injection.sid);
      const body=el('div',undefined,'agenda-context-body');box.append(body);box.removeAttribute('aria-busy');
      if(!['ready','select_session'].includes(injection.reason))body.append(el('p',t('pages.console.ui.injection_reason_'+injection.reason),'agenda-context-empty'));
      if('preview_days' in injection){
        const settings=el('div',undefined,'agenda-context-meta');
        settings.append(el('span',injection.preview_days===0?t('pages.console.ui.injection_days_off'):injection.preview_days===null?t('pages.console.ui.s21c91b0dc6'):t('pages.console.ui.preview_calendar_days',{days:injection.preview_days})),el('span',injection.max_items===null?t('pages.console.ui.injection_no_limit'):t('pages.console.ui.injection_limit',{count:injection.max_items})));
        body.append(settings);
      }
      if(injection.reason==='ready'){
        const lists=el('div',undefined,'agenda-context-lists');
        for(const key of ['current','upcoming']){
          const rows=injection[key];if(!rows.length)continue;
          const column=el('section',undefined,'agenda-context-column'),title=el('h3',t('pages.console.ui.injection_'+key));title.append(el('span',String(rows.length),'agenda-context-count'));column.append(title);
          const list=el('ul');list.id='agenda-injection-'+key;
          for(const row of rows){
            const item=el('li'),name=el('strong',row.title),stamp=el('span',row.start.slice(0,10)+' · '+timeText(row),'agenda-context-time');
            item.append(name,stamp);if(row.description){const description=el('p',row.description);description.title=row.description;item.append(description);}list.append(item);
          }
          column.append(list);lists.append(column);
        }
        body.append(lists);if(injection.truncated)body.append(el('small',t('pages.console.ui.injection_truncated'),'agenda-context-help'));
      }
      if(injection.pause_available){
        const pause=el('div',undefined,'agenda-context-pause');pause.append(el('strong',t('pages.console.ui.injection_pause')));
        const effects=[];for(const key of ['interjection','proactive'])if(injection['pause_'+key].length)effects.push(t('pages.console.ui.injection_pause_'+key)+injection['pause_'+key].join('、'));
        pause.append(el('span',effects.length?effects.join('；'):t('pages.console.ui.injection_pause_none')));body.append(pause);
      }
      if(injection.text){const raw=el('details',undefined,'agenda-context-raw'),text=el('pre',injection.text);raw.id='agenda-injection-raw';raw.open=!!expanded;text.id='agenda-injection-text';raw.append(el('summary',t('pages.console.ui.injection_raw')));const references=SR(injection.text);if(references)raw.append(el('small',references,'session-name-reference'));raw.append(text);body.append(raw);}
      scrolls.forEach(value=>{const node=document.getElementById(value.id);if(node){node.scrollTop=value.top;node.scrollLeft=value.left;}});
    }
    return {
      render(root,selectedGroup){
        group=selectedGroup;calendar=null;
        const scope=selectedGroup?.agenda_id||'global';if(injectionScope!==scope){injectionScope=scope;injectionSid=null;injectionDraft=null;}injection=null;
        const gs=state.schema.session_groups.templates.group.items,box=section(t("pages.console.ui.s21649f1663"),t("pages.console.ui.sf42007e551"));box.id='agenda-settings';
        box.append(group?field('agenda_mode',gs.agenda_mode,group,['agenda','enabled'],true):field('enabled',state.schema.agenda.items.enabled,state.config.agenda,['agenda','enabled']));
        if(!group)for(const key of ['outside_scope','allow_global_management'])box.append(field(key,state.schema.agenda.items[key],state.config.agenda,['agenda',key]));
        for(const key of ['preview_days','max_items'])box.append(group?field('agenda_'+key,gs['agenda_'+key],group,['agenda',key],true):field(key,state.schema.agenda.items[key],state.config.agenda,['agenda',key]));
        if(!group){const advanced=el('details',undefined,'agenda-guidance');advanced.append(el('summary',t("pages.console.ui.s4418c7624d")),field('background_description',state.schema.agenda.items.background_description,state.config.agenda,['agenda','background_description']));box.append(advanced);}
        if(group)box.append(el('small',t("pages.console.ui.sc07164b7b5"),'muted'));
        group=selectedGroup?state.saved.session_groups.find(g=>g.agenda_id===selectedGroup.agenda_id):null;
        if(selectedGroup&&!group){box.append(el('p',t("pages.console.ui.sd6287ec80e"),'warning'));root.append(box);return;}
        box.append(el('p',t("pages.console.ui.s6afc1aef03"),'muted'));
        renderList(box);root.append(box);const current=el('div',undefined,'agenda-now');current.id='agenda-now';current.append(el('p',t("pages.console.ui.sb96a866864")));root.append(current);
        const month=section(t("pages.console.ui.s61edb85240"),t("pages.console.ui.sf3086c7326"));month.id='agenda-calendar';month.append(el('p',t("pages.console.ui.s339a81bffd"),'muted'));root.append(month);
      },
      previewParams(){return {...listUI.params(),injection_sid:injectionSid};},
      updateInjection(context){injection=context;injectionSid=injection.sid;injectionDraft??=injection.sid;drawInjection();},
      update(data,list,context){calendar=data;injection=context||null;if(injection){injectionSid=injection.sid;injectionDraft??=injection.sid;}state.calendarMonth=data.month;drawCalendar();drawInjection();if(list)listUI.update(list);}
    };
  };
})();
