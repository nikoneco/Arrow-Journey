import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createProfile, updateSettings } from '../js/storage.js';
import { initializeCloud } from '../js/cloud.js';

test('Firestore UID boundaries, field allowlists and immutable/monotonic records', { skip: !process.env.FIRESTORE_EMULATOR_HOST && 'isolated Firestore emulator required' }, async(t)=>{
  const modulePath=process.env.ARROW_RULES_TEST_MODULE;
  const {initializeTestEnvironment,assertSucceeds,assertFails}=await import(modulePath ? pathToFileURL(modulePath).href : '@firebase/rules-unit-testing');
  const [host,port]=process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const env=await initializeTestEnvironment({projectId:'demo-arrow-journey',firestore:{host,port:Number(port),rules:await readFile(new URL('../firestore.rules',import.meta.url),'utf8')}});
  try {
    const alice=env.authenticatedContext('alice').firestore(),bob=env.authenticatedContext('bob').firestore(),anon=env.unauthenticatedContext().firestore();
    const summary={playId:'play-1',difficulty:'easy',misses:2,hintsUsed:1};
    const record={boardFingerprint:'fp-1',playId:'play-1',difficulty:'easy',misses:2,hintsUsed:1,completedAt:100};
    const ref=(db,path)=>db.doc(`users/alice/${path}`);
    await t.test('only authenticated owner may read and write',async()=>{
      await assertFails(ref(anon,'playSummaries/play-1').set(summary));
      await assertFails(ref(bob,'playSummaries/play-1').set(summary));
      await assertSucceeds(ref(alice,'playSummaries/play-1').set(summary));
      await assertSucceeds(ref(alice,'playSummaries/play-1').get());
      await assertFails(ref(bob,'playSummaries/play-1').get());
      await assertFails(ref(anon,'playSummaries/play-1').get());
      await assertFails(alice.doc('users/alice/private/board').set({cells:[]}));
    });
    await t.test('summary cannot decrease, change identity/difficulty, add board or be deleted',async()=>{
      const r=ref(alice,'playSummaries/play-1');
      await assertFails(r.update({misses:1}));await assertFails(r.update({hintsUsed:0}));
      await assertFails(r.update({difficulty:'hard'}));await assertFails(r.update({playId:'other'}));
      await assertFails(r.update({board:{cells:[]}}));await assertFails(r.update({seed:'secret'}));
      await assertFails(r.update({hintsUsed:4}));await assertFails(r.update({misses:-1}));
      await assertSucceeds(r.update({misses:3,hintsUsed:2}));await assertFails(r.delete());
    });
    await t.test('clear is create-only and rejects extra fields and mismatching key',async()=>{
      await assertFails(ref(alice,'clears/bad-fp').set(record));
      await assertFails(ref(alice,'clears/fp-1').set({...record,cells:[]}));
      await assertSucceeds(ref(alice,'clears/fp-1').set(record));
      await assertFails(ref(alice,'clears/fp-1').update({misses:0}));
      await assertFails(ref(alice,'clears/fp-1').delete());
    });
    await t.test('settings reject unknown keys, type/range and old timestamps',async()=>{
      const settings=createProfile('uid:alice').settings,r=ref(alice,'preferences/app');
      await assertFails(r.set({...settings,token:{value:'no',updatedAt:0,deviceId:'default'}}));
      await assertFails(r.set({...settings,bgmVolume:{value:5,updatedAt:0,deviceId:'default'}}));
      await assertFails(r.set({...settings,sfxEnabled:{value:'yes',updatedAt:0,deviceId:'default'}}));
      await assertSucceeds(r.set(settings));
      await assertSucceeds(r.update({bgmVolume:{value:0.7,updatedAt:100,deviceId:'device-z'}}));
      await assertFails(r.update({bgmVolume:{value:0.2,updatedAt:99,deviceId:'device-z'}}));
      await assertFails(r.update({bgmVolume:{value:0.2,updatedAt:100,deviceId:'device-a'}}));
      await assertFails(r.delete());
    });
    await t.test('legacy five-setting writes remain valid; theme cannot be erased, invalid or regressed',async()=>{
      const db=env.authenticatedContext('legacy').firestore(),r=db.doc('users/legacy/preferences/app');
      const legacy=createProfile('uid:legacy').settings;delete legacy.arrowTheme;
      await assertSucceeds(r.set(legacy));
      legacy.bgmEnabled={value:false,updatedAt:20,deviceId:'old-device'};
      await assertSucceeds(r.set(legacy));
      for(const value of ['unknown',true,'#293f37',null])await assertFails(r.update({arrowTheme:{value,updatedAt:100,deviceId:'new-device'}}));
      await assertFails(r.update({arrowTheme:{value:'forest',updatedAt:100,deviceId:'new-device',css:'red'}}));
      await assertSucceeds(r.update({arrowTheme:{value:'ocean',updatedAt:100,deviceId:'new-device'}}));
      await assertFails(r.set(legacy));
      const patch={...legacy,sfxVolume:{value:0.3,updatedAt:30,deviceId:'old-device'}};
      await assertSucceeds(r.update(patch));
      assert.equal((await r.get()).data().arrowTheme.value,'ocean');
      await assertFails(r.update({arrowTheme:{value:'forest',updatedAt:99,deviceId:'z-device'}}));
      await assertFails(r.update({arrowTheme:{value:'forest',updatedAt:100,deviceId:'a-device'}}));
      let stamp=101;for(const value of ['forest','grape','ember'])await assertSucceeds(r.update({arrowTheme:{value,updatedAt:stamp++,deviceId:'new-device'}}));
      await assertFails(r.update({arrowTheme:{value:'ocean',updatedAt:101,deviceId:'z-device'}}));
    });
    await t.test('actual modular SDK imports old cloud, adds theme and replays under these rules',async()=>{
      const appSdk=await import('firebase/app'),firestoreSdk=await import('firebase/firestore');
      const uid='sdk-legacy',owner='uid:'+uid,legacyDb=env.authenticatedContext(uid).firestore(),legacyRef=legacyDb.doc(`users/${uid}/preferences/app`);
      const oldSettings=createProfile(owner).settings;delete oldSettings.arrowTheme;
      oldSettings.bgmVolume={value:0.8,updatedAt:50,deviceId:'old-device'};
      await legacyRef.set(oldSettings);
      let firebaseApp,firestore;
      const sdk={...appSdk,...firestoreSdk,initializeApp:(...args)=>{firebaseApp=appSdk.initializeApp(...args);return firebaseApp;},getAuth:()=>({currentUser:{uid}}),onAuthStateChanged:(_,fn)=>{fn({uid});return()=>{};},getFirestore:(app)=>{firestore=firestoreSdk.getFirestore(app);firestoreSdk.connectFirestoreEmulator(firestore,host,Number(port),{mockUserToken:{sub:uid,user_id:uid}});return firestore;}};
      const cloud=await initializeCloud({apiKey:'demo-key',projectId:'demo-arrow-journey',appId:'demo-app',authDomain:'example.test'},{},sdk);
      try {
        const p=createProfile(owner);delete p.settings.arrowTheme;
        p.summaries['tx-play']={playId:'tx-play',difficulty:'easy',misses:5,hintsUsed:1};
        p.clears['tx-fp']={boardFingerprint:'tx-fp',playId:'tx-play',difficulty:'easy',misses:5,hintsUsed:1,completedAt:100};
        p.activeGame={playId:'tx-play',board:{seed:'private'},remainingIds:['a'],misses:5,hintsUsed:1,hintId:null,hintRevision:null,boardRevision:0,startedAt:100};
        const first=await cloud.sync(owner,p),second=await cloud.sync(owner,first);
        assert.deepEqual(first,second);
        assert.equal(first.settings.arrowTheme.value,'forest');assert.deepEqual(first.settings.bgmVolume,oldSettings.bgmVolume);
        const remote=(await legacyRef.get()).data();assert.equal(remote.arrowTheme.value,'forest');
        const themed=await cloud.sync(owner,updateSettings(first,{arrowTheme:'ember'},'new-device',100));
        assert.equal(themed.settings.arrowTheme.value,'ember');
        await legacyRef.update({sfxEnabled:{value:false,updatedAt:200,deviceId:'old-device'}});
        const patched=await cloud.sync(owner,themed);
        assert.equal(patched.settings.arrowTheme.value,'ember');assert.equal(patched.settings.sfxEnabled.value,false);
        const record=(await legacyDb.doc(`users/${uid}/playSummaries/tx-play`).get()).data();
        if(Object.keys(record).sort().join(',')!=='difficulty,hintsUsed,misses,playId')throw new Error('Unexpected uploaded fields');
      } finally {cloud.dispose();await firestoreSdk.terminate(firestore);await appSdk.deleteApp(firebaseApp);}
    });
  } finally { await env.cleanup(); }
});
