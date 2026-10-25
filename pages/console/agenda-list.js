/* Browsing is UI state; explicit actions save runtime agenda data independently. */
(() => {
  'use strict';
  const {t,runtime:R,value:V}=window.ActiveMessageI18n;
  const {node:el,dialog,help,helpTag,dateRangePicker,preserveView,sessionLabel:S}=window.ActiveMessageUI;
  const statusNames=()=>({current:t("pages.console.ui.s6f1972e48e"),upcoming:t("pages.console.ui.s3ed3700354"),expired:t("pages.console.ui.s20391328c8"),unknown:t("pages.console.ui.sb9ef74ca6d")});
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
      options.forEach(([value,text])=>select.add(new Option(V(text),value)));select.value=filters[key];select.onchange=()=>changeFilter(key,select.value);wrap.append(el('span',label),select);return wrap;
    }
    function info(row){return metadata?metadataById.get(row.event.id):undefined;}
    function matches(row){
      const event=row.event,meta=info(row),words=filters.keyword.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const haystack=[event.title,event.description,...(event.target_sids||[]).map(S)].join(' ').toLocaleLowerCase();
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
      const top=el('div',undefined,'agenda-search-row'),search=el('input'),reset=el('button',t("pages.console.ui.s3d81345303")),add=el('button',group?t("pages.console.ui.s184a9ca72b"):t("pages.console.ui.se8c59d735e"),'primary');
      add.onclick=()=>edit();const refresh=el('button',t("pages.console.ui.s1fea00350d"));refresh.onclick=()=>refreshAgenda().catch(fail);top.append(add,refresh);
      search.type='search';search.placeholder=t("pages.console.ui.sd2867be47e");search.value=filters.keyword;search.setAttribute('aria-label',t("pages.console.ui.s562d5bea0e"));search.oninput=()=>changeFilter('keyword',search.value);
      top.append(search,choose(t("pages.console.ui.s2a035ac3ef"),'status',[['active',t("pages.console.ui.saee47bd88c")],['current',t("pages.console.ui.s6f1972e48e")],['upcoming',t("pages.console.ui.s3ed3700354")],['expired',t("pages.console.ui.s20391328c8")],['unknown',t("pages.console.ui.sb9ef74ca6d")],['',t("pages.console.ui.s778fc8f994")]]));
      reset.onclick=()=>{resetBrowse();makeControls();draw();previewSoon();};
      top.append(reset,help(t("pages.console.ui.s1af82d4bdc"),t("pages.console.ui.sedc01ff0be")));
      const more=el('div',undefined,'agenda-filter-grid');
      more.append(choose(t("pages.console.ui.s5691b3791b"),'enabled',[['',t("pages.console.ui.s778fc8f994")],['true',t("pages.console.ui.s25d2843150")],['false',t("pages.console.ui.s6c7dcbb73a")]]),choose(t("pages.console.ui.s61d86b0ff1"),'origin',group?[['',t("pages.console.ui.s778fc8f994")],['global',t("pages.console.ui.s642089607b")],['local',t("pages.console.ui.s44c7b451d6")],['targeted',t("pages.console.ui.s9e2646ef23")]]:[['',t("pages.console.ui.s778fc8f994")],['global',t("pages.console.ui.s25764a2618")],['targeted',t("pages.console.ui.s9e2646ef23")],['orphaned',t("pages.console.ui.s1b06a30878")]]),choose(t("pages.console.ui.sd21145d4fa"),'repeat',[['',t("pages.console.ui.s778fc8f994")],...['不重复','每天','每周','每年','Cron'].map(value=>[value,value])]),choose(t("pages.console.ui.s21e56b7a00"),'effect',[['',t("pages.console.ui.s778fc8f994")],['none',t("pages.console.ui.s3c21665db7")],['interjection',t("pages.console.ui.s32d50131e1")],['proactive',t("pages.console.ui.sbbb1fe3fdb")],['both',t("pages.console.ui.s9c646fbe82")]]));
      if(group)more.append(choose(t("pages.console.ui.s910a4bc801"),'excluded',[['',t("pages.console.ui.s778fc8f994")],['true',t("pages.console.ui.s0e1860ca45")],['false',t("pages.console.ui.sb6b8ad9da8")]]));
      const dates=el('div',undefined,'agenda-filter-dates');dates.append(el('span',t("pages.console.ui.s3783f29c30")),dateRangePicker({start:filters.start,end:filters.end,today:()=>metadata?.now.slice(0,10),onChange:dateChange}));more.append(dates);
      filterSummary=el('small',undefined,'agenda-filter-summary');
      controls.append(top,more,filterSummary);summary=el('small',undefined,'agenda-result-summary');summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');batch=el('div',undefined,'agenda-batch-actions');grid=el('div',undefined,'agenda-list');pager=el('div',undefined,'agenda-pagination');
      host.replaceChildren(controls,summary,batch,grid,pager);
    }
    function selectedRows(kind){return rows().filter(row=>selected.has(row.event.id)&&(kind==='delete'?!row.inherited:row.inherited&&!row.excluded));}
    async function act(kind,targets){
      if(!targets.length)return;
      const revision=state.agendaRevision,groupId=group?.agenda_id;
      const deletion=kind==='delete',content=el('div',undefined,'agenda-batch-confirm');
      for(const row of targets){const item=el('div'),meta=info(row),scope=row.orphaned?t("pages.console.ui.s1b06a30878"):row.inherited?t("pages.console.ui.s642089607b"):row.origin==='targeted'?t("pages.console.ui.s9e2646ef23"):group?t("pages.console.ui.s44c7b451d6"):t("pages.console.ui.s25764a2618");item.append(el('strong',row.event.title||t("pages.console.ui.s8ec4653646")),el('small',scope+' · '+(statusNames()[meta?.status]||t("pages.console.ui.sd3373e17d5"))+' · '+describe(row.event)));if(row.event.target_sids?.length)item.append(el('small',t("pages.console.ui.s5e3c8840f5")+row.event.target_sids.map(S).join('、')));content.append(item);}
      const message=deletion?t("pages.console.ui.s233358cab5"):t("pages.console.ui.s9edc13cb5e");
      await dialog({title:(deletion?t("pages.console.ui.s6c5f7f7587"):t("pages.console.ui.sc0ff9f27b8"))+'（'+targets.length+t("pages.console.ui.sfd5a0e0a50"),message,content,confirm:deletion?t("pages.console.ui.s5d071a7a42"):t("pages.console.ui.s51edfc24d5"),danger:deletion,submit:async()=>{
        await saveAgenda({action:kind,ids:targets.map(row=>row.event.id),group_id:groupId},revision);
        targets.forEach(row=>selected.delete(row.event.id));draw();
      }});
    }
    async function repair(event){
      const revision=state.agendaRevision,select=el('select');select.setAttribute('aria-label',t("pages.console.ui.s4ab0785885"));select.add(new Option(t("pages.console.ui.sc65706c1c7"),''));select.add(new Option(t("pages.console.ui.s8e90eb10aa"),'global'));state.saved.session_groups.forEach((owner,index)=>select.add(new Option((index+1)+'. '+owner.group_name,String(index))));
      await dialog({title:t("pages.console.ui.sb4159f2e06"),message:t("pages.console.ui.s5a2ead2d18"),content:select,confirm:t("pages.console.ui.sc4487483b2"),validate:()=>!!select.value,submit:()=>saveAgenda({action:'upsert',original_id:event.id,event:{...event,group_id:select.value==='global'?'':state.saved.session_groups[Number(select.value)].agenda_id}},revision)});
    }
    function card(row){
      const {event,inherited,excluded,orphaned}=row,meta=info(row),article=el('article',undefined,'agenda-row');article.dataset.eventId=event.id;article.dataset.viewKey='agenda:'+event.id;article.classList.toggle('agenda-muted',excluded||!event.enabled);article.classList.toggle('agenda-selected',selected.has(event.id));
      const pick=el('input');pick.type='checkbox';pick.checked=selected.has(event.id);pick.setAttribute('aria-label',t("pages.console.ui.s68c0631497")+(event.title||t("pages.console.ui.s8ec4653646")));pick.onchange=()=>{pick.checked?selected.add(event.id):selected.delete(event.id);draw();};
      const infoBox=el('div',undefined,'agenda-row-info'),heading=el('div',undefined,'agenda-row-heading');heading.append(pick,el('strong',event.title||t("pages.console.ui.s8ec4653646")));
      heading.append(event.target_sids?.length?helpTag(t("pages.console.ui.s65985f97f2")+event.target_sids.length+t("pages.console.ui.scd628eba05"),event.target_sids.map(S).join('\n'),t("pages.console.ui.s9e2646ef23")):el('span',orphaned?t("pages.console.ui.s1b06a30878"):inherited?t("pages.console.ui.s642089607b"):group?t("pages.console.ui.s44c7b451d6"):t("pages.console.ui.sa5644f4bbf"),'tag'));
      const timeStatus=meta?.status||(metadata?'unknown':'');const status=el('span',statusNames()[timeStatus]||t("pages.console.ui.s448918ad7b"),'tag agenda-time-status');if(timeStatus)status.dataset.status=timeStatus;heading.append(status);
      if(excluded)heading.append(el('span',t("pages.console.ui.s0e1860ca45"),'tag'));if(!event.enabled)heading.append(el('span',t("pages.console.ui.s8bb38ef00c"),'tag'));
      infoBox.append(heading,el('small',describe(event)));
      if(meta?.next_start&&event.repeat!=='不重复')infoBox.append(el('small',t("pages.console.ui.s0b6ffdd500")+(event.time_mode==='全天'&&event.repeat!=='Cron'?meta.next_start.slice(0,10)+t("pages.console.ui.s94792627f5"):meta.next_start.slice(0,16).replace('T',' ')),'agenda-next-time'));
      const effects=[];if(event.pause_interjection)effects.push(t("pages.console.ui.s25eaa711df"));if(event.pause_proactive)effects.push(t("pages.console.ui.s016ccdd7f6"));if(effects.length)infoBox.append(el('small',effects.join(' · ')));
      if(event.description)infoBox.append(el('p',event.description,'agenda-description'));
      const actions=el('div',undefined,'agenda-row-actions');
      if(inherited){const toggle=el('button',excluded?t("pages.console.ui.s7b29ae8ef6"):t("pages.console.ui.s51edfc24d5"));toggle.onclick=()=>saveAgenda({action:excluded?'restore':'exclude',group_id:group.agenda_id,ids:[event.id]}).catch(fail);actions.append(toggle);}
      else{const change=el('button',orphaned?t("pages.console.ui.sc1fa72cee6"):t("pages.console.ui.sa7f814c0a4")),remove=el('button',t("pages.console.ui.s3755f56f2f"),'danger');change.onclick=()=>orphaned?repair(event):edit(event);remove.onclick=()=>act('delete',[row]);actions.append(change,remove);}
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
      summary.textContent=t("pages.console.ui.scb3a43eea3")+matching.length+' / '+available.length+t("pages.console.ui.s075d650f1e")+visible.length+t("pages.console.ui.s6e3841e19c")+selected.size+t("pages.console.ui.sd1200c4db0")+onPage+t("pages.console.ui.sfd5a0e0a50")+(metadata?t("pages.console.ui.sbf5586bdc8")+metadata.timezone:t("pages.console.ui.s5e4d713c6e"));
      const active=[];for(const [key,label] of [['enabled',t("pages.console.ui.sd4e9ca3dd4")],['origin',t("pages.console.ui.sc63f79e636")],['repeat',t("pages.console.ui.s6e708ba759")],['effect',t("pages.console.ui.s5be321f307")],['excluded',t("pages.console.ui.scf41f82191")]]){const select=controls.querySelector('[data-filter="'+key+'"]');if(filters[key]&&select)active.push(label+'：'+select.selectedOptions[0].textContent);}if(filters.start||filters.end)active.push(t("pages.console.ui.sb2778afe01")+(filters.start||t("pages.console.ui.s91f4e528b0"))+' ～ '+(filters.end||t("pages.console.ui.s0d7eeab59a")));filterSummary.textContent=active.join('；');filterSummary.hidden=!active.length;
      batch.replaceChildren();const allLabel=el('label',undefined,'agenda-select-all'),all=el('input');all.type='checkbox';all.checked=visible.length>0&&onPage===visible.length;all.indeterminate=onPage>0&&onPage<visible.length;all.disabled=!visible.length;all.setAttribute('aria-label',t("pages.console.ui.sb82f2ebbd9"));all.onchange=()=>{visible.forEach(row=>all.checked?selected.add(row.event.id):selected.delete(row.event.id));draw();};allLabel.append(all,el('span',t("pages.console.ui.sb82f2ebbd9")));batch.append(allLabel);
      const clear=el('button',t("pages.console.ui.s7cfdcf5bf0"));clear.disabled=!selected.size;clear.onclick=()=>{selected.clear();draw();};batch.append(clear);
      const deletions=selectedRows('delete'),exclusions=selectedRows('exclude'),remove=el('button',t("pages.console.ui.s09ba80cc7e")+deletions.length+'）','danger');remove.disabled=!deletions.length;remove.onclick=()=>act('delete',deletions);batch.append(remove);
      if(group){const exclude=el('button',t("pages.console.ui.se9ce9d8103")+exclusions.length+'）');exclude.disabled=!exclusions.length;exclude.onclick=()=>act('exclude',exclusions);batch.append(exclude);}
      grid.replaceChildren(...visible.map(card));if(!matching.length)grid.append(el('p',(filters.start||filters.end)&&!rangeReady?t("pages.console.ui.s82e3889d3a"):available.length?t("pages.console.ui.s1eaf743dbb"):t("pages.console.ui.sf29300a3ad"),'empty'));
      pager.replaceChildren();
      function turn(caption,target,disabled){const button=el('button',caption);button.disabled=disabled;button.onclick=()=>{page=target;draw();};return button;}
      const navigation=el('div',undefined,'agenda-page-navigation');navigation.append(turn(t("pages.console.ui.sff93ad0e4e"),1,page===1),turn(t("pages.console.ui.sb41561d807"),page-1,page===1));
      const jumpLabel=el('label',t("pages.console.ui.s634285ae67")),jump=el('input'),go=el('button',t("pages.console.ui.s28cd2efd8f"));jump.type='number';jump.min=1;jump.max=totalPages;jump.step=1;jump.value=page;jump.setAttribute('aria-label',t("pages.console.ui.sef8439ca4d"));jumpLabel.append(jump,el('span',t("pages.console.ui.s73422182ab")));
      go.onclick=()=>{const value=Number(jump.value);if(!jump.value||!Number.isInteger(value)||value<1||value>totalPages){jump.setCustomValidity(t("pages.console.ui.scfb8fe0430")+totalPages+t("pages.console.ui.s5ceff7f717"));jump.reportValidity();return;}page=value;draw();};jump.oninput=()=>jump.setCustomValidity('');jump.onkeydown=event=>{if(event.key==='Enter')go.click();};navigation.append(jumpLabel,go,turn(t("pages.console.ui.s67a246a344"),page+1,page===totalPages),turn(t("pages.console.ui.sef44f69478"),totalPages,page===totalPages),el('small',t("pages.console.ui.sf495347d6a")+page+' / '+totalPages+t("pages.console.ui.saf8438feb2")));pager.append(navigation);
      const sizeLabel=el('label',t("pages.console.ui.s309c98d313")),size=el('input');size.type='number';size.min=1;size.max=100;size.step=1;size.value=pageSize;size.setAttribute('aria-label',t("pages.console.ui.sf19486f34d"));sizeLabel.append(size,el('span',t("pages.console.ui.sbce2ef6151")));pager.append(sizeLabel);
      size.oninput=()=>size.setCustomValidity('');size.onchange=()=>{const value=Number(size.value);if(!size.value||!Number.isInteger(value)||value<1||value>100){size.setCustomValidity(t("pages.console.ui.s8a8bdaf654"));size.reportValidity();size.value=pageSize;return;}pageSize=value;page=1;persistPrefs?.({agenda_page_size:value});draw();};
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
