/* Browsing is UI state; explicit actions save runtime agenda data independently. */
(() => {
  'use strict';
  const {node:el,dialog,help,helpTag,dateRangePicker,preserveView}=window.ActiveMessageUI;
  const statusNames={current:'进行中',upcoming:'待发生',expired:'已结束',unknown:'无法判断'};
  const defaults=()=>({keyword:'',status:'active',enabled:'',origin:'',repeat:'',effect:'',excluded:'',start:'',end:''});
  window.createAgendaListUI=({state,edit,describe,saveAgenda,refreshAgenda,fail,previewSoon,persistPrefs})=>{
    let group=null,scopeKey=null,configRef=null,filters=defaults(),page=1,pageSize=15,selected=new Set(),metadata=null,metadataById=new Map(),signature='',host=null;
    let controls=null,summary=null,batch=null,grid=null,pager=null,filterSummary=null;
    const configSignature=()=>JSON.stringify(state.config.agenda.events);
    function rows(){
      const groups=state.saved.session_groups,events=state.config.agenda.events;
      return events.flatMap(event=>{
        const inherited=!!group&&!event.group_id&&!event.target_sids?.length;
        const targeted=!!event.target_sids?.length;
        const orphaned=!!event.group_id&&!groups.some(g=>g.agenda_id===event.group_id);
        const visible=group?inherited||group.agenda_id&&event.group_id===group.agenda_id||targeted&&event.target_sids.some(s=>group.sids.includes(s)||group.sids.includes(s.split(':').slice(2).join(':'))):!event.group_id||orphaned;
        return visible?[{event,inherited,orphaned,origin:targeted?'targeted':orphaned?'orphaned':event.group_id?'local':'global',excluded:inherited&&group.agenda_exclusions.includes(event.id)}]:[];
      });
    }
    function resetBrowse(){filters=defaults();page=1;selected.clear();metadata=null;}
    function changeFilter(key,value){filters[key]=value;page=1;selected.clear();draw();}
    function choose(label,key,options){
      const wrap=el('label',undefined,'agenda-filter-field'),select=el('select');select.setAttribute('aria-label',label);select.dataset.filter=key;
      options.forEach(([value,text])=>select.add(new Option(text,value)));select.value=filters[key];select.onchange=()=>changeFilter(key,select.value);wrap.append(el('span',label),select);return wrap;
    }
    function info(row){return metadata?metadataById.get(row.event.id):undefined;}
    function matches(row){
      const event=row.event,meta=info(row),words=filters.keyword.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const haystack=[event.title,event.description,...(event.target_sids||[])].join(' ').toLocaleLowerCase();
      if(!words.every(word=>haystack.includes(word)))return false;
      if(filters.status==='active'&&meta?.status==='expired')return false;
      if(filters.status!=='active'&&filters.status&&(meta?.status||(metadata?'unknown':''))!==filters.status)return false;
      if(filters.enabled&&String(!!event.enabled)!==filters.enabled)return false;
      if(filters.origin&&row.origin!==filters.origin)return false;
      if(filters.repeat&&event.repeat!==filters.repeat)return false;
      const effect=event.pause_interjection?(event.pause_proactive?'both':'interjection'):(event.pause_proactive?'proactive':'none');
      if(filters.effect&&effect!==filters.effect)return false;
      if(filters.excluded&&String(row.excluded)!==filters.excluded)return false;
      if((filters.start||filters.end)&&(!metadata||metadata.start_date!==filters.start||metadata.end_date!==filters.end||!meta?.matches_range))return false;
      return true;
    }
    function dateChange(value){
      filters.start=value.start;filters.end=value.end;metadata=null;page=1;selected.clear();draw();previewSoon();
    }
    function makeControls(){
      controls=el('div',undefined,'agenda-browser-controls');
      const top=el('div',undefined,'agenda-search-row'),search=el('input'),reset=el('button','重置'),add=el('button',group?'添加本组日程':'添加全局日程','primary');
      add.onclick=()=>edit();const refresh=el('button','刷新日程');refresh.onclick=()=>refreshAgenda().catch(fail);top.append(add,refresh);
      search.type='search';search.placeholder='搜索日程名称、说明或指定 SID';search.value=filters.keyword;search.setAttribute('aria-label','搜索日程');search.oninput=()=>changeFilter('keyword',search.value);
      top.append(search,choose('时间状态','status',[['active','当前及未来'],['current','进行中'],['upcoming','待发生'],['expired','已结束'],['unknown','无法判断'],['','全部']]));
      reset.onclick=()=>{resetBrowse();makeControls();draw();previewSoon();};
      top.append(reset,help('日程列表怎么用','搜索名称、说明或指定 SID；多个词用空格隔开，日程需要同时包含这些词。\n不同筛选条件需要同时满足。日期范围看这段时间内有没有安排，不是看日程从哪天开始；只填一端表示另一端不限。查看过去的一次性安排时，时间状态请选择“全部”或“已结束”。\n默认显示当前和未来安排；已停用、已排除是单独的状态。时间状态按最近一次预览和下方显示的时区计算，无法判断的记录默认保留。\n全选只选本页；翻页保留勾选，“跨页取消全部选择”清除所有页的勾选；更换搜索、筛选或会话组会清空勾选。\n每页可填 1～100 的整数，默认 15；删除后后面的日程向前补位，尽量留在原页。\n添加、编辑、删除和本组排除均直接保存，无需点击顶部保存；日程按已生效的设置和会话组运行。\n列表的筛选和分页不影响下方日历。'));
      const more=el('div',undefined,'agenda-filter-grid');
      more.append(choose('启用状态','enabled',[['','全部'],['true','已启用'],['false','已停用']]),choose('日程来源','origin',group?[['','全部'],['global','来自全局'],['local','本组新增'],['targeted','指定会话']]:[['','全部'],['global','共享全局'],['targeted','指定会话'],['orphaned','未关联会话组']]),choose('重复方式','repeat',[['','全部'],...['不重复','每天','每周','每年','Cron'].map(value=>[value,value])]),choose('行为影响','effect',[['','全部'],['none','仅提供背景'],['interjection','只暂停插话'],['proactive','只暂停主动聊天'],['both','两者都暂停']]));
      if(group)more.append(choose('本组继承','excluded',[['','全部'],['true','本组已排除'],['false','本组未排除']]));
      const dates=el('div',undefined,'agenda-filter-dates');dates.append(el('span','日期范围'),dateRangePicker({start:filters.start,end:filters.end,today:()=>metadata?.now.slice(0,10),onChange:dateChange}));more.append(dates);
      filterSummary=el('small',undefined,'agenda-filter-summary');
      controls.append(top,more,filterSummary);summary=el('small',undefined,'agenda-result-summary');summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');batch=el('div',undefined,'agenda-batch-actions');grid=el('div',undefined,'agenda-list');pager=el('div',undefined,'agenda-pagination');
      host.replaceChildren(controls,summary,batch,grid,pager);
    }
    function selectedRows(kind){return rows().filter(row=>selected.has(row.event.id)&&(kind==='delete'?!row.inherited:row.inherited&&!row.excluded));}
    async function act(kind,targets){
      if(!targets.length)return;
      const revision=state.agendaRevision,groupId=group?.agenda_id;
      const deletion=kind==='delete',content=el('div',undefined,'agenda-batch-confirm');
      for(const row of targets){const item=el('div'),meta=info(row),scope=row.orphaned?'未关联会话组':row.inherited?'来自全局':row.origin==='targeted'?'指定会话':group?'本组新增':'共享全局';item.append(el('strong',row.event.title||'未命名日程'),el('small',scope+' · '+(statusNames[meta?.status]||'时间状态待计算')+' · '+describe(row.event)));if(row.event.target_sids?.length)item.append(el('small','影响会话：'+row.event.target_sids.join('、')));content.append(item);}
      const message=deletion?'删除整条日程及其重复规则；共享或指定给多个会话的安排会从这些会话一并移除。确认后直接保存。':'只让本组不再使用这些全局日程，其他会话继续使用。确认后直接保存。';
      await dialog({title:(deletion?'删除所选日程':'本组排除所选')+'（'+targets.length+' 条）',message,content,confirm:deletion?'删除所选':'本组排除',danger:deletion,submit:async()=>{
        await saveAgenda({action:kind,ids:targets.map(row=>row.event.id),group_id:groupId},revision);
        targets.forEach(row=>selected.delete(row.event.id));draw();
      }});
    }
    async function repair(event){
      const revision=state.agendaRevision,select=el('select');select.setAttribute('aria-label','重新关联到哪个范围');select.add(new Option('请选择适用范围',''));select.add(new Option('全局：适用会话（可在组内排除）','global'));state.saved.session_groups.forEach((owner,index)=>select.add(new Option((index+1)+'. '+owner.name,String(index))));
      await dialog({title:'重新关联日程',message:'确认后直接保存。选择全局会让继承它的会话都能看到这条日程。',content:select,confirm:'保存日程',validate:()=>!!select.value,submit:()=>saveAgenda({action:'upsert',original_id:event.id,event:{...event,group_id:select.value==='global'?'':state.saved.session_groups[Number(select.value)].agenda_id}},revision)});
    }
    function card(row){
      const {event,inherited,excluded,orphaned}=row,meta=info(row),article=el('article',undefined,'agenda-row');article.dataset.eventId=event.id;article.dataset.viewKey='agenda:'+event.id;article.classList.toggle('agenda-muted',excluded||!event.enabled);article.classList.toggle('agenda-selected',selected.has(event.id));
      const pick=el('input');pick.type='checkbox';pick.checked=selected.has(event.id);pick.setAttribute('aria-label','选择日程：'+(event.title||'未命名日程'));pick.onchange=()=>{pick.checked?selected.add(event.id):selected.delete(event.id);draw();};
      const infoBox=el('div',undefined,'agenda-row-info'),heading=el('div',undefined,'agenda-row-heading');heading.append(pick,el('strong',event.title||'未命名日程'));
      heading.append(event.target_sids?.length?helpTag('指定会话（'+event.target_sids.length+' 个）',event.target_sids.join('\n'),'指定会话'):el('span',orphaned?'未关联会话组':inherited?'来自全局':group?'本组新增':'全局','tag'));
      const timeStatus=meta?.status||(metadata?'unknown':'');const status=el('span',statusNames[timeStatus]||'正在计算','tag agenda-time-status');if(timeStatus)status.dataset.status=timeStatus;heading.append(status);
      if(excluded)heading.append(el('span','本组已排除','tag'));if(!event.enabled)heading.append(el('span','未启用','tag'));
      infoBox.append(heading,el('small',describe(event)));
      if(meta?.next_start&&event.repeat!=='不重复')infoBox.append(el('small','下一次：'+(event.time_mode==='全天'&&event.repeat!=='Cron'?meta.next_start.slice(0,10)+' 全天':meta.next_start.slice(0,16).replace('T',' ')),'agenda-next-time'));
      const effects=[];if(event.pause_interjection)effects.push('暂停插话');if(event.pause_proactive)effects.push('暂停主动聊天');if(effects.length)infoBox.append(el('small',effects.join(' · ')));
      if(event.description)infoBox.append(el('p',event.description,'agenda-description'));
      const actions=el('div',undefined,'agenda-row-actions');
      if(inherited){const toggle=el('button',excluded?'恢复继承':'本组排除');toggle.onclick=()=>saveAgenda({action:excluded?'restore':'exclude',group_id:group.agenda_id,ids:[event.id]}).catch(fail);actions.append(toggle);}
      else{const change=el('button',orphaned?'重新关联':'编辑'),remove=el('button','删除','danger');change.onclick=()=>orphaned?repair(event):edit(event);remove.onclick=()=>act('delete',[row]);actions.append(change,remove);}
      article.append(infoBox,actions);return article;
    }
    function draw(){
      if(!host)return;
      const restore=preserveView();
      const focused=document.activeElement,focusLabel=focused?.getAttribute('aria-label'),focusCaption=focused?.tagName==='BUTTON'?focused.textContent:null;
      const available=rows(),ids=new Set(available.map(row=>row.event.id));for(const id of selected)if(!ids.has(id))selected.delete(id);
      const matching=available.filter(matches),totalPages=Math.max(1,Math.ceil(matching.length/pageSize));page=Math.min(page,totalPages);
      const visible=matching.slice((page-1)*pageSize,page*pageSize),onPage=visible.filter(row=>selected.has(row.event.id)).length;
      const rangeReady=metadata&&metadata.start_date===filters.start&&metadata.end_date===filters.end;
      summary.textContent='匹配 '+matching.length+' / '+available.length+' 条 · 本页 '+visible.length+' 条 · 已选 '+selected.size+' 条（本页 '+onPage+' 条）'+(metadata?' · 预览时区：'+metadata.timezone:' · 时间状态计算中');
      const active=[];for(const [key,label] of [['enabled','启用'],['origin','来源'],['repeat','重复'],['effect','影响'],['excluded','继承']]){const select=controls.querySelector('[data-filter="'+key+'"]');if(filters[key]&&select)active.push(label+'：'+select.selectedOptions[0].textContent);}if(filters.start||filters.end)active.push('日期：'+(filters.start||'不限开始')+' ～ '+(filters.end||'不限结束'));filterSummary.textContent=active.join('；');filterSummary.hidden=!active.length;
      batch.replaceChildren();const allLabel=el('label',undefined,'agenda-select-all'),all=el('input');all.type='checkbox';all.checked=visible.length>0&&onPage===visible.length;all.indeterminate=onPage>0&&onPage<visible.length;all.disabled=!visible.length;all.setAttribute('aria-label','全选本页');all.onchange=()=>{visible.forEach(row=>all.checked?selected.add(row.event.id):selected.delete(row.event.id));draw();};allLabel.append(all,el('span','全选本页'));batch.append(allLabel);
      const clear=el('button','跨页取消全部选择');clear.disabled=!selected.size;clear.onclick=()=>{selected.clear();draw();};batch.append(clear);
      const deletions=selectedRows('delete'),exclusions=selectedRows('exclude'),remove=el('button','删除所选日程（'+deletions.length+'）','danger');remove.disabled=!deletions.length;remove.onclick=()=>act('delete',deletions);batch.append(remove);
      if(group){const exclude=el('button','本组排除所选（'+exclusions.length+'）');exclude.disabled=!exclusions.length;exclude.onclick=()=>act('exclude',exclusions);batch.append(exclude);}
      grid.replaceChildren(...visible.map(card));if(!matching.length)grid.append(el('p',(filters.start||filters.end)&&!rangeReady?'正在计算日期范围…':available.length?'没有匹配的日程，可调整条件或点击“重置”。':'还没有日程，先添加一条安排。','empty'));
      pager.replaceChildren();
      function turn(caption,target,disabled){const button=el('button',caption);button.disabled=disabled;button.onclick=()=>{page=target;draw();};return button;}
      const navigation=el('div',undefined,'agenda-page-navigation');navigation.append(turn('首页',1,page===1),turn('上一页',page-1,page===1));
      const jumpLabel=el('label','跳转到'),jump=el('input'),go=el('button','跳转');jump.type='number';jump.min=1;jump.max=totalPages;jump.step=1;jump.value=page;jump.setAttribute('aria-label','跳转页码');jumpLabel.append(jump,el('span','页'));
      go.onclick=()=>{const value=Number(jump.value);if(!jump.value||!Number.isInteger(value)||value<1||value>totalPages){jump.setCustomValidity('请输入 1～'+totalPages+' 的整数页码。');jump.reportValidity();return;}page=value;draw();};jump.oninput=()=>jump.setCustomValidity('');jump.onkeydown=event=>{if(event.key==='Enter')go.click();};navigation.append(jumpLabel,go,turn('下一页',page+1,page===totalPages),turn('末页',totalPages,page===totalPages),el('small','第 '+page+' / '+totalPages+' 页'));pager.append(navigation);
      const sizeLabel=el('label','每页'),size=el('input');size.type='number';size.min=1;size.max=100;size.step=1;size.value=pageSize;size.setAttribute('aria-label','每页日程数量');sizeLabel.append(size,el('span','条'));pager.append(sizeLabel);
      size.oninput=()=>size.setCustomValidity('');size.onchange=()=>{const value=Number(size.value);if(!size.value||!Number.isInteger(value)||value<1||value>100){size.setCustomValidity('每页数量需要 1～100 的整数。');size.reportValidity();size.value=pageSize;return;}pageSize=value;page=1;persistPrefs?.({agenda_page_size:value});draw();};
      if(!focused?.isConnected&&(focusLabel||focusCaption)){const replacement=[...host.querySelectorAll('input,button')].find(node=>focusLabel?node.getAttribute('aria-label')===focusLabel:node.tagName==='BUTTON'&&node.textContent===focusCaption);(replacement&&!replacement.disabled?replacement:jump).focus({preventScroll:true});}
      restore();
    }
    return {
      render(target,selectedGroup){
        group=selectedGroup;const key=group?(group.agenda_id||'group_'+state.config.session_groups.indexOf(group)):'global';
        if(scopeKey!==key){scopeKey=key;resetBrowse();}
        else if(configRef!==state.config){selected.clear();metadata=null;}
        configRef=state.config;
        const nextSignature=configSignature();if(signature!==nextSignature){signature=nextSignature;metadata=null;}
        const preference=state.preferences?.agenda_page_size;if(Number.isInteger(preference)&&preference>=1&&preference<=100)pageSize=preference;
        host=target;makeControls();draw();
      },
      params(){return {agenda_start_date:filters.start,agenda_end_date:filters.end};},
      update(value){if(value.start_date!==filters.start||value.end_date!==filters.end)return;metadata=value;metadataById=new Map(value.events.map(event=>[event.id,event]));draw();}
    };
  };
})();
