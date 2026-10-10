/* Local-only UI primitives. No native alert/confirm/prompt and no external assets. */
(() => {
  'use strict';
  const node = (tag, text, cls) => { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; };
  let activeDialog=false;
  function dialog({title, message='', confirm='确定', cancel='取消', danger=false, content=null, highlight=null}) {
    if(activeDialog)return Promise.resolve(false);
    activeDialog=true;
    return new Promise(resolve=>{
      const previous=document.activeElement, shell=document.querySelector('.shell');
      const wasInert=shell.inert; shell.inert=true;
      const layer=node('div',undefined,'modal-layer'), box=node('section',undefined,'modal');
      box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby','dialog-title');
      const heading=node('h2',title);heading.id='dialog-title';box.append(heading,node('p',message));if(content)box.append(content);
      const actions=node('div',undefined,'actions'), no=node('button',cancel), yes=node('button',confirm,danger?'danger':'primary');
      let updateHighlight=null;
      if(highlight){
        layer.classList.add('tour-layer');const spot=node('div',undefined,'tour-highlight');layer.prepend(spot);
        updateHighlight=()=>{const r=highlight.getBoundingClientRect();Object.assign(spot.style,{left:(r.left-5)+'px',top:(r.top-5)+'px',width:(r.width+10)+'px',height:(r.height+10)+'px'});};
        updateHighlight();window.addEventListener('resize',updateHighlight);window.addEventListener('scroll',updateHighlight,true);
      }
      let done=false;
      const close=value=>{if(done)return;done=true;if(updateHighlight){window.removeEventListener('resize',updateHighlight);window.removeEventListener('scroll',updateHighlight,true);}layer.remove();shell.inert=wasInert;activeDialog=false;previous?.focus?.();resolve(value);};
      no.onclick=()=>close(false);yes.onclick=()=>close(true);actions.append(no,yes);box.append(actions);layer.append(box);document.body.append(layer);
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
  window.ActiveMessageUI={node,dialog,copyText};
})();
