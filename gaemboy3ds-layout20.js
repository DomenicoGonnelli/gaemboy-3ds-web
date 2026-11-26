/* GAEMBOY 3DS UX20 — lightweight layout editor inspired by Gaemboy's NDS
   normalized-coordinate layout. No React, core, ROM or save-state changes. */
(() => {
  'use strict';
  const root = document.getElementById('game-view');
  const source = document.getElementById('screen');
  const pause = document.getElementById('game-menu');
  const launch = document.getElementById('gb20-quick-layout');
  const controls = document.getElementById('touch-controls');
  const bridge = window.Gaemboy3DSMobileUX;
  if (!root || !source || !pause || !launch || !controls || !bridge) return;
  const KEY = 'gaemboy3ds.layout.v1.';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const spec = [
    ['upper', '.gb19-view-upper', 'Schermo superiore', 5 / 3],
    ['lower', '.gb19-view-lower', 'Schermo touch', 4 / 3],
    ['L', '.shoulders [data-button="10"]', 'L'],
    ['ZL', '.shoulders [data-button="12"]', 'ZL'],
    ['ZR', '.shoulders [data-button="13"]', 'ZR'],
    ['R', '.shoulders [data-button="11"]', 'R'],
    ['left', '[data-stick="left"]', 'Circle Pad', 1],
    ['right', '[data-stick="right"]', 'C-Stick', 1],
    ['dpad', '.button-cross.dpad', 'Croce direzionale', 1],
    ['face', '.button-cross.face-buttons', 'Pulsanti A B X Y', 1],
    ['system', '.system-buttons', 'Start / Select'],
    ['menu', '#open-menu', 'Menu']
  ];
  const refs = Object.fromEntries(spec.map(([id, selector]) => [id, root.querySelector(selector)]));
  const select = document.createElement('div');
  select.className = 'gb20-editor-overlay';
  select.hidden = true;
  select.innerHTML = `<div class="gb20-toolbar" role="toolbar" aria-label="Personalizza layout">
    <span class="gb20-caption">Sposta e ridimensiona schermi e comandi</span>
    <button type="button" data-gb20="reset">Ripristina</button>
    <button type="button" data-gb20="cancel">Annulla</button>
    <button type="button" data-gb20="save" class="gb20-save">Salva</button>
    </div><div class="gb20-frames" aria-label="Oggetti riposizionabili"></div>`;
  root.appendChild(select);
  const frames = select.querySelector('.gb20-frames');
  let editing = false, layout = null, before = null, disabledBefore = false;
  let interaction = null, activeKey = '', savedMode = '';
  const round = v => Math.round(v * 10000) / 10000;
  const container = () => root.getBoundingClientRect();
  const profile = () => {
    const m = bridge.mode() || 'desktop';
    return `${m}.${innerWidth > innerHeight ? 'landscape' : 'portrait'}`;
  };
  const storageKey = () => KEY + profile();
  function safeRead() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey()) || 'null');
      if (!parsed || parsed.version !== 1 || !parsed.rects) return null;
      const rects = {};
      for (const [id] of spec) {
        const r = parsed.rects[id];
        if (!r || ![r.x,r.y,r.w,r.h].every(v=>typeof v === 'number' && Number.isFinite(v))) return null;
        if (r.w < .02 || r.h < .02 || r.w > 1 || r.h > 1 || r.x < 0 || r.y < 0 || r.x+r.w > 1.001 || r.y+r.h > 1.001) return null;
        rects[id] = {...r};
      }
      return rects;
    } catch { return null; }
  }
  function rectFromDOM(el) {
    const c = container(), r = el?.getBoundingClientRect();
    if (!r || c.width < 1 || c.height < 1 || r.width < 1 || r.height < 1) return null;
    const x = clamp((r.left - c.left) / c.width,0,.98);
    const y = clamp((r.top - c.top) / c.height,0,.98);
    return {x:round(x),y:round(y),w:round(clamp(r.width/c.width,.02,1-x)),h:round(clamp(r.height/c.height,.02,1-y))};
  }
  function defaults() {
    const c = container(), canvas = source.getBoundingClientRect();
    const upperView = root.querySelector('.gb19-view-upper');
    const lowerView = root.querySelector('.gb19-view-lower');
    const currentlySplit = document.body.classList.contains('gb19-split-active');
    const screenDefault = (id) => {
      if (currentlySplit) return rectFromDOM(id==='upper'?upperView:lowerView);
      if (canvas.width < 1 || canvas.height < 1) return null;
      const w = canvas.width * (id==='lower'?.8:1);
      const h = canvas.height/2;
      const x = canvas.left+(id==='lower'? canvas.width*.1:0);
      const y = canvas.top+(id==='lower'?h:0);
      return {x:round(clamp((x-c.left)/c.width,0,.98)),y:round(clamp((y-c.top)/c.height,0,.98)),w:round(w/c.width),h:round(h/c.height)};
    };
    const rects = {};
    for (const [id] of spec) rects[id] = (id==='upper'||id==='lower'?screenDefault(id):rectFromDOM(refs[id]));
    for (const [id] of spec) {
      if (!rects[id]) rects[id]={x:.3,y:.3,w:.2,h:.1};
      rects[id].w = Math.min(rects[id].w,1-rects[id].x);
      rects[id].h = Math.min(rects[id].h,1-rects[id].y);
    }
    return rects;
  }
  function clearInline(el) {
    if (!el) return;
    for (const prop of ['position','left','top','right','bottom','width','height','min-width','max-width','min-height','max-height','margin','transform','aspect-ratio','z-index','grid-area','inset']) el.style.removeProperty(prop);
    el.style.removeProperty('--k');
  }
  function deactivate() {
    document.body.classList.remove('gb20-custom','gb20-edit-mode');
    for (const [id] of spec) clearInline(refs[id]);
    bridge.setForceSplit(false);
  }
  function dimension(r, el, id) {
    const c=container();
    if (!el || !r || c.width<=0 || c.height<=0) return;
    const props={position:'absolute',left:(r.x*100)+'%',top:(r.y*100)+'%',right:'auto',bottom:'auto',width:(r.w*100)+'%',height:(r.h*100)+'%',margin:'0',transform:'none', 'max-width':'none','max-height':'none','min-width':'0','min-height':'0','z-index': id==='menu'?'8':'3'};
    for (const [key,value] of Object.entries(props)) el.style.setProperty(key,value,'important');
    if (id==='face'||id==='dpad') {
      const px = Math.min(r.w*c.width,r.h*c.height)/3;
      el.style.setProperty('--k',`${px}px`,'important');
    }
    if (id==='upper'||id==='lower') el.style.setProperty('aspect-ratio','auto','important');
  }
  function apply(rects) {
    if (!rects) {deactivate();return;}
    if (!document.body.classList.contains('gb20-custom')) {
      document.body.classList.add('gb20-custom');
      bridge.setForceSplit(true);
    }
    for (const [id] of spec) dimension(rects[id],refs[id],id);
  }
  function constrain(id, r) {
    const s=spec.find(item=>item[0]===id), c=container();
    const minPx = id==='upper'||id==='lower'?90 : 26;
    const wmin = Math.min(.7,minPx/Math.max(1,c.width));
    let w=clamp(r.w,wmin,1);
    let h=r.h;
    if (s && s[3]) h=w*c.width/s[3]/Math.max(1,c.height);
    else h=clamp(h,Math.min(.25,25/Math.max(1,c.height)),1);
    if(h>1){h=1;if(s&&s[3])w=h*c.height*s[3]/c.width;}
    w=Math.min(w,1);h=Math.min(h,1);
    return {x:round(clamp(r.x,0,1-w)),y:round(clamp(r.y,0,1-h)),w:round(w),h:round(h)};
  }
  function drawFrames() {
    frames.replaceChildren();
    if (!editing || !layout) return;
    for (const [id,,name] of spec) {
      if (profile().startsWith('desktop') && !['upper','lower'].includes(id)) continue;
      const r = layout[id];
      const el = document.createElement('div');
      el.className='gb20-frame';el.dataset.gb20Id=id;
      el.tabIndex=0;el.setAttribute('role','group');el.setAttribute('aria-label',`${name}: trascina per spostare; Shift e frecce per ridimensionare`);
      el.style.left=(r.x*100)+'%';el.style.top=(r.y*100)+'%';el.style.width=(r.w*100)+'%';el.style.height=(r.h*100)+'%';
      const title=document.createElement('span');title.className='gb20-label';title.textContent=name;
      const resize=document.createElement('span');resize.className='gb20-handle';resize.dataset.gb20Resize='1';resize.setAttribute('aria-label','Ridimensiona');
      el.append(title,resize);frames.appendChild(el);
      el.addEventListener('pointerdown',startPointer);
      el.addEventListener('keydown',e=>{
        const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
        if(!delta)return;e.preventDefault();
        const v={...layout[id]};
        if(e.shiftKey){v.w+=delta[0]*.01;v.h+=delta[1]*.01;}
        else{v.x+=delta[0]*.01;v.y+=delta[1]*.01;}
        layout[id]=constrain(id,v);apply(layout);drawFrames();
        frames.querySelector(`[data-gb20-id="${id}"]`)?.focus();
      });
    }
  }
  function startPointer(e) {
    if (!editing || (e.button!==0 && e.pointerType==='mouse')) return;
    e.preventDefault();e.stopPropagation();
    const frame=e.currentTarget, id=frame.dataset.gb20Id;
    const resizing=!!e.target.closest('[data-gb20-resize]');
    interaction={id,resizing,startX:e.clientX,startY:e.clientY,old:{...layout[id]},width:container().width,height:container().height,pointer:e.pointerId};
    frame.setPointerCapture(e.pointerId);
    frame.addEventListener('pointermove',movePointer);
    frame.addEventListener('pointerup',endPointer,{once:true});
    frame.addEventListener('pointercancel',endPointer,{once:true});
  }
  function movePointer(e) {
    if(!interaction||e.pointerId!==interaction.pointer)return;
    const q=interaction, dx=(e.clientX-q.startX)/q.width,dy=(e.clientY-q.startY)/q.height;
    const v={...q.old};
    if(q.resizing) { v.w+=dx;v.h+=dy; }
    else {v.x+=dx;v.y+=dy;}
    layout[q.id]=constrain(q.id,v);
    apply(layout);
    // Keep the dragged frame alive until pointerup, avoiding lost capture.
    const frame=frames.querySelector(`[data-gb20-id="${q.id}"]`),r=layout[q.id];
    if(frame){frame.style.left=(r.x*100)+'%';frame.style.top=(r.y*100)+'%';frame.style.width=(r.w*100)+'%';frame.style.height=(r.h*100)+'%';}
  }
  function endPointer(e){
    if(!interaction||e.pointerId!==interaction.pointer)return;
    e.currentTarget.removeEventListener('pointermove',movePointer);
    interaction=null;drawFrames();
  }
  function resumeDisabled(){controls.disabled=disabledBefore;}
  function finish(){
    editing=false;select.hidden=true;interaction=null;resumeDisabled();document.body.classList.remove('gb20-edit-mode');
    window.dispatchEvent(new Event('gaemboy3ds:layout-edit-end'));
  }
  function save(){
    if(!editing)return;
    try {localStorage.setItem(storageKey(),JSON.stringify({version:1,rects:layout}));}
    catch {window.alert('Impossibile conservare il layout su questo browser.');return;}
    finish();apply(layout);
  }
  function cancel(){
    if(!editing)return;
    finish();layout=before;
    if(layout)apply(layout);else deactivate();
  }
  function reset(){
    if(!editing)return;
    deactivate();
    bridge.refresh();
    layout=defaults();
    apply(layout);document.body.classList.add('gb20-edit-mode');drawFrames();
  }
  function open(){
    if(editing || !document.body.classList.contains('playing'))return;
    const old=safeRead();
    before=old?structuredClone(old):null;
    if(old)deactivate();
    bridge.refresh();
    layout=old || defaults();
    disabledBefore=controls.disabled;
    window.dispatchEvent(new Event('gaemboy3ds:layout-edit-start'));
    pause.close();
    editing=true;select.hidden=false;document.body.classList.add('gb20-edit-mode');
    controls.disabled=true;
    apply(layout);drawFrames();
    select.querySelector('[data-gb20="save"]').focus({preventScroll:true});
  }
  launch.addEventListener('click',open);
  select.querySelector('[data-gb20="save"]').addEventListener('click',save);
  select.querySelector('[data-gb20="cancel"]').addEventListener('click',cancel);
  select.querySelector('[data-gb20="reset"]').addEventListener('click',reset);
  window.addEventListener('gaemboy3ds:layout-cancel',cancel);
  function restoreOnBoot(){
    if(editing || !document.body.classList.contains('playing'))return;
    const key=profile();
    if(key!==savedMode){savedMode=key;const stored=safeRead();if(stored){layout=stored;apply(stored);}else {layout=null;deactivate();}}
  }
  window.addEventListener('gaemboy3ds:game-booting',()=>requestAnimationFrame(restoreOnBoot));
  window.addEventListener('resize',()=>requestAnimationFrame(()=>{if(editing){drawFrames();apply(layout);}else restoreOnBoot();}),{passive:true});
  window.addEventListener('orientationchange',()=>requestAnimationFrame(()=>{if(editing)cancel();savedMode='';restoreOnBoot();}),{passive:true});
  new MutationObserver(()=>{
    if (!document.body.classList.contains('playing') && document.body.classList.contains('gb20-custom')) {
      if(editing)cancel();deactivate();savedMode='';
    }
  }).observe(document.body,{attributes:true,attributeFilter:['class']});
  requestAnimationFrame(restoreOnBoot);
  window.Gaemboy3DSLayoutEditor=Object.freeze({open,save,cancel,reset,profile,read:safeRead});
})();
