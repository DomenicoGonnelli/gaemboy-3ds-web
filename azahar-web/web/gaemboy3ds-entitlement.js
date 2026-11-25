// Gaemboy 3DS: fail-closed premium entitlement verifier.
// This module never checks membership through URL flags, localStorage or referrers.
export const GIB = 1024 ** 3;
export const FREE_CACHE_GB = 3;
export const CACHE_TIERS_GB = Object.freeze([3, 5, 8]);
export const PREMIUM_AUDIENCE = 'gaemboy-3ds-web';
export const PREMIUM_ISSUER = 'https://www.gaemboy.com';

function unbase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Base64url non valido');
  const pad = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(pad + '='.repeat((4 - pad.length % 4) % 4)), c => c.charCodeAt(0));
}
function jsonPart(value) { return JSON.parse(new TextDecoder().decode(unbase64url(value))); }
export function allowedCacheGb(grant, selectedGb, nowSeconds = Date.now() / 1000) {
  const authorized = grant?.premium === true && Number.isFinite(grant.exp) && grant.exp > nowSeconds &&
    (grant.maxGb === 5 || grant.maxGb === 8);
  if (!authorized) return FREE_CACHE_GB;
  const requested = Number(selectedGb);
  return CACHE_TIERS_GB.includes(requested) && requested <= grant.maxGb ? requested : FREE_CACHE_GB;
}
export async function verifyGaemboyGrant(token, publicJwk, nowSeconds = Date.now() / 1000) {
  if (!publicJwk || publicJwk.kty !== 'RSA' || !publicJwk.n || !publicJwk.e) throw new Error('Chiave Premium non configurata');
  if (typeof token !== 'string' || token.length > 4096) throw new Error('Autorizzazione non valida');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token non valido');
  const head = jsonPart(parts[0]);
  if (head?.alg !== 'RS256' || head?.typ !== 'JWT') throw new Error('Firma JWT non ammessa');
  const claims = jsonPart(parts[1]);
  if (claims?.iss !== PREMIUM_ISSUER || claims?.aud !== PREMIUM_AUDIENCE) throw new Error('Autorizzazione Gaemboy non destinata al 3DS');
  if (claims?.premium !== true || ![5, 8].includes(claims.maxGb)) throw new Error('Premium non attivo');
  if (!Number.isInteger(claims.exp) || claims.exp <= nowSeconds || claims.exp > nowSeconds + 14400) throw new Error('Autorizzazione scaduta o troppo lunga');
  if (!Number.isInteger(claims.iat) || claims.iat > nowSeconds + 30 || claims.iat > claims.exp || claims.exp - claims.iat > 14400) throw new Error('Data autorizzazione non valida');
  if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > nowSeconds + 30)) throw new Error('Autorizzazione non ancora valida');
  const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unbase64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('Firma Premium non valida');
  return { premium: true, maxGb: claims.maxGb, exp: claims.exp };
}
