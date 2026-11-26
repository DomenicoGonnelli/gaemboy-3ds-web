/* GAEMBOY 3DS: offline SHA-1 / 3DS product code; no ROM data leaves browser. */
'use strict';
const SHA = (function () {
  const h=new Uint32Array(5),w=new Uint32Array(80);
  const rol=(x,n)=>(x<<n)|(x>>>(32-n));
  function block(b,off){
    for(let i=0;i<16;i++){const j=off+i*4;w[i]=(b[j]<<24)|(b[j+1]<<16)|(b[j+2]<<8)|b[j+3];}
    for(let i=16;i<80;i++)w[i]=rol(w[i-3]^w[i-8]^w[i-14]^w[i-16],1);
    let a=h[0],bb=h[1],c=h[2],d=h[3],e=h[4];
    for(let i=0;i<80;i++){
      let f,k;
      if(i<20){f=(bb&c)|(~bb&d);k=0x5a827999;}
      else if(i<40){f=bb^c^d;k=0x6ed9eba1;}
      else if(i<60){f=(bb&c)|(bb&d)|(c&d);k=0x8f1bbcdc;}
      else {f=bb^c^d;k=0xca62c1d6;}
      const t=(rol(a,5)+f+e+k+w[i])|0;
      e=d;d=c;c=rol(bb,30);bb=a;a=t;
    }
    h[0]+=a;h[1]+=bb;h[2]+=c;h[3]+=d;h[4]+=e;
  }
  return async function sha1(blob,id){
    h.set([0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0]);
    const CHUNK=4*1024*1024,carry=new Uint8Array(64);let clen=0;
    for(let pos=0;pos<blob.size;pos+=CHUNK){
      const part=new Uint8Array(await blob.slice(pos,Math.min(blob.size,pos+CHUNK)).arrayBuffer());
      let offset=0;
      if(clen){const fill=Math.min(64-clen,part.length);carry.set(part.subarray(0,fill),clen);clen+=fill;offset+=fill;
        if(clen===64){block(carry,0);clen=0;}}
      for(;offset+64<=part.length;offset+=64)block(part,offset);
      if(offset<part.length){carry.set(part.subarray(offset),0);clen=part.length-offset;}
      if((pos/(128*1024*1024)|0)!==((pos+part.length)/(128*1024*1024)|0))self.postMessage({id,progress:Math.min(1,(pos+part.length)/blob.size)});
    }
    const tail=new Uint8Array(clen<56?64:128);tail.set(carry.subarray(0,clen));tail[clen]=0x80;
    const bits=blob.size*8;const dv=new DataView(tail.buffer);
    dv.setUint32(tail.length-8,Math.floor(bits/2**32));dv.setUint32(tail.length-4,bits>>>0);
    for(let i=0;i<tail.length;i+=64)block(tail,i);
    return Array.from(h,x=>(x>>>0).toString(16).padStart(8,'0')).join('');
  };
})();
function ascii(buf,off,len){return String.fromCharCode(...buf.subarray(off,off+len)).replace(/\0.*$/,'').trim();}
function titleId(h){
  // NCCH program ID is a little-endian uint64 at +0x118. String avoids BigInt requirements.
  return Array.from(h.subarray(0x118,0x120)).reverse().map(x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();
}
async function headerIdentity(file){
  if(file.size<0x200)return {serial:'',titleId:''};
  const header=new Uint8Array(await file.slice(0,0x200).arrayBuffer());
  const magic=ascii(header,0x100,4);
  let offset=0;
  if(magic==='NCSD'){
    const dv=new DataView(header.buffer);
    const partOffset=dv.getUint32(0x120,true);
    const partSize=dv.getUint32(0x124,true);
    offset=partOffset*0x200;
    if(!partOffset||!partSize||offset>file.size-0x200)return {serial:'',titleId:''};
  } else if(magic!=='NCCH')return {serial:'',titleId:''};
  const h=offset===0?header:new Uint8Array(await file.slice(offset,offset+0x200).arrayBuffer());
  if(ascii(h,0x100,4)!=='NCCH')return {serial:'',titleId:''};
  const serial=ascii(h,0x150,16).toUpperCase();
  return {serial:/^(CTR|KTR)-[A-Z]-[A-Z0-9]{4}$/.test(serial)?serial:'',
    titleId:titleId(h)};
}
self.onmessage=async ({data})=>{
  const {id,file,mode}=data||{};
  if(!file||typeof file.slice!=='function'){self.postMessage({id,error:'Missing local File'});return;}
  try{
    const info=await headerIdentity(file);
    if(mode==='header'){
      self.postMessage({id,...info,size:file.size});
    } else {
      const sha1=await SHA(file,id);
      self.postMessage({id,...info,sha1,size:file.size});
    }
  }catch(e){self.postMessage({id,error:String(e?.message||e)});}
};
