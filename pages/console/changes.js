/* Draft comparison is local, value-free, and independent of preview requests. */
(() => {
  'use strict';
  const internal=key=>key==='__template_key';
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  function equal(a,b){
    if(a===b)return true;
    if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
    if(!object(a)||!object(b))return false;
    const keys=Object.keys(a).filter(k=>!internal(k)),other=Object.keys(b).filter(k=>!internal(k));
    return keys.length===other.length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
  }
  const clocks=new Set(['timezone','sleep_hours','active_hours','active_interval_multiplier']);
  const groupSections={interjection_mode:'智能插话',threshold_override:'智能插话',decision_mode:'智能插话',interjection_overrides:'智能插话',decision_overrides:'智能插话',interjection_weights:'智能插话',interjection_activity:'智能插话',interjection_energy:'智能插话',cooldown_override:'会话组',proactive_mode:'主动聊天',context_overrides:'上下文与诊断',agenda_mode:'作息与日程',agenda_exclusions:'作息与日程'};
  const globalSections={enabled:'运行总览',interjection:'智能插话',activation_prompts:'智能插话',context:'上下文与诊断',diagnostics:'上下文与诊断',runtime:'上下文与诊断'};
  function createTracker(){
    let baseline=null,groupIds=new WeakMap(),baseGroups=[],baseByKey=new Map(),serial=0;
    function reset(current,saved){
      baseline=saved;groupIds=new WeakMap();serial=0;
      baseGroups=(saved.session_groups||[]).map(value=>({key:'group-'+serial++,value}));
      baseByKey=new Map(baseGroups.map(row=>[row.key,row]));
      (current.session_groups||[]).forEach((value,index)=>{if(object(value)&&baseGroups[index])groupIds.set(value,baseGroups[index].key);});
    }
    function matchGroups(groups){
      const used=new Set(),entries=groups.map(value=>({value,key:groupIds.get(value)}));
      // References survive renames, field edits, and drag sorting without changing configuration data.
      for(const row of entries){if(row.key&&baseByKey.has(row.key)&&!used.has(row.key))used.add(row.key);else row.key=null;}
      for(const row of entries){
        if(row.key)continue;
        // Re-creating a removed group with the same settings is a real undo, too.
        const publicGroup=g=>Object.fromEntries(Object.entries(g).filter(([k])=>k!=='agenda_id'));
        const identical=baseGroups.find(b=>!used.has(b.key)&&equal(publicGroup(row.value),publicGroup(b.value)));
        row.key=identical?.key||'group-'+serial++;used.add(row.key);groupIds.set(row.value,row.key);
      }
      return entries;
    }
    return {
      compare(current,saved,schema){
        if(!current||!saved||!schema)return [];
        if(baseline!==saved)reset(current,saved);
        // Metadata is ignored; automatic group-ID changes are omitted from the field list below.
        if(equal(current,saved)){matchGroups(current.session_groups||[]);return [];}
        const locations=[],add=(parts,suffix='')=>locations.push(parts.filter(Boolean).join(' › ')+suffix);
        function walk(before,after,fields,parts){
          const keys=new Set([...Object.keys(before||{}),...Object.keys(after||{})]);
          for(const key of keys){
            if(internal(key)||equal(before?.[key],after?.[key]))continue;
            const meta=fields?.[key]||{},label=meta.description||key;
            if(meta.type==='object'&&object(before?.[key])&&object(after?.[key]))walk(before[key],after[key],meta.items,[...parts,label]);
            else add([...parts,label]);
          }
        }
        const groups=current.session_groups||[],oldGroups=saved.session_groups||[];
        const groupName=(value,index)=>'会话组「'+(value?.name||'未命名组')+'」'+(index>=0?'（'+(index+1)+'）':'');
        for(const key of new Set([...Object.keys(saved),...Object.keys(current)])){
          if(internal(key)||key==='session_groups'||key==='agenda'||equal(saved[key],current[key]))continue;
          const meta=schema[key]||{};
          if(key==='proactive_chat'){
            for(const field of new Set([...Object.keys(saved[key]||{}),...Object.keys(current[key]||{})])){
              if(!equal(saved[key]?.[field],current[key]?.[field]))add(['全局',clocks.has(field)?'作息与日程':'主动聊天',meta.items?.[field]?.description||field]);
            }
          }else if(meta.type==='object')walk(saved[key],current[key],meta.items,['全局',globalSections[key]||meta.description||key,...(['context','diagnostics','runtime'].includes(key)?[meta.description||key]:[])]);
          else add(['全局',globalSections[key]||'',meta.description||key]);
        }
        if(!equal(oldGroups,groups)){
          const entries=matchGroups(groups),groupFields=schema.session_groups?.templates?.group?.items||{};
          const currentKeys=new Set(entries.map(r=>r.key)),oldKeys=new Set(baseGroups.map(r=>r.key)),sharedOld=[...oldKeys].filter(k=>currentKeys.has(k)),sharedNow=[...currentKeys].filter(k=>oldKeys.has(k));
          if(!equal(sharedOld,sharedNow))add(['会话组','排列顺序']);
          entries.forEach((row,index)=>{
            const before=baseByKey.get(row.key)?.value,after=row.value,name=groupName(after,index);
            if(!before){add(['会话组',name],'（新增）');return;}
            for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
              if(internal(key)||key==='agenda_id'||equal(before[key],after[key]))continue;
              const meta=groupFields[key]||{};
              if(key==='proactive_overrides'){
                for(const field of new Set([...Object.keys(before[key]||{}),...Object.keys(after[key]||{})])){
                  if(!equal(before[key]?.[field],after[key]?.[field]))add([name,clocks.has(field)?'作息与日程':'主动聊天',meta.items?.[field]?.description||field]);
                }
              }else if(meta.type==='object')walk(before[key],after[key],meta.items,[name,groupSections[key]||'会话组',...(['interjection_weights','interjection_activity','interjection_energy'].includes(key)?[meta.description||key]:[])]);
              else add([name,groupSections[key]||'会话组',meta.description||key]);
            }
          });
          baseGroups.forEach((row,index)=>{if(!currentKeys.has(row.key))add(['会话组',groupName(row.value,index)],'（删除）');});
        }
        const agendaMeta=schema.agenda?.items||{};
        walk(Object.fromEntries(Object.entries(saved.agenda||{}).filter(([k])=>k!=='events')),Object.fromEntries(Object.entries(current.agenda||{}).filter(([k])=>k!=='events')),agendaMeta,['全局','作息与日程']);
        const events=current.agenda?.events||[],oldEvents=saved.agenda?.events||[],eventFields={...(agendaMeta.events?.templates?.event?.items||{}),group_id:{description:'日程适用范围'}};
        if(!equal(events,oldEvents)){
          const scope=(e,sourceGroups)=>{if(!e.group_id)return '全局';const i=sourceGroups.findIndex(g=>g.agenda_id===e.group_id);return i<0?'未关联会话组':groupName(sourceGroups[i],i);};
          const ordinals=rows=>{const counts=new Map(),result=new Map();for(const e of rows){const n=(counts.get(e.group_id||'')||0)+1;counts.set(e.group_id||'',n);result.set(e,n);}return result;};
          const newOrdinals=ordinals(events),oldOrdinals=ordinals(oldEvents);
          const label=(e,sourceGroups)=>[scope(e,sourceGroups),'作息与日程','日程「'+(e.title||'未命名日程')+'」（'+((sourceGroups===groups?newOrdinals:oldOrdinals).get(e))+'）'];
          // Schedule IDs are stable, so unrelated items never appear changed when another is removed.
          const seen=new Set(),oldById=new Map(),newIds=new Set(events.map(e=>e.id));
          oldEvents.forEach((event,index)=>{if(!oldById.has(event.id))oldById.set(event.id,[]);oldById.get(event.id).push(index);});
          for(const event of events){
            const index=oldById.get(event.id)?.shift()??-1;
            if(index<0){add(label(event,groups),'（新增）');continue;}
            seen.add(index);if(!equal(oldEvents[index],event))walk(oldEvents[index],event,eventFields,label(event,groups));
          }
          oldEvents.forEach((e,i)=>{if(!seen.has(i))add(label(e,oldGroups),'（删除）');});
          const before=oldEvents.filter(e=>newIds.has(e.id)).map(e=>e.id),after=events.filter(e=>oldById.has(e.id)).map(e=>e.id);
          if(!equal(before,after))add(['作息与日程','日程排列顺序']);
        }
        return [...new Set(locations)];
      }
    };
  }
  window.ActiveMessageChanges={createTracker};
})();
