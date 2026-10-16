/* Draft comparison is local, value-free, and independent of preview requests. */
(() => {
  'use strict';
  const {t,runtime:R,value:V}=window.ActiveMessageI18n;
  const internal=key=>key==='__template_key'||key==='agenda_exclusions';
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  function equal(a,b){
    if(a===b)return true;
    if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
    if(!object(a)||!object(b))return false;
    const keys=Object.keys(a).filter(k=>!internal(k)),other=Object.keys(b).filter(k=>!internal(k));
    return keys.length===other.length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
  }
  const groupSections=()=>({interjection_mode:t("pages.console.ui.s5453160ded"),threshold_override:t("pages.console.ui.s5453160ded"),decision_mode:t("pages.console.ui.s5453160ded"),interjection_overrides:t("pages.console.ui.s5453160ded"),decision_overrides:t("pages.console.ui.s5453160ded"),interjection_weights:t("pages.console.ui.s5453160ded"),interjection_activity:t("pages.console.ui.s5453160ded"),interjection_energy:t("pages.console.ui.s5453160ded"),cooldown_override:t("pages.console.ui.s2cb02a6a10"),proactive_mode:t("pages.console.ui.s5e6f228dbe"),routine_overrides:t("pages.console.ui.sf284e9eacb"),context_overrides:t("pages.console.ui.s994242dcac"),agenda_mode:t("pages.console.ui.sf284e9eacb"),agenda_exclusions:t("pages.console.ui.sf284e9eacb"),agenda_preview_days:t("pages.console.ui.sf284e9eacb"),agenda_max_items:t("pages.console.ui.sf284e9eacb")});
  const globalSections=()=>({routine:t("pages.console.ui.sf284e9eacb"),enabled:t("pages.console.ui.s80959ffa56"),interjection:t("pages.console.ui.s5453160ded"),activation_prompts:t("pages.console.ui.s5453160ded"),context:t("pages.console.ui.s994242dcac"),diagnostics:t("pages.console.ui.s994242dcac"),runtime:t("pages.console.ui.s994242dcac")});
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
        const groupName=(value,index)=>t('pages.console.group_label',{name:value?.group_name||t("pages.console.ui.sd82edc4765"),index:index+1});
        for(const key of new Set([...Object.keys(saved),...Object.keys(current)])){
          if(internal(key)||key==='session_groups'||key==='agenda'||equal(saved[key],current[key]))continue;
          const meta=schema[key]||{};
          if(key==='proactive_chat'){
            for(const field of new Set([...Object.keys(saved[key]||{}),...Object.keys(current[key]||{})])){
              if(!equal(saved[key]?.[field],current[key]?.[field]))add([t("pages.console.ui.sa5644f4bbf"),t("pages.console.ui.s5e6f228dbe"),meta.items?.[field]?.description||field]);
            }
          }else if(meta.type==='object')walk(saved[key],current[key],meta.items,[t("pages.console.ui.sa5644f4bbf"),globalSections()[key]||meta.description||key,...(['context','diagnostics','runtime'].includes(key)?[meta.description||key]:[])]);
          else add([t("pages.console.ui.sa5644f4bbf"),globalSections()[key]||'',meta.description||key]);
        }
        if(!equal(oldGroups,groups)){
          const entries=matchGroups(groups),groupFields=schema.session_groups?.templates?.group?.items||{};
          const currentKeys=new Set(entries.map(r=>r.key)),oldKeys=new Set(baseGroups.map(r=>r.key)),sharedOld=[...oldKeys].filter(k=>currentKeys.has(k)),sharedNow=[...currentKeys].filter(k=>oldKeys.has(k));
          if(!equal(sharedOld,sharedNow))add([t("pages.console.ui.s2cb02a6a10"),t("pages.console.ui.s08f059cebf")]);
          entries.forEach((row,index)=>{
            const before=baseByKey.get(row.key)?.value,after=row.value,name=groupName(after,index);
            if(!before){add([t("pages.console.ui.s2cb02a6a10"),name],t("pages.console.ui.s7cfa5bc81f"));return;}
            for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
              if(internal(key)||key==='agenda_id'||equal(before[key],after[key]))continue;
              const meta=groupFields[key]||{};
              if(key==='proactive_overrides'){
                for(const field of new Set([...Object.keys(before[key]||{}),...Object.keys(after[key]||{})])){
                  if(!equal(before[key]?.[field],after[key]?.[field]))add([name,t("pages.console.ui.s5e6f228dbe"),meta.items?.[field]?.description||field]);
                }
              }else if(meta.type==='object')walk(before[key],after[key],meta.items,[name,groupSections()[key]||t("pages.console.ui.s2cb02a6a10"),...(['interjection_weights','interjection_activity','interjection_energy'].includes(key)?[meta.description||key]:[])]);
              else add([name,groupSections()[key]||t("pages.console.ui.s2cb02a6a10"),meta.description||key]);
            }
          });
          baseGroups.forEach((row,index)=>{if(!currentKeys.has(row.key))add([t("pages.console.ui.s2cb02a6a10"),groupName(row.value,index)],t("pages.console.ui.s461a806eb4"));});
        }
        const agendaMeta=schema.agenda?.items||{};
        walk(Object.fromEntries(Object.entries(saved.agenda||{}).filter(([k])=>k!=='events')),Object.fromEntries(Object.entries(current.agenda||{}).filter(([k])=>k!=='events')),agendaMeta,[t("pages.console.ui.sa5644f4bbf"),t("pages.console.ui.sf284e9eacb")]);
        return [...new Set(locations)];
      }
    };
  }
  window.ActiveMessageChanges={createTracker};
})();
