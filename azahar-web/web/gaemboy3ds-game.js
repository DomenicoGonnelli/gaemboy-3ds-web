/* Gaemboy 3DS UX 12: bare dual screen desktop; responsive touch controls on phone.
   The user can override inputMode for embeds and testing (auto, desktop, mobile).
   Does not change the 3DS core or the single renderer canvas. */
(() => {
  'use strict';
  const defaults = { inputMode:'auto', showDesktopControls:false, showMobileControls:true, palette:'rose' };
  const palettes = new Set(['rose','violet','midnight']);
  const mobileUA = () => /iPhone|iPod|iPad|Android|Mobile/i.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = (options) => {
    if (options.inputMode === 'mobile') return true;
    if (options.inputMode === 'desktop') return false;
    return mobileUA() || (window.matchMedia('(pointer:coarse)').matches && window.innerWidth <= 1100);
  };
  function apply() {
    const options = { ...defaults, ...(window.Gaemboy3DSGameOptions || {}) };
    const mobile = isMobile(options);
    const b = document.body;
    b.classList.remove('gb3-game-skin');
    b.classList.add('gb3-game-no-skin');
    b.classList.toggle('gb3-input-mobile',mobile);
    b.classList.toggle('gb3-input-desktop',!mobile);
    b.classList.toggle('gb3-game-controls-hidden',mobile ? options.showMobileControls === false : options.showDesktopControls !== true);
    b.dataset.gb3Palette = palettes.has(options.palette) ? options.palette : 'rose';
    const consoleEl = document.getElementById('gb3-console');
    if (consoleEl) consoleEl.setAttribute('aria-label',mobile ? 'Schermi 3DS e controlli touch' : 'Schermi 3DS');
  }
  document.addEventListener('DOMContentLoaded',apply);
  window.addEventListener('resize',apply);
  const media = window.matchMedia('(pointer:coarse)');
  if (media.addEventListener) media.addEventListener('change',apply);
  else if (media.addListener) media.addListener(apply);
  window.Gaemboy3DSGameUI = Object.freeze({ refresh:apply });
})();
