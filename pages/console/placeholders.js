/* One focus-aware helper for every supported template field. No network or storage. */
(() => {
  'use strict';
  const {t,runtime:R,value:V}=window.ActiveMessageI18n;
  const {node:el,help}=window.ActiveMessageUI;
  window.createPlaceholderDock = ({catalog, report}) => {
    let target=null, start=0, end=0;
    const dock=el('aside',undefined,'placeholder-dock');dock.hidden=true;dock.setAttribute('aria-label',t("pages.console.ui.s329137b800"));
    const header=el('div',undefined,'dock-head'),title=el('strong'),search=el('input'),close=el('button',t("pages.console.ui.s5d5815647c"));
    search.type='search';search.placeholder=t("pages.console.ui.sbc554ef139");search.setAttribute('aria-label',t("pages.console.ui.sb0828f98af"));
    const items=el('div',undefined,'dock-items');
    header.append(title,search,close);dock.append(header,items);document.body.append(dock);
    function measure(){const height=dock.hidden?0:dock.getBoundingClientRect().height+18;document.documentElement.style.setProperty('--dock-height',height+'px');document.body.style.paddingBottom=height+'px';}
    function hide(){dock.hidden=true;target=null;measure();}
    document.addEventListener('active-message-language',()=>{
      hide();dock.setAttribute('aria-label',t("pages.console.ui.s329137b800"));
      close.textContent=t("pages.console.ui.s5d5815647c");search.placeholder=t("pages.console.ui.sbc554ef139");search.setAttribute('aria-label',t("pages.console.ui.sb0828f98af"));
    });
    function remember(){if(target&&document.activeElement===target.input){start=target.input.selectionStart??target.input.value.length;end=target.input.selectionEnd??start;}}
    function insert(p){
      if(!target||!target.input.isConnected||!p.phases.includes(target.phase))return hide();
      const input=target.input;input.setRangeText(p.token,start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));
      input.focus({preventScroll:true});start=end=input.selectionEnd;report(t("pages.console.ui.s7d3408fba6")+p.token+t("pages.console.ui.s81163075af"));
    }
    function draw(){
      items.replaceChildren();const q=search.value.trim().toLowerCase();
      for(const p of catalog().filter(p=>target&&p.phases.includes(target.phase)&&(!q||(p.name+p.description).toLowerCase().includes(q)))){
        const button=el('button',undefined,'dock-token');button.append(el('code',p.token),el('span',p.description));
        button.setAttribute('aria-label',t("pages.console.ui.s1f21e94af2")+p.token+'：'+p.description);button.onpointerdown=e=>e.preventDefault();button.onclick=()=>insert(p);const item=el('div',undefined,'dock-item');item.append(button,help(p.name||p.token,p.description+t("pages.console.ui.s8e06d446f5")+p.example));items.append(item);
      }
      if(!items.childElementCount)items.append(el('p',t("pages.console.ui.s495f93d511"),'muted'));
      measure();
    }
    function show(input,phase,label){
      const changed=target?.input!==input;target={input,phase,label};remember();title.textContent=t("pages.console.ui.se890a1bd59")+label;
      if(changed)search.value='';dock.hidden=false;draw();
      requestAnimationFrame(()=>{const r=input.getBoundingClientRect(),top=dock.getBoundingClientRect().top;if(r.bottom>top-12&&r.height<top-80)input.scrollIntoView({block:'center',behavior:'instant'});});
    }
    search.oninput=draw;close.onclick=hide;
    document.addEventListener('selectionchange',remember);
    document.addEventListener('pointerdown',e=>{if(target&&e.target!==target.input&&!dock.contains(e.target)&&!e.target.closest('.help-popup'))hide();});
    document.addEventListener('focusin',e=>{if(target&&e.target!==target.input&&!dock.contains(e.target)&&!e.target.closest('.help-popup'))hide();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!dock.hidden){e.preventDefault();hide();}});
    document.addEventListener('active-message-dialog-open',hide);
    new ResizeObserver(measure).observe(dock);
    return {show,hide};
  };
})();
