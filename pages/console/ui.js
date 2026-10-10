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
  function help(label,text,id){
    const wrap=node('span',undefined,'help-control'),button=node('button',undefined,'help-trigger'),icon=node('span','?','help-icon'),description=node('span',text,'help-description');
    button.type='button';icon.setAttribute('aria-hidden','true');button.append(icon);
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
  window.ActiveMessageUI={node,dialog,copyText,help,helpNote,hideHelp};
})();
