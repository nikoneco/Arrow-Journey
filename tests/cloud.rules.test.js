import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createProfile } from '../js/storage.js';
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
    await t.test('actual modular SDK adapter transactions replay safely under these rules',async()=>{
      const appSdk=await import('firebase/app'),firestoreSdk=await import('firebase/firestore');
      let firebaseApp,firestore;
      const sdk={...appSdk,...firestoreSdk,initializeApp:(...args)=>{firebaseApp=appSdk.initializeApp(...args);return firebaseApp;},getAuth:()=>({currentUser:{uid:'alice'}}),onAuthStateChanged:(_,fn)=>{fn({uid:'alice'});return()=>{};},getFirestore:(app)=>{firestore=firestoreSdk.getFirestore(app);firestoreSdk.connectFirestoreEmulator(firestore,host,Number(port),{mockUserToken:{sub:'alice',user_id:'alice'}});return firestore;}};
      const cloud=await initializeCloud({apiKey:'demo-key',projectId:'demo-arrow-journey',appId:'demo-app',authDomain:'example.test'},{},sdk);
      try {
        const p=createProfile('uid:alice');
        p.summaries['tx-play']={playId:'tx-play',difficulty:'easy',misses:5,hintsUsed:1};
        p.clears['tx-fp']={boardFingerprint:'tx-fp',playId:'tx-play',difficulty:'easy',misses:5,hintsUsed:1,completedAt:100};
        p.activeGame={playId:'tx-play',board:{seed:'private'},remainingIds:['a'],misses:5,hintsUsed:1,hintId:null,hintRevision:null,boardRevision:0,startedAt:100};
        const first=await cloud.sync('uid:alice',p),second=await cloud.sync('uid:alice',first);
        if(JSON.stringify(first)!==JSON.stringify(second))throw new Error('Replay changed profile');
        const record=(await ref(alice,'playSummaries/tx-play').get()).data();
        if(Object.keys(record).sort().join(',')!=='difficulty,hintsUsed,misses,playId')throw new Error('Unexpected uploaded fields');
      } finally {cloud.dispose();await firestoreSdk.terminate(firestore);await appSdk.deleteApp(firebaseApp);}
    });
  } finally { await env.cleanup(); }
});
