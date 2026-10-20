import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledProfiles, loadPublicConfig, validatePublicConfig } from '../js/public-config.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const url='https://script.google.com/macros/s/TEST_deployment/exec';
const data=()=>({ok:true,schemaVersion:1,generationMode:'local',distributionVersion:'0.2.0',profiles:bundledProfiles()});
test('validated metadata is read anonymously and never changes canonical generator profiles',async()=>{
  let options,called;
  const result=await loadPublicConfig(url,{fetchImpl:async(u,o)=>{called=u;options=o;return new Response(JSON.stringify(data()));}});
  assert.equal(result.source,'remote');assert.equal(result.distributionVersion,'0.2.0');assert.ok(called.endsWith('?action=difficulties'));assert.equal(options.credentials,'omit');
  result.profiles[0].width=999;assert.notEqual(bundledProfiles()[0].width,999);
});
test('unknown fields, IDs, mismatched parameters, duplicates and invalid schema/version fall back',async()=>{
  const bad=[];let v=data();v.managementId='not-public';bad.push(v);v=data();v.schemaVersion=2;bad.push(v);v=data();v.profiles[0].width++;bad.push(v);v=data();v.profiles[0].profileVersion='old';bad.push(v);v=data();v.profiles[1]=v.profiles[0];bad.push(v);v=data();v.distributionVersion='<bad>';bad.push(v);v=data();v.profiles[0].seed='private';bad.push(v);
  for(const item of bad){assert.equal(validatePublicConfig(item),false);const r=await loadPublicConfig(url,{fetchImpl:async()=>new Response(JSON.stringify(item))});assert.equal(r.source,'bundled');assert.equal(r.reason,'invalid-data');assert.deepEqual(r.profiles,bundledProfiles());}
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
  const rows=[['difficulty','width','height','minLength','maxLength','density','profileVersion'],...bundledProfiles().map(p=>[p.difficulty,p.width,p.height,p.minLength,p.maxLength,p.density,p.profileVersion,'private-column'])];
  let requestedRange;
  const context=vm.createContext({ContentService:{MimeType:{JAVASCRIPT:'js',JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})},PropertiesService:{getScriptProperties:()=>({getProperty:key=>key==='ARROW_SPREADSHEET_ID'?'private-sheet-id':'0.2.0'})},Sheets:{Spreadsheets:{Values:{get:(_id,range,options)=>{requestedRange=range;assert.equal(options.valueRenderOption,'UNFORMATTED_VALUE');return {values:rows};}}}}});
  vm.runInContext(code,context);const result=JSON.parse(context.doGet({parameter:{action:'difficulties'}}).text);
  assert.equal(requestedRange,'DifficultyProfiles!A1:G101');assert.equal(validatePublicConfig(result),true);assert.equal(JSON.stringify(result).includes('private-'),false);
});
