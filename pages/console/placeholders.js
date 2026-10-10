/* One focus-aware helper for every supported template field. No network or storage. */
(() => {
  'use strict';
  const {node:el,help}=window.ActiveMessageUI;
  window.createPlaceholderDock = ({catalog, report}) => {
    let target=null, start=0, end=0;
    const dock=el('aside',undefined,'placeholder-dock');dock.hidden=true;dock.setAttribute('aria-label','占位符插入助手');
    const header=el('div',undefined,'dock-head'),title=el('strong'),search=el('input'),close=el('button','收起');
    search.type='search';search.placeholder='搜索占位符或用途';search.setAttribute('aria-label','搜索可用占位符');
    const items=el('div',undefined,'dock-items');
    header.append(title,search,close);dock.append(header,items);document.body.append(dock);
    function measure(){const height=dock.hidden?0:dock.getBoundingClientRect().height+18;document.documentElement.style.setProperty('--dock-height',height+'px');document.body.style.paddingBottom=height+'px';}
    function hide(){dock.hidden=true;target=null;measure();}
    function remember(){if(target&&document.activeElement===target.input){start=target.input.selectionStart??target.input.value.length;end=target.input.selectionEnd??start;}}
    function insert(p){
      if(!target||!target.input.isConnected||!p.phases.includes(target.phase))return hide();
      const input=target.input;input.setRangeText(p.token,start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));
      input.focus({preventScroll:true});start=end=input.selectionEnd;report('已插入 '+p.token+'；保存后生效。');
    }
    function draw(){
      items.replaceChildren();const q=search.value.trim().toLowerCase();
      for(const p of catalog().filter(p=>target&&p.phases.includes(target.phase)&&(!q||(p.name+p.description).toLowerCase().includes(q)))){
        const button=el('button',undefined,'dock-token');button.append(el('code',p.token),el('span',p.description));
        button.setAttribute('aria-label','插入 '+p.token+'：'+p.description);button.onpointerdown=e=>e.preventDefault();button.onclick=()=>insert(p);const item=el('div',undefined,'dock-item');item.append(button,help(p.name||p.token,p.description+'\n示例：'+p.example));items.append(item);
      }
      if(!items.childElementCount)items.append(el('p','没有匹配的占位符。','muted'));
      measure();
    }
    function show(input,phase,label){
      const changed=target?.input!==input;target={input,phase,label};remember();title.textContent='插入到：'+label;
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
