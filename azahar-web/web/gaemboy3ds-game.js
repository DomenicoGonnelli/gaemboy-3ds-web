/* Gaemboy 3DS: visual adaptation only; no emulator, ROM or save-state changes.
   Define window.Gaemboy3DSGameOptions before this script in the host page.
   gaemboy3ds:game-booting is dispatched by gaemboy3ds-page.js. */
(() => {
  'use strict';
  const getOptions = () => Object.assign({ desktopSkin: 'gaemboy', mobileSkin: false, showDesktopControls: true, palette: 'rose' }, window.Gaemboy3DSGameOptions || {});
  const validPalettes = new Set(['rose','violet','midnight']);
  const supportsSkin = () => !window.matchMedia('(max-width: 840px), (hover: none) and (pointer: coarse)').matches;
  function apply() {
    const options = getOptions();
    const onDesktop = supportsSkin();
    const skin = onDesktop && options.desktopSkin === 'gaemboy';
    document.body.classList.toggle('gb3-game-skin', skin);
    document.body.classList.toggle('gb3-game-no-skin', !skin);
    document.body.classList.toggle('gb3-game-controls-hidden', onDesktop && options.showDesktopControls === false);
    document.body.dataset.gb3Palette = validPalettes.has(options.palette) ? options.palette : 'rose';
    const consoleEl = document.getElementById('gb3-console');
    if (consoleEl) consoleEl.setAttribute('aria-label', skin ? 'Console 3DS con skin Gaemboy' : 'Schermi e comandi del 3DS');
  }
  const media = window.matchMedia('(max-width: 840px), (hover: none) and (pointer: coarse)');
  if (media.addEventListener) media.addEventListener('change', apply);
  else if (media.addListener) media.addListener(apply);
  document.addEventListener('DOMContentLoaded', apply);
  window.Gaemboy3DSGameUI = Object.freeze({ refresh: apply });
})();
