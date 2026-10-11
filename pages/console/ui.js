/* Local-only UI primitives. No native alert/confirm/prompt and no external assets. */
(() => {
  'use strict';
  const node = (tag, text, cls) => { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; };
  // A single floating surface keeps help out of layout, including inside dialogs.
  const helpPopup=node('aside',undefined,'help-popup');helpPopup.id='help-popup';helpPopup.hidden=true;helpPopup.setAttribute('role','tooltip');
  const helpTitle=node('strong'),helpText=node('div',undefined,'help-text');
  helpPopup.append(helpTitle,helpText);document.body.append(helpPopup);
  let helpActive=null,helpPinned=false,helpTimer=0,helpSerial=0,helpPointer=false;
  function hideHelp(){
    clearTimeout(helpTimer);helpActive?.button.setAttribute('aria-expanded','false');
    helpActive=null;helpPinned=false;helpPointer=false;helpPopup.hidden=true;
  }
  function placeHelp(){
    if(!helpActive)return;
    const button=helpActive.button;
    if(!button.isConnected||button.closest('[inert],[hidden]'))return hideHelp();
    const view=window.visualViewport,left=view?.offsetLeft||0,top=view?.offsetTop||0,width=view?.width||innerWidth,height=view?.height||innerHeight;
    const r=button.getBoundingClientRect(),margin=10,gap=7;
    if(r.bottom<top||r.top>top+height)return hideHelp();
    helpPopup.style.width=Math.min(400,width-2*margin)+'px';
    const below=top+height-r.bottom-gap-margin,above=r.top-top-gap-margin;
    const down=below>=Math.min(240,above);
    helpPopup.style.maxHeight=Math.max(60,Math.min(height-2*margin,down?below:above))+'px';
    const h=helpPopup.getBoundingClientRect().height,w=helpPopup.getBoundingClientRect().width;
    helpPopup.style.left=Math.max(left+margin,Math.min(r.left,left+width-w-margin))+'px';
    helpPopup.style.top=Math.max(top+margin,Math.min(down?r.bottom+gap:r.top-h-gap,top+height-h-margin))+'px';
  }
  function showHelp(item){
    clearTimeout(helpTimer);
    if(helpActive!==item){hideHelp();helpActive=item;helpTitle.textContent=item.label;helpText.textContent=item.text;helpPopup.scrollTop=0;}
    // Keep modal help inside its accessible dialog, outside its scrolling form content.
    const host=item.button.closest('.modal')||document.body;if(helpPopup.parentElement!==host)host.append(helpPopup);
    helpPopup.hidden=false;item.button.setAttribute('aria-expanded','true');placeHelp();
  }
  function deferHelpClose(){
    clearTimeout(helpTimer);helpTimer=setTimeout(()=>{
      if(helpActive&&!helpPinned&&!helpPointer&&!helpActive.hovered&&!helpActive.button.matches(':focus-visible'))hideHelp();
    },220);
  }
  function help(label,text,id,triggerText){
    const wrap=node('span',undefined,'help-control'),button=node('button',undefined,'help-trigger'),description=node('span',text,'help-description');
    button.type='button';
    if(triggerText===undefined){const icon=node('span','?','help-icon');icon.setAttribute('aria-hidden','true');button.append(icon);}
    else{button.textContent=triggerText;button.classList.add('help-tag','tag');}
    description.id=id||'help-description-'+(++helpSerial);
    button.setAttribute('aria-label',label+'的说明');button.setAttribute('aria-describedby',description.id);button.setAttribute('aria-controls','help-popup');button.setAttribute('aria-expanded','false');
    const item={button,label,text,hovered:false};
    button.addEventListener('pointerenter',event=>{if(event.pointerType!=='mouse')return;item.hovered=true;showHelp(item);});
    button.addEventListener('pointerleave',()=>{item.hovered=false;deferHelpClose();});
    button.addEventListener('focus',()=>{if(button.matches(':focus-visible'))showHelp(item);});
    button.addEventListener('blur',deferHelpClose);
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(helpActive===item&&helpPinned)hideHelp();else{showHelp(item);helpPinned=true;}});
    wrap.append(button,description);return wrap;
  }
  function helpTag(label,text,caption=label){return help(label,text,undefined,caption);}
  function helpNote(label,text){const note=node('span',undefined,'help-note');note.append(node('span',label),help(label,text));return note;}
  helpPopup.addEventListener('pointerenter',()=>{helpPointer=true;clearTimeout(helpTimer);});
  helpPopup.addEventListener('pointerleave',()=>{helpPointer=false;deferHelpClose();});
  // Fixed help surfaces do not natively chain wheel events to a scrolling dialog.
  // Read long help normally; at either boundary, pass the wheel to its dialog.
  helpPopup.addEventListener('wheel',event=>{
    const modal=helpActive?.button.closest('.modal');
    if(!modal||event.ctrlKey||!event.deltaY||Math.abs(event.deltaX)>Math.abs(event.deltaY))return;
    const canScrollHelp=event.deltaY<0?helpPopup.scrollTop>0:helpPopup.scrollTop+helpPopup.clientHeight<helpPopup.scrollHeight-1;
    if(canScrollHelp)return;
    const unit=event.deltaMode===1?parseFloat(getComputedStyle(helpPopup).lineHeight):event.deltaMode===2?modal.clientHeight:1;
    const before=modal.scrollTop;modal.scrollTop+=event.deltaY*unit;
    if(modal.scrollTop!==before)event.preventDefault();
  },{passive:false});
  document.addEventListener('pointerdown',event=>{if(helpActive&&!helpActive.button.contains(event.target)&&!helpPopup.contains(event.target))hideHelp();},true);
  document.addEventListener('focusin',event=>{if(helpActive&&!helpActive.button.contains(event.target)&&!helpPopup.contains(event.target))hideHelp();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&helpActive){event.preventDefault();event.stopImmediatePropagation();hideHelp();}},true);
  document.addEventListener('active-message-dialog-open',hideHelp);
  document.addEventListener('scroll',event=>{if(helpActive&&!helpPopup.contains(event.target))placeHelp();},true);
  window.addEventListener('resize',placeHelp);window.visualViewport?.addEventListener('resize',placeHelp);window.visualViewport?.addEventListener('scroll',placeHelp);
  new MutationObserver(()=>{if(helpActive&&(!helpActive.button.isConnected||helpActive.button.closest('[hidden],[inert]')))hideHelp();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','inert']});
  let activeDialog=false;
  function dialog({title, message='', confirm='确定', cancel='取消', danger=false, content=null, highlight=null, validate=null}) {
    if(activeDialog)return Promise.resolve(false);
    activeDialog=true;document.dispatchEvent(new Event("active-message-dialog-open"));
    return new Promise(resolve=>{
      const previous=document.activeElement, shell=document.querySelector('.shell');
      const wasInert=shell.inert; shell.inert=true;
      const layer=node('div',undefined,'modal-layer'), box=node('section',undefined,'modal');
      box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby','dialog-title');
      const heading=node('h2',title);heading.id='dialog-title';box.append(heading,node('p',message));if(content)box.append(content);
      const actions=node('div',undefined,'actions'), no=node('button',cancel), yes=node('button',confirm,danger?'danger':'primary');
      let updateHighlight=null, highlightObserver=null;
      if(highlight){
        layer.classList.add('tour-layer');const spot=node('div',undefined,'tour-highlight');layer.prepend(spot);
        updateHighlight=()=>{const r=highlight.getBoundingClientRect();Object.assign(spot.style,{left:(r.left-5)+'px',top:(r.top-5)+'px',width:(r.width+10)+'px',height:(r.height+10)+'px'});};
        updateHighlight();highlightObserver=new ResizeObserver(updateHighlight);highlightObserver.observe(highlight);window.addEventListener('resize',updateHighlight);window.addEventListener('scroll',updateHighlight,true);
      }
      let done=false;
      const close=value=>{if(done)return;done=true;hideHelp();document.body.append(helpPopup);if(updateHighlight){highlightObserver?.disconnect();window.removeEventListener('resize',updateHighlight);window.removeEventListener('scroll',updateHighlight,true);}layer.remove();shell.inert=wasInert;activeDialog=false;previous?.focus?.();resolve(value);};
      no.onclick=()=>close(false);yes.onclick=()=>{if(!validate||validate()!==false)close(true);};actions.append(no,yes);box.append(actions);layer.append(box);document.body.append(layer);
      layer.addEventListener('keydown',event=>{
        if(event.key==='Escape'){event.preventDefault();close(false);}
        if(event.key==='Tab'){
          const focusable=[...box.querySelectorAll('button,input,textarea,select,[tabindex="0"]')].filter(n=>!n.disabled);
          if(event.shiftKey&&document.activeElement===focusable[0]){event.preventDefault();focusable.at(-1)?.focus();}
          else if(!event.shiftKey&&document.activeElement===focusable.at(-1)){event.preventDefault();focusable[0]?.focus();}
        }
      });no.focus();
    });
  }
  async function copyText(text, report) {
    // execCommand runs synchronously within the click gesture, including opaque-origin Pages frames.
    const previous=document.activeElement, input=node('textarea');input.value=text;input.setAttribute('aria-label','待复制内容');
    input.className='clipboard-buffer';document.body.append(input);input.focus();input.select();
    let copied=false;try{copied=document.execCommand('copy');}catch{}input.remove();previous?.focus?.();
    if(!copied&&navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(text);copied=true;}catch{}}
    if(copied){report('已复制。');return true;}
    const manual=node('textarea');manual.value=text;manual.readOnly=true;manual.rows=5;manual.setAttribute('aria-label','手动复制内容');
    await dialog({title:'请手动复制',message:'浏览器未允许自动复制。选择下方文字后使用 Ctrl+C（Mac 使用 Command+C）。',content:manual,confirm:'我知道了',cancel:'关闭'});
    return false;
  }
  let activeDateRange=null;
  function dateRangePicker({start='',end='',today='',onChange}){
    const wrap=node('div',undefined,'date-range-control'),from=node('input'),to=node('input'),pick=node('button','选日期'),clear=node('button','清空'),error=node('small',undefined,'warning');
    const serial=++helpSerial,fromLabel=node('label','从'),toLabel=node('label','到');
    from.id='date-range-from-'+serial;to.id='date-range-to-'+serial;fromLabel.htmlFor=from.id;toLabel.htmlFor=to.id;
    for(const input of [from,to]){input.type='date';input.min='1900-01-01';input.max='2199-12-31';}
    from.value=start;to.value=end;from.setAttribute('aria-label','筛选开始日期');to.setAttribute('aria-label','筛选结束日期');
    pick.type=clear.type='button';error.hidden=true;error.setAttribute('role','status');
    wrap.append(fromLabel,from,toLabel,to,pick,clear,error);
    let popup=null,observer=null,draftStart='',draftEnd='',hovered='',month='';
    const iso=date=>date.toISOString().slice(0,10),date=value=>new Date(value+'T12:00:00Z');
    const anchor=()=>((typeof today==='function'?today():today)||new Date().toLocaleDateString('sv-SE'));
    function commit(a,b){
      let message='';
      if(!from.validity.valid||!to.validity.valid)message='日期需要在 1900～2199 年之间。';
      else if(a&&b&&a>b)message='结束日期不能早于开始日期。';
      error.textContent=message;error.hidden=!message;
      if(message)return false;
      onChange({start:a,end:b});return true;
    }
    from.onchange=to.onchange=()=>commit(from.value,to.value);
    clear.onclick=()=>{from.value=to.value='';if(commit('',''))hide();};
    function outside(event){if(!popup?.contains(event.target)&&!wrap.contains(event.target))hide();}
    function escape(event){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();hide();pick.focus();}}
    function place(){
      if(!popup)return;
      const view=window.visualViewport,r=pick.getBoundingClientRect(),left=view?.offsetLeft||0,top=view?.offsetTop||0,width=view?.width||innerWidth,height=view?.height||innerHeight,margin=8;
      popup.style.width=Math.min(310,width-2*margin)+'px';popup.style.maxHeight=Math.max(100,height-2*margin)+'px';
      const h=popup.getBoundingClientRect().height,w=popup.getBoundingClientRect().width;
      popup.style.left=Math.max(left+margin,Math.min(r.left,left+width-w-margin))+'px';
      popup.style.top=Math.max(top+margin,Math.min(r.bottom+h+margin<=top+height?r.bottom+6:r.top-h-6,top+height-h-margin))+'px';
    }
    function hide(){
      if(!popup)return;
      popup.remove();popup=null;observer?.disconnect();pick.setAttribute('aria-expanded','false');
      document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);document.removeEventListener('scroll',place,true);window.removeEventListener('resize',place);
      window.visualViewport?.removeEventListener('resize',place);window.visualViewport?.removeEventListener('scroll',place);if(activeDateRange===hide)activeDateRange=null;
    }
    function move(delta){
      const value=date(month+'-01');value.setUTCMonth(value.getUTCMonth()+delta);
      if(value.getUTCFullYear()<1900||value.getUTCFullYear()>2199)return;
      month=iso(value).slice(0,7);draw();
    }
    function draw(){
      if(!popup)return;
      const focusLabel=popup.contains(document.activeElement)?document.activeElement.getAttribute('aria-label'):null;
      popup.replaceChildren();
      const header=node('div',undefined,'date-range-header'),prev=node('button','‹'),next=node('button','›'),jump=node('input'),close=node('button','×');
      prev.setAttribute('aria-label','范围日历上月');next.setAttribute('aria-label','范围日历下月');close.setAttribute('aria-label','关闭范围日历');
      prev.disabled=month==='1900-01';next.disabled=month==='2199-12';prev.onclick=()=>move(-1);next.onclick=()=>move(1);close.onclick=hide;
      jump.type='month';jump.min='1900-01';jump.max='2199-12';jump.value=month;jump.setAttribute('aria-label','范围日历月份');
      jump.onchange=()=>{if(jump.value&&jump.validity.valid){month=jump.value;draw();}};header.append(prev,jump,next,close);popup.append(header);
      const instruction=node('small','先点开始日期，再点结束日期；选一个日期也能应用。');popup.append(instruction);
      const grid=node('div',undefined,'calendar-grid date-range-grid');
      ['一','二','三','四','五','六','日'].forEach(day=>grid.append(node('span',day,'calendar-weekday')));
      const first=date(month+'-01');first.setUTCDate(first.getUTCDate()-(first.getUTCDay()+6)%7);
      const cells=[];
      function shade(){
        const boundary=draftEnd||hovered||draftStart,low=[draftStart,boundary].filter(Boolean).sort()[0],high=[draftStart,boundary].filter(Boolean).sort().at(-1);
        for(const {button,value} of cells){const endpoint=value===draftStart||value===draftEnd;button.classList.toggle('range-endpoint',endpoint);button.classList.toggle('in-range',!!low&&value>=low&&value<=high);button.setAttribute('aria-pressed',String(endpoint));}
      }
      for(let index=0;index<42;index++){
        const day=new Date(first);day.setUTCDate(day.getUTCDate()+index);const value=iso(day),button=node('button',String(day.getUTCDate()),'calendar-day');
        button.type='button';button.dataset.date=value;button.setAttribute('aria-label',value);button.disabled=value<'1900-01-01'||value>'2199-12-31';
        if(value.slice(0,7)!==month)button.classList.add('outside-month');if(value===anchor())button.classList.add('range-today');
        button.onclick=()=>{if(!draftStart||draftEnd){draftStart=value;draftEnd='';}else{[draftStart,draftEnd]=[draftStart,value].sort();}hovered='';draw();};
        button.onpointerenter=()=>{if(draftStart&&!draftEnd){hovered=value;shade();}};cells.push({button,value});grid.append(button);
      }
      grid.onpointerleave=()=>{hovered='';shade();};shade();popup.append(grid);
      const shortcuts=node('div',undefined,'date-range-shortcuts');
      for(const [label,kind] of [['今天','today'],['本周','week'],['本月','month']]){
        const button=node('button',label);button.onclick=()=>{const a=date(anchor()),b=date(anchor());if(kind==='week'){a.setUTCDate(a.getUTCDate()-(a.getUTCDay()+6)%7);b.setTime(a.getTime());b.setUTCDate(b.getUTCDate()+6);}else if(kind==='month'){a.setUTCDate(1);b.setUTCMonth(b.getUTCMonth()+1,0);}draftStart=iso(a);draftEnd=iso(b);month=draftStart.slice(0,7);draw();};shortcuts.append(button);
      }
      popup.append(shortcuts,node('small',(draftStart||'不限开始')+' ～ '+(draftEnd||'不限结束'),'date-range-summary'));
      const actions=node('div',undefined,'date-range-actions'),reset=node('button','清空'),apply=node('button','应用日期','primary');
      reset.onclick=()=>{draftStart=draftEnd=hovered='';draw();};apply.onclick=()=>{from.value=draftStart;to.value=draftEnd;if(commit(draftStart,draftEnd))hide();};actions.append(reset,apply);popup.append(actions);place();
      if(focusLabel)[...popup.querySelectorAll('[aria-label]')].find(item=>item.getAttribute('aria-label')===focusLabel)?.focus({preventScroll:true});
    }
    pick.setAttribute('aria-haspopup','dialog');pick.setAttribute('aria-expanded','false');
    pick.onclick=()=>{
      if(popup)return hide();activeDateRange?.();hideHelp();activeDateRange=hide;
      draftStart=from.value;draftEnd=to.value;hovered='';month=(draftStart||draftEnd||anchor()).slice(0,7);
      popup=node('div',undefined,'date-range-popup');popup.id='date-range-popup-'+serial;popup.setAttribute('role','dialog');popup.setAttribute('aria-label','筛选日期范围');pick.setAttribute('aria-controls',popup.id);pick.setAttribute('aria-expanded','true');document.body.append(popup);draw();
      document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);document.addEventListener('scroll',place,true);window.addEventListener('resize',place);
      window.visualViewport?.addEventListener('resize',place);window.visualViewport?.addEventListener('scroll',place);
      observer=new MutationObserver(()=>{if(!pick.isConnected||pick.closest('[hidden],[inert]'))hide();});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','inert']});
      popup.querySelector('input').focus();
    };
    return wrap;
  }
  window.ActiveMessageUI={node,dialog,copyText,help,helpTag,helpNote,hideHelp,dateRangePicker};
})();
