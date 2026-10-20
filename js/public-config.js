import { DIFFICULTIES, DIFFICULTY_PROFILE_VERSION } from './engine.js';

const keys=['difficulty','width','height','minLength','maxLength','density','profileVersion'];
const exact=(v,fields)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===fields.length && fields.every(k=>Object.hasOwn(v,k));
const version=v=>typeof v==='string' && /^[A-Za-z0-9._-]{1,40}$/.test(v);
let callbackSequence=0;
export function bundledProfiles() {
  return Object.entries(DIFFICULTIES).map(([difficulty,p])=>({difficulty,width:p.width,height:p.height,minLength:p.minLength??2,maxLength:p.maxLength??30,density:p.density,profileVersion:DIFFICULTY_PROFILE_VERSION}));
}
export function validatePublicConfig(data) {
  if(!exact(data,['ok','schemaVersion','generationMode','distributionVersion','profiles']) || data.ok!==true || data.schemaVersion!==1 || data.generationMode!=='local' || !version(data.distributionVersion) || !Array.isArray(data.profiles) || data.profiles.length!==4) return false;
  const canonical=bundledProfiles(), seen=new Set();
  for(const p of data.profiles) {
    if(!exact(p,keys) || seen.has(p.difficulty))return false;
    const bundled=canonical.find(v=>v.difficulty===p.difficulty);
    // Remote metadata is descriptive. It cannot change generation parameters.
    if(!bundled || keys.some(k=>p[k]!==bundled[k]))return false;
    seen.add(p.difficulty);
  }
  return true;
}
function bounded(task,timeoutMs,onTimeout=()=>{}) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{onTimeout();reject(new Error('timeout'));},timeoutMs);
    Promise.resolve(task).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
  });
}
function jsonp(url,timeoutMs,document,globalObject) {
  return new Promise((resolve,reject)=>{
    if(!document?.createElement || !document?.head)return reject(new Error('unavailable'));
    const callback=`arrowConfig_${Date.now().toString(36)}_${++callbackSequence}`,script=document.createElement('script');
    const cleanup=()=>{clearTimeout(timer);script.remove();delete globalObject[callback];};
    const timer=setTimeout(()=>{cleanup();reject(new Error('timeout'));},timeoutMs);
    globalObject[callback]=data=>{cleanup();resolve(data);};
    script.onerror=()=>{cleanup();reject(new Error('network'));};
    const request=new URL(url);request.searchParams.set('callback',callback);
    script.src=request.href;script.async=true;script.referrerPolicy='no-referrer';
    document.head.appendChild(script);
  });
}
/** Fetch optional public metadata; any failure preserves canonical packaged defaults. */
export async function loadPublicConfig(url,{timeoutMs=4500,fetchImpl=globalThis.fetch,document=globalThis.document,globalObject=globalThis}={}) {
  const fallback=reason=>({source:'bundled',reason,distributionVersion:null,profiles:bundledProfiles()});
  if(!url)return fallback('unconfigured');
  if(typeof url!=='string' || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url))return fallback('invalid-url');
  if(!Number.isFinite(timeoutMs)||timeoutMs<20||timeoutMs>15000)return fallback('invalid-timeout');
  const request=new URL(url);request.searchParams.set('action','difficulties');
  const started=Date.now();let data,fetchFailed=false;
  if(typeof fetchImpl==='function') {
    const controller=new AbortController();
    try {
      data=await bounded((async()=>{
        const response=await fetchImpl(request.href,{signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'follow'});
        if(!response.ok)throw new Error('network');
        if(Number(response.headers?.get('content-length'))>32768)throw new Error('oversize');
        const text=await response.text();if(text.length>32768)throw new Error('oversize');return JSON.parse(text);
      })(),Math.max(1,Math.floor(timeoutMs/2)),()=>controller.abort());
    } catch {fetchFailed=true;}
  } else fetchFailed=true;
  if(fetchFailed) {
    try {data=await jsonp(request.href,Math.max(1,timeoutMs-(Date.now()-started)),document,globalObject);} catch {return fallback('unavailable');}
  }
  if(!validatePublicConfig(data))return fallback('invalid-data');
  return {source:'remote',reason:null,distributionVersion:data.distributionVersion,profiles:structuredClone(data.profiles)};
}
