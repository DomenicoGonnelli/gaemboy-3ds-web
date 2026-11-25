import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { allowedCacheGb, verifyGaemboyGrant, PREMIUM_AUDIENCE, PREMIUM_ISSUER, GIB } from '../web/gaemboy3ds-entitlement.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const b64 = data => Buffer.from(data).toString('base64url');
let keys;
async function signed(claimOverrides = {}) {
  if (!keys) keys = await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256'},true,['sign','verify']);
  const now=Math.floor(Date.now()/1000);
  const payload={iss:PREMIUM_ISSUER,aud:PREMIUM_AUDIENCE,iat:now,exp:now+300,premium:true,maxGb:8,...claimOverrides};
  const input=`${b64(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${b64(JSON.stringify(payload))}`;
  const sig=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(input));
  return { token:`${input}.${b64(sig)}`,jwk:await webcrypto.subtle.exportKey('jwk',keys.publicKey),now };
}
test('Free on direct visits, regardless of cached preference',()=>{
  assert.equal(allowedCacheGb(null,8),3);
  assert.equal(allowedCacheGb({premium:true,maxGb:8,exp:10},8,11),3);
});
test('Valid Gaemboy signed 8GB grant enables selecting 5 or 8', async()=>{
  const {token,jwk,now}=await signed();
  const grant=await verifyGaemboyGrant(token,jwk,now);
  assert.equal(allowedCacheGb(grant,3,now),3);
  assert.equal(allowedCacheGb(grant,5,now),5);
  assert.equal(allowedCacheGb(grant,8,now),8);
  assert.equal(allowedCacheGb(grant,99,now),3);
  assert.equal(GIB,1024**3);
});
test('Signed grant with maximum 5GB cannot unlock 8GB',async()=>{
  const {token,jwk,now}=await signed({maxGb:5});
  const grant=await verifyGaemboyGrant(token,jwk,now);
  assert.equal(allowedCacheGb(grant,8,now),3);
  assert.equal(allowedCacheGb(grant,5,now),5);
});
test('Unsigned, tampered, wrong audience, expired and long-lived grants fail closed', async()=>{
  const {token,jwk,now}=await signed();
  await assert.rejects(()=>verifyGaemboyGrant(token,null,now),/Chiave/);
  const tampered = token.split('.');
  tampered[2] = (tampered[2][0] === 'A' ? 'B' : 'A') + tampered[2].slice(1);
  await assert.rejects(()=>verifyGaemboyGrant(tampered.join('.'),jwk,now),/Firma/);
  const malformed = token.split('.');malformed[0]=b64(JSON.stringify({alg:'none',typ:'JWT'}));
  await assert.rejects(()=>verifyGaemboyGrant(malformed.join('.'),jwk,now),/Firma JWT/);
  for (const props of [{aud:'another-app'},{iss:'https://untrusted.example'},{exp:now-1},{exp:now+90000},{premium:false},{maxGb:9}]) {
    const value=await signed(props);
    await assert.rejects(()=>verifyGaemboyGrant(value.token,value.jwk,value.now));
  }
});
