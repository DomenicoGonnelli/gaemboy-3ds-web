/* GAEMBOY 3DS UX19: presentation only. Keeps Azahar's source canvas and input IDs.
   The split views mirror 400x240 + 320x240 from the 400x480 source only on
   phone landscape / vertically segmented foldables. No extra emulator core. */
(() => {
  'use strict';
  const ROOT_CLASSES = ['gb19-phone-portrait','gb19-phone-landscape','gb19-tablet','gb19-fold','gb19-split-active'];
  const source = document.getElementById('screen');
  const stage = document.querySelector('#game-view .stage');
  const base = document.querySelector('#game-view .gb3-console-base');
  const shoulders = document.querySelector('#touch-controls .shoulders');
  const menuButton = document.getElementById('open-menu');
  if (!source || !stage || !base || !shoulders || !menuButton) return;
  const pair = document.createElement('div');
  pair.className = 'gb19-screen-pair';
  pair.setAttribute('aria-label', 'Schermi 3DS affiancati');
  const makeView = (id, label, w) => {
    const wrap = document.createElement('div');
    wrap.className = `gb19-view gb19-view-${id}`;
    wrap.dataset.gb19Screen = id;
    const c = document.createElement('canvas');
    c.width = w; c.height = 240;
    c.setAttribute('aria-label', label);
    c.setAttribute('role','img');
    wrap.appendChild(c);
    return { wrap, canvas:c, context:c.getContext('2d',{alpha:false}) };
  };
  const upper = makeView('upper','Schermo superiore 3DS',400);
  const lower = makeView('lower','Schermo touch inferiore 3DS',320);
  pair.append(upper.wrap,lower.wrap);
  stage.insertBefore(pair,source);
  let split = false, forceSplit = false, lastDraw = 0, activePointer = null, lastMode = '';
  function options() { return window.Gaemboy3DSGameOptions || {}; }
  function media(query) { try { return matchMedia(query).matches; } catch { return false; } }
  function mode() {
    const b = document.body;
    if (!b.classList.contains('gb3-input-mobile')) return 'desktop';
    const opt = options();
    if (opt.layoutMode === 'fold' || media('(vertical-viewport-segments: 2)')) return innerWidth > innerHeight ? 'tablet' : 'fold';
    if (opt.layoutMode === 'tablet' || (opt.layoutMode !== 'phone' && Math.min(innerWidth,innerHeight)>=680)) return 'tablet';
    return innerWidth > innerHeight ? 'phone-landscape' : 'phone-portrait';
  }
  function syncPhonePortrait() {
    if (lastMode !== 'phone-portrait') return;
    // The menu occupies a reserved strip directly below the bottom screen.
    // Shoulder buttons and both thumb-control rows remain BELOW that strip.
    const r = stage.getBoundingClientRect();
    const v = document.getElementById('game-view').getBoundingClientRect();
    menuButton.parentElement.style.setProperty('--gb19-menu-top', `${Math.max(0,r.bottom-v.top+1)}px`);
  }
  function resizeLayout() {
    const b=document.body; const next=mode();lastMode=next;
    ROOT_CLASSES.forEach(cls=>b.classList.remove(cls));
    menuButton.parentElement.style.removeProperty('--gb19-menu-top');
    if(next==='desktop') { split=forceSplit; if(split)b.classList.add('gb19-split-active'); pair.setAttribute('aria-hidden',split?'false':'true'); return; }
    b.classList.add(`gb19-${next}`);
    split=forceSplit||next==='phone-landscape'||next==='fold';
    if(split) b.classList.add('gb19-split-active');
    pair.setAttribute('aria-hidden',split?'false':'true');
    if(next==='phone-portrait') requestAnimationFrame(syncPhonePortrait);
    if(!split && activePointer!==null) releasePointer();
  }
  function getBridge() { return window.Gaemboy3DSTouchBridge; }
  function sendPointer(event,down) {
    const r=lower.wrap.getBoundingClientRect(); if(!r.width||!r.height) return false;
    // The real 3DS bottom screen occupies x=40..360, y=240..480 in the source.
    const x=Math.max(0,Math.min(1,(event.clientX-r.left)/r.width));
    const y=Math.max(0,Math.min(1,(event.clientY-r.top)/r.height));
    return getBridge()?.pointer(0.1+0.8*x,0.5+0.5*y,down)===true;
  }
  function releasePointer() {activePointer=null;getBridge()?.release();}
  lower.wrap.addEventListener('pointerdown',(e)=>{
    if(!split||activePointer!==null||e.button!==0&&e.pointerType==='mouse')return;
    if(sendPointer(e,true)) { e.preventDefault();activePointer=e.pointerId;lower.wrap.setPointerCapture(e.pointerId); }
  });
  lower.wrap.addEventListener('pointermove',(e)=>{if(split&&activePointer===e.pointerId){e.preventDefault();sendPointer(e);}});
  for(const ev of ['pointerup','pointercancel','lostpointercapture']) lower.wrap.addEventListener(ev,e=>{if(activePointer===e.pointerId)releasePointer();});
  function redraw(now) {
    // The GPU worker owns the source canvas. Its visible placeholder bitmap may
    // be copied with drawImage; no readPixels, no WASM rendering change.
    if(split && document.body.classList.contains('playing') && now-lastDraw>32) {
      lastDraw=now;
      try {
        const sw=source.width||400, sh=source.height||480;
        const half=sh/2;
        upper.context.drawImage(source,0,0,sw,half,0,0,400,240);
        lower.context.drawImage(source,sw*.1,half,sw*.8,half,0,0,320,240);
      } catch (err) {
        console.warn('[GAEMBOY UX19] Schermi separati non disponibili:',err);
        split=false;document.body.classList.remove('gb19-split-active');
        pair.setAttribute('aria-hidden','true');
        releasePointer();
      }
    }
    requestAnimationFrame(redraw);
  }
  const observer = typeof ResizeObserver==='function' ? new ResizeObserver(()=>{if(lastMode==='phone-portrait')syncPhonePortrait();}) : null;
  observer?.observe(source);
  addEventListener('resize',resizeLayout,{passive:true});
  addEventListener('orientationchange',resizeLayout,{passive:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)releasePointer();});
  document.addEventListener('DOMContentLoaded',resizeLayout);
  // The script is deferred; DOMContentLoaded normally follows, but support embeds.
  if(document.readyState!=='loading')resizeLayout();
  requestAnimationFrame(redraw);
  window.Gaemboy3DSMobileUX=Object.freeze({refresh:resizeLayout,mode:()=>lastMode,setForceSplit:(value)=>{forceSplit=!!value;resizeLayout();},getViews:()=>({upper:upper.wrap,lower:lower.wrap,pair})});
})();
