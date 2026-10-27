import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledProfiles, loadPublicConfig, validatePublicConfig } from '../js/public-config.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const url='https://script.google.com/macros/s/TEST_deployment/exec';
const data=()=>({ok:true,schemaVersion:2,generationMode:'local',distributionVersion:'0.2.0',profiles:bundledProfiles()});
// Existing GAS/Sheet metadata is deliberately preserved across the local generator release.
const legacyProfiles=()=>['easy','normal','hard','expert'].map((difficulty,index)=>({difficulty,width:20+index*4,height:20+index*4,minLength:2,maxLength:30,density:1,profileVersion:'3.0.0',sizes:[20,24,28,32]}));
test('validated metadata is read anonymously and never changes canonical generator profiles',async()=>{
  let options,called;
  const result=await loadPublicConfig(url,{fetchImpl:async(u,o)=>{called=u;options=o;return new Response(JSON.stringify(data()));}});
  assert.equal(result.source,'remote');assert.equal(result.distributionVersion,'0.2.0');assert.ok(called.endsWith('?action=difficulties'));assert.equal(options.credentials,'omit');
  result.profiles[0].width=999;assert.notEqual(bundledProfiles()[0].width,999);
  result.profiles[0].sizes.push(99);assert.deepEqual(bundledProfiles()[0].sizes,[28,32,36,40]);
  assert.ok(bundledProfiles().every(p=>p.profileVersion==='4.0.0' && JSON.stringify(p.sizes)==='[28,32,36,40]'));
});
test('unknown fields, IDs, mismatched parameters, duplicates and invalid schema/version fall back',async()=>{
  const bad=[];let v=data();v.managementId='not-public';bad.push(v);v=data();v.schemaVersion=3;bad.push(v);v=data();v.profiles[0].width++;bad.push(v);v=data();v.profiles[0].profileVersion='old';bad.push(v);v=data();v.profiles[1]=v.profiles[0];bad.push(v);v=data();v.distributionVersion='<bad>';bad.push(v);v=data();v.profiles[0].seed='private';bad.push(v);
  for(const item of bad){assert.equal(validatePublicConfig(item),false);const r=await loadPublicConfig(url,{fetchImpl:async()=>new Response(JSON.stringify(item))});assert.equal(r.source,'bundled');assert.equal(r.reason,'invalid-data');assert.deepEqual(r.profiles,bundledProfiles());}
});
test('old/new schema and profile versions cannot be mixed; canonical sizes remain safe defaults',async()=>{
  const oldApi=data();oldApi.schemaVersion=1;
  for(const p of oldApi.profiles){delete p.sizes;p.profileVersion='2.0.0';}
  const newSchemaOldFields=structuredClone(oldApi);newSchemaOldFields.schemaVersion=2;
  const oldSchemaNewFields=data();oldSchemaNewFields.schemaVersion=1;
  const wrongProfileVersion=data();for(const p of wrongProfileVersion.profiles)p.profileVersion='2.0.0';
  for(const payload of [oldApi,newSchemaOldFields,oldSchemaNewFields,wrongProfileVersion]) {
    const result=await loadPublicConfig(url,{fetchImpl:async()=>new Response(JSON.stringify(payload))});
    assert.equal(result.source,'bundled');assert.equal(result.reason,'invalid-data');assert.deepEqual(result.profiles,bundledProfiles());
  }
});
test('sizes must be the full ordered numeric canonical list for every difficulty',async()=>{
  const invalid=[undefined,null,'28,32,36,40',{},[28,32,36],[28,32,36,36],[40,36,32,28],[24,28,32,36],['28',32,36,40],[20,24,28,32],[28,32,36,40,44]];
  for(const sizes of invalid){const payload=data();if(sizes===undefined)delete payload.profiles[0].sizes;else payload.profiles[0].sizes=sizes;
    const result=await loadPublicConfig(url,{fetchImpl:async()=>new Response(JSON.stringify(payload))});assert.equal(result.source,'bundled');assert.deepEqual(result.profiles,bundledProfiles());}
});
test('unconfigured/unsafe endpoint never fetches; offline and hung fetch return defaults on time',async()=>{
  const forbidden=()=>{throw new Error('must not call');};assert.equal((await loadPublicConfig(null,{fetchImpl:forbidden})).reason,'unconfigured');
  for(const unsafe of ['https://example.test/exec','http://script.google.com/macros/s/x/exec',url+'?token=private'])assert.equal((await loadPublicConfig(unsafe,{fetchImpl:forbidden})).reason,'invalid-url');
  assert.equal((await loadPublicConfig(url,{fetchImpl:async()=>{throw new Error('offline');},document:null})).source,'bundled');
  const started=Date.now();const r=await loadPublicConfig(url,{timeoutMs:30,fetchImpl:()=>new Promise(()=>{}),document:null});assert.equal(r.reason,'unavailable');assert.ok(Date.now()-started<500);
});
test('GAS JSONP fallback cleans callback and script on success and timeout',async()=>{
  const globals={},scripts=[];let callbackName;
  const doc={createElement:()=>({remove(){this.removed=true;}}),head:{appendChild(script){scripts.push(script);callbackName=new URL(script.src).searchParams.get('callback');queueMicrotask(()=>globals[callbackName](data()));}}};
  const r=await loadPublicConfig(url,{fetchImpl:async()=>{throw new Error('CORS');},document:doc,globalObject:globals});assert.equal(r.source,'remote');assert.equal(scripts[0].removed,true);assert.equal(callbackName in globals,false);
  doc.head.appendChild=script=>scripts.push(script);
  const timeout=await loadPublicConfig(url,{timeoutMs:20,fetchImpl:async()=>{throw new Error('offline');},document:doc,globalObject:globals});assert.equal(timeout.source,'bundled');assert.equal(scripts[1].removed,true);assert.equal(Object.keys(globals).length,0);
});
test('GAS reads metadata with readonly Advanced Sheets API and excludes internal columns',async()=>{
  const code=await readFile(new URL('../gas/Code.gs',import.meta.url),'utf8'),manifest=JSON.parse(await readFile(new URL('../gas/appsscript.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.oauthScopes,['https://www.googleapis.com/auth/spreadsheets.readonly']);
  assert.equal(manifest.dependencies.enabledAdvancedServices[0].serviceId,'sheets');
  const rows=[['difficulty','width','height','minLength','maxLength','density','profileVersion','sizes'],...legacyProfiles().map(p=>[p.difficulty,p.width,p.height,p.minLength,p.maxLength,p.density,p.profileVersion,p.sizes.join(','),'private-column'])];
  let requestedRange;
  const context=vm.createContext({ContentService:{MimeType:{JAVASCRIPT:'js',JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})},PropertiesService:{getScriptProperties:()=>({getProperty:key=>key==='ARROW_SPREADSHEET_ID'?'private-sheet-id':'0.2.0'})},Sheets:{Spreadsheets:{Values:{get:(_id,range,options)=>{requestedRange=range;assert.equal(options.valueRenderOption,'UNFORMATTED_VALUE');return {values:rows};}}}}});
  vm.runInContext(code,context);const result=JSON.parse(context.doGet({parameter:{action:'difficulties'}}).text);
  assert.equal(requestedRange,'DifficultyProfiles!A1:H101');assert.equal(result.schemaVersion,2);assert.deepEqual(result.profiles,legacyProfiles());assert.equal(validatePublicConfig(result),false);assert.equal(JSON.stringify(result).includes('private-'),false);
  const fallback=await loadPublicConfig(url,{fetchImpl:async()=>new Response(JSON.stringify(result))});
  assert.equal(fallback.source,'bundled');assert.equal(fallback.reason,'invalid-data');assert.deepEqual(fallback.profiles,bundledProfiles());
});
