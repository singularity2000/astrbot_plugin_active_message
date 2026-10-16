/* Shared native-plugin language resources; no user text or raw snapshots are translated. */
(() => {
  'use strict';
  const bridge=window.AstrBotPluginView||window.AstrBotPluginPage;
  let resources=bridge?.getI18n?.()||{},locale='zh-CN',reverse=new Map(),patterns=[];
  const fallbacks=new Map([...document.querySelectorAll('[data-i18n]')].map(node=>[node.dataset.i18n,node.textContent]));
  document.querySelectorAll('[data-i18n-label]').forEach(node=>fallbacks.set(node.dataset.i18nLabel,node.getAttribute('aria-label')||''));
  document.querySelectorAll('[data-i18n-title]').forEach(node=>fallbacks.set(node.dataset.i18nTitle,node.title));
  const bootAliases={'pages.console.ui.s2af288c513':'pages.console.static.save',
    'pages.console.ui.sf8df46f8c6':'pages.console.static.waiting',
    'pages.console.static.connection_failed':'pages.console.static.waiting',
    'pages.console.static.startup_failed_title':'pages.console.static.brand'};
  const at=(object,path)=>path.split('.').reduce((value,key)=>value?.[key],object);
  const t=(key,args={})=>{
    const fallback=fallbacks.get(key)??fallbacks.get(bootAliases[key])??'';
    const value=at(resources[locale],key)??at(resources['zh-CN'],key)??bridge?.t?.(key,fallback)??fallback;
    return String(value).replace(/\{(\w+)\}/g,(token,name)=>Object.hasOwn(args,name)?String(args[name]):token);
  };
  function rebuild(){
    reverse=new Map();patterns=[];
    for(const [key,source] of Object.entries(resources['zh-CN']?.pages?.console?.runtime||{})){
      const translated=resources[locale]?.pages?.console?.runtime?.[key]??source;
      reverse.set(source,translated);
      if(/\{\w+\}/.test(source)){
        const names=[],escaped=source.split(/(\{\w+\})/).map(part=>{
          if(/^\{\w+\}$/.test(part)){names.push(part.slice(1,-1));return '([\\s\\S]*?)';}
          return part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        }).join('');
        patterns.push({match:new RegExp('^'+escaped+'$'),names,translated});
      }
    }
    for(const [key,source] of Object.entries(resources['zh-CN']?.phases||{}))reverse.set(source,resources[locale]?.phases?.[key]??source);
    for(const [code,row] of Object.entries(resources['zh-CN']?.diagnostics||{}))reverse.set(row.message,resources[locale]?.diagnostics?.[code]?.message??row.message);
  }
  function runtime(value,depth=0){
    if(typeof value!=='string'||locale==='zh-CN')return value;
    if(reverse.has(value))return reverse.get(value);
    for(const pattern of patterns){const match=pattern.match.exec(value);if(match){const args=Object.fromEntries(pattern.names.map((name,index)=>[name,depth<4&&['result','reason','phase','source'].includes(name)?runtime(match[index+1],depth+1):match[index+1]]));return pattern.translated.replace(/\{(\w+)\}/g,(token,name)=>args[name]??token);}}
    return value;
  }
  function schema(source){
    const result=structuredClone(source),texts=resources[locale]?.config||{};
    function walk(fields,translations){for(const [key,field] of Object.entries(fields)){const text=translations[key]||{};for(const attr of ['description','hint','labels','name'])if(Object.hasOwn(text,attr))field[attr]=structuredClone(text[attr]);if(field.type==='object'&&field.items)walk(field.items,text);for(const [name,template] of Object.entries(field.templates||{})){const row=text.templates?.[name]||{};if(row.name)template.name=row.name;walk(template.items,row);}}}
    walk(result,texts);return result;
  }
  function placeholders(source){return source.map(row=>({...row,...resources[locale]?.placeholders?.[row.name]}));}
  const value=source=>resources[locale]?.enums?.[source]??source;
  function applyStatic(){
    document.documentElement.lang=locale;
    document.querySelectorAll('[data-i18n]').forEach(node=>node.textContent=t(node.dataset.i18n));
    document.querySelectorAll('[data-i18n-label]').forEach(node=>node.setAttribute('aria-label',t(node.dataset.i18nLabel)));
    document.querySelectorAll('[data-i18n-title]').forEach(node=>node.title=t(node.dataset.i18nTitle));
    document.title=t('pages.console.title')||t('pages.console.static.brand')||document.title;
  }
  window.ActiveMessageI18n={t,runtime,schema,placeholders,applyStatic,value,
    diagnostic:code=>resources[locale]?.diagnostics?.[code]??resources['zh-CN']?.diagnostics?.[code],
    load(data){if(data&&typeof data==='object'&&Object.keys(data).length)resources=data;rebuild();},
    isLoaded:()=>!!resources['zh-CN']?.pages?.console?.ui,
    setLocale(value){locale=value==='en-US'?'en-US':'zh-CN';rebuild();applyStatic();document.dispatchEvent(new Event('active-message-language'));},
    getLocale:()=>locale};
})();
