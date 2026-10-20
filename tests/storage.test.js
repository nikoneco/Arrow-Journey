import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { aggregateStats, CorruptDataError, createProfile, mergeSyncData, openStore, StorageConflictError, toCloudPayload, updateSettings } from '../js/storage.js';

const summary=(playId='play-1',misses=0)=>({playId,difficulty:'easy',misses,hintsUsed:0});
const clear=(playId='play-1',misses=0)=>({boardFingerprint:'fp-1',playId,difficulty:'easy',misses,hintsUsed:0,completedAt:100});
const empty=()=>({summaries:{},clears:{},settings:{}});
test('owner and revision are mandatory; guest and UID profiles stay separate',async()=>{
  const store=await openStore({indexedDB:new IDBFactory()});
  await assert.rejects(store.read(''),{code:'OWNER'});
  const guest=await store.read('guest');
  assert.throws(()=>store.write('uid:alice',guest,0),{code:'CORRUPT'});
  assert.throws(()=>store.write('guest',guest),{code:'REVISION'});
  guest.summaries['play-1']=summary(); await store.write('guest',guest,0);
  assert.equal(Object.keys((await store.read('uid:alice')).summaries).length,0); store.close();
});
test('old tab cannot replace a newer game or clear; all records commit atomically',async()=>{
  const indexedDB=new IDBFactory(),a=await openStore({indexedDB}),b=await openStore({indexedDB});
  const stale=await b.read('guest'), next=await a.read('guest');
  next.summaries['play-1']=summary(); next.clears['fp-1']=clear();
  const saved=await a.write('guest',next,0); assert.equal(saved.revision,1);
  await assert.rejects(b.write('guest',stale,0),StorageConflictError);
  assert.deepEqual(await b.read('guest'),saved); a.close();b.close();
});
test('broken records remain raw, are surfaced and cannot be silently overwritten',async()=>{
  const indexedDB=new IDBFactory(),store=await openStore({indexedDB,name:'corrupt'});
  const db=await new Promise((r)=>{const q=indexedDB.open('corrupt',1);q.onsuccess=()=>r(q.result);});
  const raw={ownerKey:'guest',schemaVersion:999,precious:'keep this'};
  await new Promise((r,j)=>{const tx=db.transaction('profiles','readwrite');tx.objectStore('profiles').put(raw);tx.oncomplete=r;tx.onabort=j;});
  await assert.rejects(store.read('guest'),CorruptDataError);
  await assert.rejects(store.write('guest',createProfile('guest'),0),CorruptDataError);
  assert.deepEqual(await store.exportRaw('guest'),raw);store.close();db.close();
});
test('game validator rejects impossible persisted board without losing old profile',async()=>{
  const store=await openStore({indexedDB:new IDBFactory(),validateGame:()=>false}),profile=createProfile('guest');
  profile.summaries['play-1']=summary();
  profile.activeGame={playId:'play-1',board:{},remainingIds:['a'],misses:0,hintsUsed:0,hintId:null,hintRevision:null,boardRevision:0,startedAt:100};
  assert.throws(()=>store.write('guest',profile,0),CorruptDataError);
  assert.equal((await store.read('guest')).revision,0);store.close();
});
test('summaries cannot lose discarded play misses or reduce previously saved values',async()=>{
  const store=await openStore({indexedDB:new IDBFactory()}),p=createProfile('guest');p.summaries['play-1']=summary('play-1',4);
  const saved=await store.write('guest',p,0);saved.summaries['play-1'].misses=2;
  await assert.rejects(store.write('guest',saved,1),{code:'MONOTONIC'});
  assert.equal(aggregateStats(await store.read('guest')).totalMisses,4);store.close();
});
test('merge is idempotent; summaries max while first cloud clear wins and counts once',()=>{
  const p=createProfile('uid:alice');p.summaries['play-1']=summary('play-1',3);p.clears['fp-1']=clear('play-1',3);
  const remote=empty();remote.summaries['play-1']=summary('play-1',1);remote.summaries['play-2']=summary('play-2',2);remote.clears['fp-1']=clear('play-2',0);
  const merged=mergeSyncData(p,remote);assert.deepEqual(mergeSyncData(merged,remote),merged);
  assert.equal(merged.clears['fp-1'].playId,'play-2');assert.deepEqual(aggregateStats(merged),{totalClears:1,totalMisses:5,noMissClears:1,byDifficulty:{easy:1,normal:0,hard:0,expert:0},noMissRate:1});
});
test('settings merge separately by timestamp, deterministic device tie and monotonic local time',()=>{
  let p=updateSettings(createProfile('guest'),{bgmVolume:0.7},'device-a',100);
  const remote=empty();remote.settings={sfxEnabled:{value:false,updatedAt:101,deviceId:'device-b'},bgmVolume:{value:0.2,updatedAt:100,deviceId:'device-b'}};
  p=mergeSyncData(p,remote);assert.equal(p.settings.bgmVolume.value,0.2);assert.equal(p.settings.sfxEnabled.value,false);
  p=updateSettings(p,{bgmVolume:0.8},'device-a',1);assert.equal(p.settings.bgmVolume.updatedAt,101);
  assert.throws(()=>updateSettings(p,{token:'secret'},'a'),{code:'SETTINGS'});
});
test('cloud payload explicitly excludes puzzle, seed, removal history and local owner',()=>{
  const p=createProfile('uid:alice');p.summaries['play-1']=summary();
  p.activeGame={playId:'play-1',board:{seed:'private-seed',cells:[[1,1]]},remainingIds:['a'],misses:0,hintsUsed:0,hintId:null,hintRevision:null,boardRevision:0,startedAt:100};
  const payload=toCloudPayload(p),text=JSON.stringify(payload);
  for(const forbidden of ['private-seed','remainingIds','activeGame','ownerKey','boardRevision','cells'])assert.equal(text.includes(forbidden),false);
  assert.deepEqual(Object.keys(payload),['summaries','clears','settings']);
});
