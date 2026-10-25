/* Local-only UI primitives. No native alert/confirm/prompt and no external assets. */
(() => {
  'use strict';
  const {t,runtime:R,value:V}=window.ActiveMessageI18n;
  const node = (tag, text, cls) => { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; };
  let sessionNames=Object.create(null),sessionPattern=null;
  const sessionLabel=sid=>{const value=String(sid??''),name=sessionNames[value];return typeof name==='string'&&name?value+'（'+name+'）':value;};
  function sessionReferences(value){
    const text=String(value??'');
    if(!sessionPattern)return '';
    return [...new Set([...text.matchAll(sessionPattern)].map(match=>match[0]))].map(sessionLabel).join('、');
  }
  function sessionText(value){
    const text=String(value??'');
    return sessionPattern?text.replace(sessionPattern,(sid,offset)=>text[offset+sid.length]==='（'?sid:sessionLabel(sid)):text;
  }
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
    button.setAttribute('aria-label',label+t("pages.console.ui.sfd33aae360"));button.setAttribute('aria-describedby',description.id);button.setAttribute('aria-controls','help-popup');button.setAttribute('aria-expanded','false');
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
  // Restore the same reading anchor after a local redraw, not just scrollY.
  const viewRestores=new WeakMap();
  function preserveView(root=document.getElementById('content')) {
    if(!root)return ()=>{};
    const key=n=>n.id||n.dataset.viewKey||n.dataset.path||n.querySelector(':scope > summary,:scope > h2')?.textContent||'';
    const describe=n=>{const value=key(n);return {value,index:[...root.querySelectorAll('[id],[data-view-key],[data-path],details,.section')].filter(x=>key(x)===value).indexOf(n)};};
    const find=d=>d?.value?[...root.querySelectorAll('[id],[data-view-key],[data-path],details,.section')].filter(n=>key(n)===d.value)[d.index]:null;
    const details=[...root.querySelectorAll('details')].map(n=>({identity:describe(n),open:n.open}));
    const top=document.querySelector('header')?.getBoundingClientRect().bottom||0;
    const anchor=[...root.querySelectorAll('.field,.agenda-row,.section,details')].find(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.top>=top-1&&r.top<innerHeight;});
    const identity=anchor?describe(anchor):null,anchorTop=anchor?.getBoundingClientRect().top;
    const focused=root.contains(document.activeElement)?document.activeElement:null,focusId=focused?.id;
    const selection=focused&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
    const position={left:scrollX,top:scrollY};let ticket;
    return ()=>{
      ticket={};viewRestores.set(root,ticket);
      details.forEach(d=>{const n=find(d.identity);if(n?.tagName==='DETAILS')n.open=d.open;});
      const restore=()=>{
        const target=find(identity),delta=target?target.getBoundingClientRect().top-anchorTop:0;
        window.scrollTo({left:position.left,top:target?scrollY+delta:position.top,behavior:'instant'});
      };
      if(focusId&&!document.querySelector('.shell')?.inert){const n=document.getElementById(focusId);if(n&&root.contains(n)){n.focus({preventScroll:true});if(selection&&n.setSelectionRange)try{n.setSelectionRange(...selection);}catch{}}}
      restore();const y=scrollY,x=scrollX,view=root.dataset.view;
      requestAnimationFrame(()=>{if(viewRestores.get(root)===ticket&&root.dataset.view===view&&Math.abs(scrollY-y)<2&&Math.abs(scrollX-x)<2)restore();});
    };
  }
  function dialog({title, message='', confirm=t("pages.console.ui.sf526c89937"), cancel=t("pages.console.ui.s4d0b4688c7"), danger=false, content=null, highlight=null, validate=null, submit=null, back=null, backDisabled=false}) {
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
        updateHighlight=()=>{const r=highlight.getBoundingClientRect(),v=window.visualViewport,left=v?.offsetLeft||0,top=v?.offsetTop||0,w=v?.width||innerWidth,h=v?.height||innerHeight;
          const headerBottom=document.querySelector('header')?.getBoundingClientRect().bottom||0;
          const x=Math.max(left+3,Math.min(left+w-3,r.left-5)),y=Math.max(top+3,Math.min(top+h-3,Math.max(headerBottom+3,r.top-5)));
          Object.assign(spot.style,{left:x+'px',top:y+'px',width:Math.max(0,Math.min(left+w-3,r.right+5)-x)+'px',height:Math.max(0,Math.min(top+h-3,r.bottom+5)-y)+'px'});};
        updateHighlight();highlightObserver=new ResizeObserver(updateHighlight);highlightObserver.observe(highlight);window.addEventListener('resize',updateHighlight);window.addEventListener('scroll',updateHighlight,true);
      }
      let done=false,pending=false;
      const failure=node('p',undefined,'warning');failure.hidden=true;failure.setAttribute('role','alert');box.append(failure);
      const close=value=>{if(done)return;done=true;hideHelp();document.body.append(helpPopup);if(updateHighlight){highlightObserver?.disconnect();window.removeEventListener('resize',updateHighlight);window.removeEventListener('scroll',updateHighlight,true);}layer.remove();shell.inert=wasInert;activeDialog=false;if(previous?.isConnected)previous.focus?.({preventScroll:true});resolve(value);};
      no.onclick=()=>{if(!pending)close(false);};yes.onclick=async()=>{
        if(pending||validate&&validate()===false)return;
        if(!submit){close(true);return;}
        pending=true;failure.hidden=true;
        const controls=[...box.querySelectorAll('button,input,textarea,select')],disabled=controls.map(n=>n.disabled);
        controls.forEach(n=>n.disabled=true);yes.textContent=t("pages.console.ui.s9ca32f988d");
        try{await submit();close(true);}catch(error){failure.textContent=error.message||t("pages.console.ui.s28ecf45dc2");failure.hidden=false;failure.scrollIntoView({block:'nearest'});}
        finally{pending=false;controls.forEach((n,i)=>n.disabled=disabled[i]);yes.textContent=confirm;}
      };actions.append(no);
      if(back){const previousStep=node('button',back);previousStep.disabled=backDisabled;previousStep.onclick=()=>close('back');actions.classList.add('tour-actions');actions.append(previousStep);}
      actions.append(yes);box.append(actions);layer.append(box);document.body.append(layer);
      layer.addEventListener('keydown',event=>{
        if(event.key==='Escape'){event.preventDefault();if(!pending)close(false);}
        if(event.key==='Tab'){
          const focusable=[...box.querySelectorAll('button,input,textarea,select,[tabindex="0"]')].filter(n=>!n.disabled);
          if(event.shiftKey&&document.activeElement===focusable[0]){event.preventDefault();focusable.at(-1)?.focus();}
          else if(!event.shiftKey&&document.activeElement===focusable.at(-1)){event.preventDefault();focusable[0]?.focus();}
        }
      });no.focus({preventScroll:true});
    });
  }
  async function copyText(text, report) {
    // execCommand runs synchronously within the click gesture, including opaque-origin Pages frames.
    const previous=document.activeElement, input=node('textarea');input.value=text;input.setAttribute('aria-label',t("pages.console.ui.s3032d07987"));
    input.className='clipboard-buffer';document.body.append(input);input.focus({preventScroll:true});input.select();
    let copied=false;try{copied=document.execCommand('copy');}catch{}input.remove();previous?.focus?.({preventScroll:true});
    if(!copied&&navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(text);copied=true;}catch{}}
    if(copied){report(t("pages.console.ui.sda8ca6bca3"));return true;}
    const manual=node('textarea');manual.value=text;manual.readOnly=true;manual.rows=5;manual.setAttribute('aria-label',t("pages.console.ui.saad139e910"));
    await dialog({title:t("pages.console.ui.s488b648d05"),message:t("pages.console.ui.s94f70b6db6"),content:manual,confirm:t("pages.console.ui.sdd3760c80a"),cancel:t("pages.console.ui.s6c14bd7f6f")});
    return false;
  }
  function dateRangePicker({start='',end='',onChange}){
    const wrap=node('div',undefined,'date-range-control'),from=node('input'),to=node('input'),clear=node('button',t("pages.console.ui.s84fcd70d42")),error=node('small',undefined,'warning');
    const serial=++helpSerial;
    for(const [input,value,label] of [[from,start,t("pages.console.ui.s8ab977960a")],[to,end,t("pages.console.ui.s792bbe6e08")]]){
      input.type='date';input.min='1900-01-01';input.max='2199-12-31';input.value=value;
      input.id='date-range-'+serial+'-'+label;input.setAttribute('aria-label',label===t("pages.console.ui.s8ab977960a")?t("pages.console.ui.s1f60132232"):t("pages.console.ui.s51d89b73e2"));
      const field=node('label',label,'date-range-endpoint');field.htmlFor=input.id;field.append(input);wrap.append(field);
    }
    clear.type='button';error.hidden=true;error.setAttribute('role','status');wrap.append(clear,error);
    function commit(){
      const message=!from.validity.valid||!to.validity.valid?t("pages.console.ui.s281dbd5f95"):from.value&&to.value&&from.value>to.value?t("pages.console.ui.s229f1f76a2"):'';
      error.textContent=message;error.hidden=!message;if(!message)onChange({start:from.value,end:to.value});
    }
    from.onchange=to.onchange=commit;clear.onclick=()=>{from.value=to.value='';commit();};return wrap;
  }
  window.ActiveMessageUI={node,dialog,copyText,help,helpTag,helpNote,hideHelp,dateRangePicker,preserveView,sessionLabel,sessionText,sessionReferences,
    setSessionNames(names){
      sessionNames=Object.assign(Object.create(null),names&&typeof names==='object'?names:{});
      const keys=Object.keys(sessionNames).filter(sid=>typeof sessionNames[sid]==='string'&&sessionNames[sid]).sort((a,b)=>b.length-a.length);
      sessionPattern=keys.length?new RegExp('(?<![\\w:])(?:'+keys.map(sid=>sid.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')(?![\\w:])','g'):null;
    }};
})();
