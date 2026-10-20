import { createProfile, mergeSyncData, ownerForUid, toCloudPayload, validClear, validSetting, validSummary } from './storage.js';

export class CloudError extends Error { constructor(code,message) { super(message); this.name='CloudError'; this.code=code; } }
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code,message) => { throw new CloudError(code,message); };

/** Optional adapter. Firebase modules are bundled by Vite; no CDN is needed offline. */
export async function initializeCloud(config, { onUser = () => {}, onStatus = () => {} } = {}, injectedSdk) {
  if (!config?.apiKey || !config?.projectId || !config?.authDomain || !config?.appId) {
    return { configured:false, currentUser:()=>null, login:async()=>fail('UNCONFIGURED','Google連携の接続先が未設定です。'), logout:async()=>{}, sync:async()=>fail('UNCONFIGURED','Google連携の接続先が未設定です。'), dispose(){} };
  }
  const sdk = injectedSdk ?? Object.assign({}, ...await Promise.all([import('firebase/app'),import('firebase/auth'),import('firebase/firestore')]));
  const existing = sdk.getApps().find((a)=>a.name==='arrow-journey');
  if (existing && existing.options?.projectId !== config.projectId) fail('PROJECT_MISMATCH','Google連携の接続先が一致しません。');
  const app = existing ?? sdk.initializeApp(config,'arrow-journey');
  const auth=sdk.getAuth(app), db=sdk.getFirestore(app);
  let generation=0;
  const unsubscribe=sdk.onAuthStateChanged(auth,(user)=> { generation++; onUser(user ? { uid:user.uid, displayName:user.displayName ?? '' } : null); });
  const assertOwner=(owner,epoch) => { if (!auth.currentUser || owner !== ownerForUid(auth.currentUser.uid) || epoch !== generation) fail('ACCOUNT_CHANGED','アカウントが切り替わりました。この同期結果は適用しません。'); };
  const path=(uid,type,key) => sdk.doc(db,'users',uid,type,key);
  return {
    configured:true,
    currentUser:()=>auth.currentUser ? { uid:auth.currentUser.uid,displayName:auth.currentUser.displayName ?? '' } : null,
    login:async()=> { const provider=new sdk.GoogleAuthProvider(); provider.setCustomParameters({ prompt:'select_account' }); return sdk.signInWithPopup(auth,provider); },
    logout:async()=> { generation++; await sdk.signOut(auth); },
    async sync(owner,profile) {
      const epoch=generation;
      assertOwner(owner,epoch);
      if (profile.ownerKey !== owner) fail('OWNER','別の所有者の成績は同期できません。');
      const payload=toCloudPayload(profile), uid=auth.currentUser.uid;
      onStatus('syncing');
      try {
        // Per-record transactions make retries and response loss idempotent.
        for (const [key,summary] of Object.entries(payload.summaries)) {
          assertOwner(owner,epoch);
          await sdk.runTransaction(db,async(tx)=> {
            const ref=path(uid,'playSummaries',key), snap=await tx.get(ref);
            assertOwner(owner,epoch);
            const old=snap.exists() ? snap.data() : null;
            if (old && (!validSummary(old,key) || old.difficulty !== summary.difficulty)) fail('CLOUD_DATA','クラウド成績を確認できません。');
            const next=old ? { ...old,misses:Math.max(old.misses,summary.misses),hintsUsed:Math.max(old.hintsUsed,summary.hintsUsed) } : summary;
            if (!same(old,next)) tx.set(ref,next);
          });
        }
        for (const [key,record] of Object.entries(payload.clears)) {
          assertOwner(owner,epoch);
          await sdk.runTransaction(db,async(tx)=> {
            const ref=path(uid,'clears',key), snap=await tx.get(ref);
            assertOwner(owner,epoch);
            if (snap.exists()) { if (!validClear(snap.data(),key)) fail('CLOUD_DATA','クラウドのクリア記録を確認できません。'); }
            else tx.set(ref,record);
          });
        }
        assertOwner(owner,epoch);
        await sdk.runTransaction(db,async(tx)=> {
          const ref=path(uid,'preferences','app'),snap=await tx.get(ref);
          assertOwner(owner,epoch);
          const remote=snap.exists() ? snap.data() : {};
          if (Object.entries(remote).some(([key,v])=>!validSetting(key,v))) fail('CLOUD_DATA','クラウド設定を確認できません。');
          const empty=createProfile(owner); empty.settings=payload.settings;
          const settings=mergeSyncData(empty,{ summaries:{},clears:{},settings:remote }).settings;
          if (!same(remote,settings)) tx.set(ref,settings);
        });
        assertOwner(owner,epoch);
        const [summaries,clears,preferences] = await Promise.all([
          sdk.getDocs(sdk.collection(db,'users',uid,'playSummaries')),
          sdk.getDocs(sdk.collection(db,'users',uid,'clears')),
          sdk.getDoc(path(uid,'preferences','app'))
        ]);
        assertOwner(owner,epoch);
        const remote={ summaries:Object.fromEntries(summaries.docs.map((d)=>[d.id,d.data()])),clears:Object.fromEntries(clears.docs.map((d)=>[d.id,d.data()])),settings:preferences.exists()?preferences.data():{} };
        const next=mergeSyncData(profile,remote);
        onStatus('synced');
        // Caller commits this exact snapshot with its original revision via IDB CAS.
        return next;
      } catch(error) { if (epoch===generation) onStatus('error'); throw error; }
    },
    dispose() { generation++; unsubscribe(); }
  };
}
