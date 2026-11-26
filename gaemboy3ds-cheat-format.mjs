// GAEMBOY 3DS: Gateway-only lexical formatting and validation.
// Intentionally never discards invalid characters: the user must see why input is rejected.
export const GATEWAY_MAX_LINES = 256;
export function formatGatewayInput(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (!/^[0-9a-f\s]+$/i.test(trimmed)) return trimmed.toUpperCase();
    const digits = trimmed.replace(/\s+/g, '').toUpperCase();
    if (digits.length <= 8) return digits;
    const blocks = digits.length > 16 && digits.length % 16 === 0 && digits.length <= 4096
      ? digits.match(/.{16}/g) : [digits];
    return blocks.map(block => block.slice(0, 8) + ' ' + block.slice(8)).join('\n');
  }).join('\n');
}
export function validateGatewayInput(text) {
  const code = String(text).replace(/\r\n?/g, '\n').trim();
  if (!code) return { ok: false, code, message: 'Inserisci almeno una riga di codice Gateway.' };
  if (code.length > 65536) return { ok: false, code, message: 'Il codice supera il limite massimo di 65.536 caratteri.' };
  const lines = code.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length > GATEWAY_MAX_LINES) return { ok: false, code, message: `Massimo ${GATEWAY_MAX_LINES} istruzioni per cheat.` };
  for (let i = 0; i < lines.length; i++) {
    if (!/^[0-9A-F]{8} [0-9A-F]{8}$/.test(lines[i])) {
      return { ok: false, code, message: `Riga ${i + 1}: servono 8 cifre esadecimali, uno spazio e altre 8 cifre (XXXXXXXX XXXXXXXX).` };
    }
  }
  return { ok: true, code: lines.join('\n'), message: `${lines.length} ${lines.length === 1 ? 'istruzione valida' : 'istruzioni valide'} nel formato Gateway.` };
}
