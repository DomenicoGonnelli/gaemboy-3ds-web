// Keyboard mapping shared by gameplay and settings. Escape is reserved for the menu.
export const STORAGE_KEY = 'gaemboy3ds.keyboard.v1';
export const ACTIONS = Object.freeze([
  { id:'up', label:'D-pad su', kind:'button', value:4, code:'ArrowUp' },
  { id:'down', label:'D-pad giu', kind:'button', value:5, code:'ArrowDown' },
  { id:'left', label:'D-pad sinistra', kind:'button', value:6, code:'ArrowLeft' },
  { id:'right', label:'D-pad destra', kind:'button', value:7, code:'ArrowRight' },
  { id:'a', label:'A', kind:'button', value:8, code:'KeyX' },
  { id:'b', label:'B', kind:'button', value:0, code:'KeyZ' },
  { id:'x', label:'X', kind:'button', value:9, code:'KeyS' },
  { id:'y', label:'Y', kind:'button', value:1, code:'KeyA' },
  { id:'l', label:'L', kind:'button', value:10, code:'KeyQ' },
  { id:'r', label:'R', kind:'button', value:11, code:'KeyW' },
  { id:'zl', label:'ZL', kind:'button', value:12, code:'KeyE' },
  { id:'zr', label:'ZR', kind:'button', value:13, code:'KeyR' },
  { id:'start', label:'Start', kind:'button', value:3, code:'Enter' },
  { id:'select', label:'Select', kind:'button', value:2, code:'Backspace' },
  { id:'circle-left', label:'Circle Pad sinistra', kind:'stick', value:['analogLX',-1], code:'KeyJ' },
  { id:'circle-right', label:'Circle Pad destra', kind:'stick', value:['analogLX',1], code:'KeyL' },
  { id:'circle-up', label:'Circle Pad su', kind:'stick', value:['analogLY',-1], code:'KeyI' },
  { id:'circle-down', label:'Circle Pad giu', kind:'stick', value:['analogLY',1], code:'KeyK' },
  { id:'c-left', label:'C-Stick sinistra', kind:'stick', value:['analogRX',-1], code:'KeyF' },
  { id:'c-right', label:'C-Stick destra', kind:'stick', value:['analogRX',1], code:'KeyH' },
  { id:'c-up', label:'C-Stick su', kind:'stick', value:['analogRY',-1], code:'KeyT' },
  { id:'c-down', label:'C-Stick giu', kind:'stick', value:['analogRY',1], code:'KeyG' },
]);
export function defaults() { return Object.fromEntries(ACTIONS.map(a=>[a.id,a.code])); }
export function validCode(code) {
  return typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Numpad[0-9]|Space|Enter|Backspace|Comma|Period|Slash|Minus|Equal|Semicolon|BracketLeft|BracketRight)$/.test(code);
}
export function normalizeBindings(value) {
  const out = defaults();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const seen = new Set();
  for (const a of ACTIONS) {
    const chosen = value[a.id];
    if (validCode(chosen) && !seen.has(chosen)) { out[a.id] = chosen; seen.add(chosen); }
    else { out[a.id] = null; }
  }
  // Repair duplicates/missing keys using free defaults without losing valid assignments.
  for (const a of ACTIONS) {
    if (out[a.id] !== null) continue;
    const replacement = ACTIONS.map(x=>x.code).find(code=>!seen.has(code));
    out[a.id] = replacement || a.code;
    seen.add(out[a.id]);
  }
  return out;
}
export function remap(bindings, id, code) {
  if (!ACTIONS.some(a=>a.id===id) || !validCode(code)) return null;
  const result = normalizeBindings(bindings);
  const previous = result[id];
  const occupant = Object.keys(result).find(key=>key!==id && result[key]===code);
  if (occupant) result[occupant] = previous; // swap instead of silently disabling a control
  result[id] = code;
  return result;
}
export function toMaps(bindings) {
  const codes = normalizeBindings(bindings), buttons={}, sticks={};
  for (const a of ACTIONS) {
    if (a.kind==='button') buttons[codes[a.id]]=a.value;
    else sticks[codes[a.id]]=a.value;
  }
  return {buttons,sticks};
}
export function describeCode(code) {
  if (!code) return '-';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return ({ArrowUp:'Su',ArrowDown:'Giu',ArrowLeft:'Sinistra',ArrowRight:'Destra',Space:'Spazio',Backspace:'Backspace',Enter:'Invio'})[code] || code;
}
