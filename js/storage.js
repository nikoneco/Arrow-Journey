// Only this app's IndexedDB is opened. A complete profile is one atomic record.
import { ARROW_THEMES, APPEARANCE_MODES } from './themes.js';

export const SCHEMA_VERSION = 1;
export const DB_NAME = 'arrow-journey-local-v1';
export const DIFFICULTIES = ['easy', 'normal', 'hard', 'expert'];
export const DEFAULT_SETTINGS = Object.freeze({ bgmEnabled: true, sfxEnabled: true, bgmVolume: 0.25, sfxVolume: 0.5, reducedMotion: false, arrowTheme: 'forest', colorMode: 'light', showMistakes: false });
const SETTING_ENUMS = { arrowTheme: new Set(ARROW_THEMES.map(theme => theme.id)), colorMode: new Set(APPEARANCE_MODES.map(mode => mode.id)) };
const OPTIONAL_SETTINGS = [...Object.keys(SETTING_ENUMS), 'showMistakes'];
const REQUIRED_LEGACY_SETTINGS = Object.keys(DEFAULT_SETTINGS).filter(key => !OPTIONAL_SETTINGS.includes(key));
const defaultSetting = key => ({ value: DEFAULT_SETTINGS[key], updatedAt: 0, deviceId: 'default' });
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const copy = (v) => structuredClone(v);
export class StorageError extends Error { constructor(code, message, raw) { super(message); this.name = 'StorageError'; this.code = code; if (raw !== undefined) this.raw = raw; } }
export class StorageConflictError extends StorageError { constructor() { super('CONFLICT','別のタブで更新されました。再読み込みしてください。'); this.name='StorageConflictError'; } }
export class CorruptDataError extends StorageError { constructor(message,raw) { super('CORRUPT',message,raw); this.name='CorruptDataError'; } }
function requireOwner(owner) { if (!(owner === 'guest' || (typeof owner === 'string' && /^uid:[A-Za-z0-9_-]{1,128}$/.test(owner)))) throw new StorageError('OWNER', '保存先の所有者が不正です。'); }
export function ownerForUid(uid) { const owner = `uid:${uid}`; requireOwner(owner); return owner; }
export function createProfile(owner) {
  requireOwner(owner);
  return { schemaVersion: SCHEMA_VERSION, ownerKey: owner, revision: 0, activeGame: null, summaries: {}, clears: {}, settings: Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, { value, updatedAt: 0, deviceId: 'default' }])) };
}
export function validSummary(v, key = v?.playId) { return exact(v, ['playId', 'difficulty', 'misses', 'hintsUsed']) && id(key) && v.playId === key && DIFFICULTIES.includes(v.difficulty) && integer(v.misses, 1_000_000_000) && integer(v.hintsUsed, 3); }
export function validClear(v, key = v?.boardFingerprint) { return exact(v, ['boardFingerprint', 'playId', 'difficulty', 'misses', 'hintsUsed', 'completedAt']) && id(key) && v.boardFingerprint === key && id(v.playId) && DIFFICULTIES.includes(v.difficulty) && integer(v.misses, 1_000_000_000) && integer(v.hintsUsed, 3) && integer(v.completedAt); }
export function validSetting(key, v) { return Object.hasOwn(DEFAULT_SETTINGS, key) && exact(v, ['value', 'updatedAt', 'deviceId']) && integer(v.updatedAt) && id(v.deviceId) && (Object.hasOwn(SETTING_ENUMS,key) ? typeof v.value === 'string' && SETTING_ENUMS[key].has(v.value) : key.endsWith('Volume') ? typeof v.value === 'number' && Number.isFinite(v.value) && v.value >= 0 && v.value <= 1 : typeof v.value === 'boolean'); }
function validGame(g, validateGame) {
  return object(g) && id(g.playId) && object(g.board) && Array.isArray(g.remainingIds) && g.remainingIds.length > 0 && g.remainingIds.every(id) && new Set(g.remainingIds).size === g.remainingIds.length && integer(g.misses, 1_000_000_000) && integer(g.hintsUsed, 3) && integer(g.boardRevision) && integer(g.startedAt) && (g.hintId === null || id(g.hintId)) && (g.hintRevision === null || integer(g.hintRevision)) && (!validateGame || validateGame(g) === true);
}
export function validateProfile(profile, owner = profile?.ownerKey, validateGame) {
  requireOwner(owner);
  if (!exact(profile, ['schemaVersion', 'ownerKey', 'revision', 'activeGame', 'summaries', 'clears', 'settings']) || profile.schemaVersion !== SCHEMA_VERSION || profile.ownerKey !== owner || !integer(profile.revision) || !object(profile.summaries) || !object(profile.clears) || !object(profile.settings) || !Object.entries(profile.summaries).every(([k,v]) => validSummary(v,k)) || !Object.entries(profile.clears).every(([k,v]) => validClear(v,k)) || !Object.entries(profile.settings).every(([k,v]) => validSetting(k,v)) || REQUIRED_LEGACY_SETTINGS.some((k) => !Object.hasOwn(profile.settings,k)) || (profile.activeGame !== null && !validGame(profile.activeGame,validateGame))) throw new CorruptDataError('保存データの形式を確認できません。元データは保持しています。', copy(profile));
  if (profile.activeGame) {
    const summary = profile.summaries[profile.activeGame.playId];
    if (!summary || summary.misses !== profile.activeGame.misses || summary.hintsUsed !== profile.activeGame.hintsUsed) throw new CorruptDataError('盤面と成績の保存内容が一致しません。', copy(profile));
  }
  // Five/six/seven-setting records remain valid. Never rewrite the raw IDB record on read.
  const missing = OPTIONAL_SETTINGS.filter(key => !Object.hasOwn(profile.settings, key));
  if (missing.length) {
    const migrated = copy(profile);
    for (const key of missing) migrated.settings[key] = defaultSetting(key);
    return migrated;
  }
  return profile;
}
export function updateSettings(profile, patch, deviceId, now = Date.now()) {
  const next = copy(validateProfile(profile));
  for (const [key, value] of Object.entries(patch)) {
    const stamp = { value, updatedAt: Math.max(now, (next.settings[key]?.updatedAt ?? 0) + 1), deviceId };
    if (!validSetting(key, stamp)) throw new StorageError('SETTINGS', '設定値が不正です。');
    next.settings[key] = stamp;
  }
  return next;
}
export function toCloudPayload(profile) {
  profile = validateProfile(profile);
  // Explicit allowlists: activeGame, board, seeds and removal history never cross here.
  return { summaries: Object.fromEntries(Object.entries(profile.summaries).map(([k,v]) => [k, { playId:v.playId,difficulty:v.difficulty,misses:v.misses,hintsUsed:v.hintsUsed }])), clears: Object.fromEntries(Object.entries(profile.clears).map(([k,v]) => [k,{ boardFingerprint:v.boardFingerprint,playId:v.playId,difficulty:v.difficulty,misses:v.misses,hintsUsed:v.hintsUsed,completedAt:v.completedAt }])), settings: copy(profile.settings) };
}
export function mergeSyncData(profile, remote) {
  profile = validateProfile(profile);
  if (!exact(remote,['summaries','clears','settings']) || !object(remote.summaries) || !object(remote.clears) || !object(remote.settings) || !Object.entries(remote.summaries).every(([k,v]) => validSummary(v,k)) || !Object.entries(remote.clears).every(([k,v]) => validClear(v,k)) || !Object.entries(remote.settings).every(([k,v]) => validSetting(k,v))) throw new StorageError('CLOUD_DATA', 'クラウド成績の形式を確認できません。');
  const next = copy(profile);
  for (const [key, incoming] of Object.entries(remote.summaries)) {
    const local = next.summaries[key];
    if (local && local.difficulty !== incoming.difficulty) throw new StorageError('CLOUD_DATA', 'プレイIDの成績が競合しています。');
    next.summaries[key] = local ? { ...local, misses: Math.max(local.misses,incoming.misses), hintsUsed: Math.max(local.hintsUsed,incoming.hintsUsed) } : copy(incoming);
  }
  // Cloud's first accepted immutable clear wins conflicts.
  for (const [key,v] of Object.entries(remote.clears)) next.clears[key] = copy(v);
  for (const [key,v] of Object.entries(remote.settings)) {
    const old = next.settings[key];
    if (!old || v.updatedAt > old.updatedAt || (v.updatedAt === old.updatedAt && v.deviceId > old.deviceId)) next.settings[key] = copy(v);
  }
  // A newer summary from another tab/device does not rewrite a local puzzle.
  if (next.activeGame) {
    const g = next.activeGame, summary = next.summaries[g.playId];
    g.misses = summary.misses; g.hintsUsed = summary.hintsUsed;
  }
  return next;
}
export function aggregateStats(profile) {
  const result = { totalClears:0, totalMisses:0, noMissClears:0, byDifficulty:Object.fromEntries(DIFFICULTIES.map((k) => [k,0])), noMissRate:null };
  for (const v of Object.values(profile.summaries)) result.totalMisses += v.misses;
  for (const v of Object.values(profile.clears)) { result.totalClears++; result.byDifficulty[v.difficulty]++; if (v.misses === 0) result.noMissClears++; }
  if (result.totalClears) result.noMissRate = result.noMissClears / result.totalClears;
  return result;
}
export async function openStore({ indexedDB = globalThis.indexedDB, name = DB_NAME, validateGame } = {}) {
  if (!indexedDB) throw new StorageError('UNAVAILABLE', 'このブラウザーでは端末保存を利用できません。');
  const db = await new Promise((resolve,reject) => { const req = indexedDB.open(name,1); req.onupgradeneeded = () => req.result.createObjectStore('profiles',{keyPath:'ownerKey'}); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new StorageError('OPEN','端末保存を開けませんでした。')); req.onblocked = () => reject(new StorageError('BLOCKED','別のタブを閉じて再読み込みしてください。')); });
  db.onversionchange = () => db.close();
  const transaction = (owner, mode, run) => new Promise((resolve,reject) => {
    requireOwner(owner); let answer, failure;
    const tx=db.transaction('profiles',mode), records=tx.objectStore('profiles'), req=records.get(owner);
    req.onsuccess=() => { try { answer=run(req.result,records); } catch(e) { failure=e; tx.abort(); } };
    tx.oncomplete=() => resolve(copy(answer));
    tx.onabort=tx.onerror=() => reject(failure ?? new StorageError('WRITE','端末保存に失敗しました。直前の状態は保持しています。'));
  });
  return {
    read(owner) { return transaction(owner,'readonly',(raw) => raw === undefined ? createProfile(owner) : validateProfile(raw,owner,validateGame)); },
    exportRaw(owner) { return transaction(owner,'readonly',(raw) => raw ?? null); },
    write(owner,profile,expectedRevision) {
      requireOwner(owner);
      const suppliedOptional = OPTIONAL_SETTINGS.filter(key => object(profile?.settings) && Object.hasOwn(profile.settings,key));
      profile = validateProfile(profile,owner,validateGame);
      if (!integer(expectedRevision) || profile.revision !== expectedRevision) throw new StorageError('REVISION','保存改訂番号が一致しません。');
      const candidate=copy(profile);
      return transaction(owner,'readwrite',(raw,records) => {
        const old=raw === undefined ? createProfile(owner) : validateProfile(raw,owner,validateGame);
        if (old.revision !== expectedRevision) throw new StorageConflictError();
        for (const key of OPTIONAL_SETTINGS) if (!suppliedOptional.includes(key)) candidate.settings[key] = copy(old.settings[key]);
        for (const [k,v] of Object.entries(old.summaries)) { const n=candidate.summaries[k]; if (!n || n.difficulty !== v.difficulty || n.misses < v.misses || n.hintsUsed < v.hintsUsed) throw new StorageError('MONOTONIC','保存済み成績を減らすことはできません。'); }
        for (const [k,v] of Object.entries(old.clears)) if (!candidate.clears[k]) throw new StorageError('MONOTONIC','クリア記録を削除することはできません。');
        candidate.revision=old.revision+1; records.put(candidate); return candidate;
      });
    },
    close() { db.close(); }
  };
}
