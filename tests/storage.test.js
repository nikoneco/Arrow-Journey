import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  aggregateStats,
  CorruptDataError,
  createProfile,
  mergeSyncData,
  openStore,
  StorageConflictError,
  toCloudPayload,
  updateSettings,
  validSetting,
} from "../js/storage.js";

const summary = (playId = "play-1", misses = 0) => ({
  playId,
  difficulty: "easy",
  misses,
  hintsUsed: 0,
});
const clear = (playId = "play-1", misses = 0) => ({
  boardFingerprint: "fp-1",
  playId,
  difficulty: "easy",
  misses,
  hintsUsed: 0,
  completedAt: 100,
});
const empty = () => ({ summaries: {}, clears: {}, settings: {} });
test("owner and revision are mandatory; guest and UID profiles stay separate", async () => {
  const store = await openStore({ indexedDB: new IDBFactory() });
  await assert.rejects(store.read(""), { code: "OWNER" });
  const guest = await store.read("guest");
  assert.throws(() => store.write("uid:alice", guest, 0), { code: "CORRUPT" });
  assert.throws(() => store.write("guest", guest), { code: "REVISION" });
  guest.summaries["play-1"] = summary();
  await store.write("guest", guest, 0);
  assert.equal(
    Object.keys((await store.read("uid:alice")).summaries).length,
    0,
  );
  store.close();
});
test("old tab cannot replace a newer game or clear; all records commit atomically", async () => {
  const indexedDB = new IDBFactory(),
    a = await openStore({ indexedDB }),
    b = await openStore({ indexedDB });
  const stale = await b.read("guest"),
    next = await a.read("guest");
  next.summaries["play-1"] = summary();
  next.clears["fp-1"] = clear();
  const saved = await a.write("guest", next, 0);
  assert.equal(saved.revision, 1);
  await assert.rejects(b.write("guest", stale, 0), StorageConflictError);
  assert.deepEqual(await b.read("guest"), saved);
  a.close();
  b.close();
});
test("broken records remain raw, are surfaced and cannot be silently overwritten", async () => {
  const indexedDB = new IDBFactory(),
    store = await openStore({ indexedDB, name: "corrupt" });
  const db = await new Promise((r) => {
    const q = indexedDB.open("corrupt", 1);
    q.onsuccess = () => r(q.result);
  });
  const raw = { ownerKey: "guest", schemaVersion: 999, precious: "keep this" };
  await new Promise((r, j) => {
    const tx = db.transaction("profiles", "readwrite");
    tx.objectStore("profiles").put(raw);
    tx.oncomplete = r;
    tx.onabort = j;
  });
  await assert.rejects(store.read("guest"), CorruptDataError);
  await assert.rejects(
    store.write("guest", createProfile("guest"), 0),
    CorruptDataError,
  );
  assert.deepEqual(await store.exportRaw("guest"), raw);
  store.close();
  db.close();
});
test("game validator rejects impossible persisted board without losing old profile", async () => {
  const store = await openStore({
      indexedDB: new IDBFactory(),
      validateGame: () => false,
    }),
    profile = createProfile("guest");
  profile.summaries["play-1"] = summary();
  profile.activeGame = {
    playId: "play-1",
    board: {},
    remainingIds: ["a"],
    misses: 0,
    hintsUsed: 0,
    hintId: null,
    hintRevision: null,
    boardRevision: 0,
    startedAt: 100,
  };
  assert.throws(() => store.write("guest", profile, 0), CorruptDataError);
  assert.equal((await store.read("guest")).revision, 0);
  store.close();
});
test("summaries cannot lose discarded play misses or reduce previously saved values", async () => {
  const store = await openStore({ indexedDB: new IDBFactory() }),
    p = createProfile("guest");
  p.summaries["play-1"] = summary("play-1", 4);
  const saved = await store.write("guest", p, 0);
  saved.summaries["play-1"].misses = 2;
  await assert.rejects(store.write("guest", saved, 1), { code: "MONOTONIC" });
  assert.equal(aggregateStats(await store.read("guest")).totalMisses, 4);
  store.close();
});
test("merge is idempotent; summaries max while first cloud clear wins and counts once", () => {
  const p = createProfile("uid:alice");
  p.summaries["play-1"] = summary("play-1", 3);
  p.clears["fp-1"] = clear("play-1", 3);
  const remote = empty();
  remote.summaries["play-1"] = summary("play-1", 1);
  remote.summaries["play-2"] = summary("play-2", 2);
  remote.clears["fp-1"] = clear("play-2", 0);
  const merged = mergeSyncData(p, remote);
  assert.deepEqual(mergeSyncData(merged, remote), merged);
  assert.equal(merged.clears["fp-1"].playId, "play-2");
  assert.deepEqual(aggregateStats(merged), {
    totalClears: 1,
    totalMisses: 5,
    noMissClears: 1,
    byDifficulty: { easy: 1, normal: 0, hard: 0, expert: 0 },
    noMissRate: 1,
  });
});
test("settings merge separately by timestamp, deterministic device tie and monotonic local time", () => {
  let p = updateSettings(
    createProfile("guest"),
    { bgmVolume: 0.7 },
    "device-a",
    100,
  );
  const remote = empty();
  remote.settings = {
    sfxEnabled: { value: false, updatedAt: 101, deviceId: "device-b" },
    bgmVolume: { value: 0.2, updatedAt: 100, deviceId: "device-b" },
  };
  p = mergeSyncData(p, remote);
  assert.equal(p.settings.bgmVolume.value, 0.2);
  assert.equal(p.settings.sfxEnabled.value, false);
  p = updateSettings(p, { bgmVolume: 0.8 }, "device-a", 1);
  assert.equal(p.settings.bgmVolume.updatedAt, 101);
  assert.throws(() => updateSettings(p, { token: "secret" }, "a"), {
    code: "SETTINGS",
  });
});
test("cloud payload explicitly excludes puzzle, seed, removal history and local owner", () => {
  const p = createProfile("uid:alice");
  p.summaries["play-1"] = summary();
  p.activeGame = {
    playId: "play-1",
    board: {
      seed: "private-seed",
      cells: [[1, 1]],
      shape: "heart",
      mask: [
        [1, 1],
        [2, 1],
      ],
    },
    remainingIds: ["a"],
    misses: 0,
    hintsUsed: 0,
    hintId: null,
    hintRevision: null,
    boardRevision: 0,
    startedAt: 100,
  };
  const payload = toCloudPayload(p),
    text = JSON.stringify(payload);
  for (const forbidden of [
    "private-seed",
    "remainingIds",
    "activeGame",
    "ownerKey",
    "boardRevision",
    "cells",
    "shape",
    "mask",
    "heart",
  ])
    assert.equal(text.includes(forbidden), false);
  assert.deepEqual(Object.keys(payload), ["summaries", "clears", "settings"]);
});
test("legacy five-setting IDB read adds default theme without changing raw game, settings or revision", async () => {
  const indexedDB = new IDBFactory(),
    name = "legacy-settings",
    store = await openStore({ indexedDB, name });
  const raw = createProfile("guest");
  delete raw.settings.arrowTheme;
  delete raw.settings.colorMode;
  delete raw.settings.showMistakes;
  raw.revision = 7;
  raw.settings.bgmEnabled = {
    value: false,
    updatedAt: 50,
    deviceId: "old-device",
  };
  raw.summaries["play-1"] = summary("play-1", 2);
  raw.activeGame = {
    playId: "play-1",
    board: { seed: "local-only" },
    remainingIds: ["a"],
    misses: 2,
    hintsUsed: 0,
    hintId: null,
    hintRevision: null,
    boardRevision: 4,
    startedAt: 100,
  };
  const db = await new Promise((resolve) => {
    const req = indexedDB.open(name, 1);
    req.onsuccess = () => resolve(req.result);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction("profiles", "readwrite");
    tx.objectStore("profiles").put(raw);
    tx.oncomplete = resolve;
    tx.onabort = reject;
  });
  const read = await store.read("guest");
  assert.deepEqual(read.settings.arrowTheme, {
    value: "forest",
    updatedAt: 0,
    deviceId: "default",
  });
  assert.deepEqual(read.settings.colorMode, {
    value: "light",
    updatedAt: 0,
    deviceId: "default",
  });
  const legacyView = structuredClone(read);
  delete legacyView.settings.arrowTheme;
  delete legacyView.settings.colorMode;
  delete legacyView.settings.showMistakes;
  assert.deepEqual(legacyView, raw);
  assert.deepEqual(await store.exportRaw("guest"), raw);
  const themed = await store.write(
    "guest",
    updateSettings(read, { arrowTheme: "ocean" }, "new-device", 100),
    7,
  );
  assert.equal(themed.revision, 8);
  assert.deepEqual(themed.activeGame, raw.activeGame);
  const legacyWrite = structuredClone(themed);
  delete legacyWrite.settings.arrowTheme;
  delete legacyWrite.settings.colorMode;
  delete legacyWrite.settings.showMistakes;
  legacyWrite.settings.sfxEnabled = {
    value: false,
    updatedAt: 200,
    deviceId: "old-device",
  };
  const preserved = await store.write("guest", legacyWrite, 8);
  assert.deepEqual(preserved.settings.arrowTheme, themed.settings.arrowTheme);
  assert.deepEqual(preserved.settings.colorMode, themed.settings.colorMode);
  assert.equal(preserved.settings.sfxEnabled.value, false);
  assert.equal(preserved.revision, 9);
  store.close();
  db.close();
});
test("theme enum is strict in local updates and corrupt records are not defaulted", async () => {
  for (const value of ["forest", "ocean", "grape", "ember"])
    assert.equal(
      validSetting("arrowTheme", { value, updatedAt: 1, deviceId: "d" }),
      true,
    );
  for (const value of ["unknown", "#293f37", "", true, null, {}, ["forest"]]) {
    assert.equal(
      validSetting("arrowTheme", { value, updatedAt: 1, deviceId: "d" }),
      false,
    );
    assert.throws(
      () =>
        updateSettings(createProfile("guest"), { arrowTheme: value }, "d", 1),
      { code: "SETTINGS" },
    );
  }
  const profile = createProfile("guest");
  profile.settings.arrowTheme.value = "unknown";
  const store = await openStore({ indexedDB: new IDBFactory() });
  assert.throws(() => store.write("guest", profile, 0), CorruptDataError);
  store.close();
});
test("legacy cloud settings do not reset chosen theme and enum/timestamp conflicts remain strict", () => {
  const p = updateSettings(
    createProfile("uid:alice"),
    { arrowTheme: "grape" },
    "device-a",
    100,
  );
  const legacy = empty();
  legacy.settings = createProfile("uid:alice").settings;
  delete legacy.settings.arrowTheme;
  delete legacy.settings.colorMode;
  delete legacy.settings.showMistakes;
  legacy.settings.sfxEnabled = {
    value: false,
    updatedAt: 101,
    deviceId: "old-device",
  };
  const merged = mergeSyncData(p, legacy);
  assert.equal(merged.settings.arrowTheme.value, "grape");
  assert.equal(merged.settings.sfxEnabled.value, false);
  const older = empty();
  older.settings.arrowTheme = { value: "ocean", updatedAt: 99, deviceId: "z" };
  assert.equal(mergeSyncData(merged, older).settings.arrowTheme.value, "grape");
  older.settings.arrowTheme.updatedAt = 100;
  assert.equal(mergeSyncData(merged, older).settings.arrowTheme.value, "ocean");
  older.settings.arrowTheme.value = "unknown";
  assert.throws(() => mergeSyncData(merged, older), { code: "CLOUD_DATA" });
  const oldProfile = createProfile("uid:alice");
  delete oldProfile.settings.arrowTheme;
  delete oldProfile.settings.colorMode;
  delete oldProfile.settings.showMistakes;
  assert.equal(toCloudPayload(oldProfile).settings.arrowTheme.value, "forest");
  assert.equal(Object.hasOwn(oldProfile.settings, "arrowTheme"), false);
});
test("six-setting IDB read preserves selected theme and game while adding light without a raw write", async () => {
  const indexedDB = new IDBFactory(),
    name = "six-setting",
    store = await openStore({ indexedDB, name });
  const raw = updateSettings(
    createProfile("guest"),
    { arrowTheme: "grape" },
    "old-device",
    300,
  );
  delete raw.settings.colorMode;
  delete raw.settings.showMistakes;
  raw.revision = 11;
  raw.summaries["play-1"] = summary("play-1", 3);
  raw.activeGame = {
    playId: "play-1",
    board: { seed: "local-only" },
    remainingIds: ["a"],
    misses: 3,
    hintsUsed: 0,
    hintId: null,
    hintRevision: null,
    boardRevision: 4,
    startedAt: 100,
  };
  const db = await new Promise((resolve) => {
    const q = indexedDB.open(name, 1);
    q.onsuccess = () => resolve(q.result);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction("profiles", "readwrite");
    tx.objectStore("profiles").put(raw);
    tx.oncomplete = resolve;
    tx.onabort = reject;
  });
  const read = await store.read("guest"),
    oldShape = structuredClone(read);
  delete oldShape.settings.colorMode;
  delete oldShape.settings.showMistakes;
  assert.deepEqual(oldShape, raw);
  assert.deepEqual(await store.exportRaw("guest"), raw);
  assert.equal(read.settings.colorMode.value, "light");
  const saved = await store.write(
    "guest",
    updateSettings(read, { colorMode: "system" }, "new-device", 400),
    11,
  );
  assert.equal(saved.revision, 12);
  assert.deepEqual(saved.activeGame, raw.activeGame);
  assert.deepEqual(saved.settings.arrowTheme, raw.settings.arrowTheme);
  const oldWrite = structuredClone(saved);
  delete oldWrite.settings.colorMode;
  delete oldWrite.settings.showMistakes;
  oldWrite.settings.bgmEnabled = {
    value: false,
    updatedAt: 500,
    deviceId: "old-device",
  };
  const preserved = await store.write("guest", oldWrite, 12);
  assert.deepEqual(preserved.settings.colorMode, saved.settings.colorMode);
  assert.equal(preserved.settings.bgmEnabled.value, false);
  store.close();
  db.close();
});
test("color mode enum and merging are strict and monotonic without resetting other preferences", () => {
  for (const value of ["light", "dark", "system"])
    assert.equal(
      validSetting("colorMode", { value, updatedAt: 1, deviceId: "d" }),
      true,
    );
  for (const value of ["auto", "DARK", "", true, null, {}, ["dark"]]) {
    assert.equal(
      validSetting("colorMode", { value, updatedAt: 1, deviceId: "d" }),
      false,
    );
    assert.throws(
      () =>
        updateSettings(createProfile("guest"), { colorMode: value }, "d", 1),
      { code: "SETTINGS" },
    );
  }
  const p = updateSettings(
    createProfile("guest"),
    { colorMode: "dark", arrowTheme: "ocean" },
    "device-a",
    100,
  );
  const legacy = empty();
  legacy.settings = createProfile("guest").settings;
  delete legacy.settings.colorMode;
  delete legacy.settings.showMistakes;
  assert.equal(mergeSyncData(p, legacy).settings.colorMode.value, "dark");
  const remote = empty();
  remote.settings.colorMode = { value: "system", updatedAt: 99, deviceId: "z" };
  assert.equal(mergeSyncData(p, remote).settings.colorMode.value, "dark");
  remote.settings.colorMode.updatedAt = 100;
  const merged = mergeSyncData(p, remote);
  assert.equal(merged.settings.colorMode.value, "system");
  assert.deepEqual(merged.settings.arrowTheme, p.settings.arrowTheme);
  remote.settings.colorMode.value = "auto";
  assert.throws(() => mergeSyncData(p, remote), { code: "CLOUD_DATA" });
  p.settings.colorMode.value = "auto";
  assert.throws(() => toCloudPayload(p), CorruptDataError);
});

test("seven-setting saves default to hidden mistakes without rewriting raw data or gameplay", async () => {
  const indexedDB = new IDBFactory(),
    store = await openStore({ indexedDB, name: "seven-settings" });
  const raw = createProfile("guest");
  delete raw.settings.showMistakes;
  raw.revision = 9;
  raw.summaries["play-1"] = summary("play-1", 5);
  raw.activeGame = {
    playId: "play-1",
    board: {
      shape: "ring",
      mask: [
        [1, 1],
        [2, 1],
      ],
      seed: "local-only",
    },
    remainingIds: ["a"],
    misses: 5,
    hintsUsed: 0,
    hintId: null,
    hintRevision: null,
    boardRevision: 4,
    startedAt: 100,
  };
  const db = await new Promise((resolve) => {
    const request = indexedDB.open("seven-settings", 1);
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction("profiles", "readwrite");
    tx.objectStore("profiles").put(raw);
    tx.oncomplete = resolve;
    tx.onabort = reject;
  });
  const read = await store.read("guest"),
    withoutDisplay = structuredClone(read);
  delete withoutDisplay.settings.showMistakes;
  assert.deepEqual(withoutDisplay, raw);
  assert.deepEqual(await store.exportRaw("guest"), raw);
  assert.deepEqual(read.settings.showMistakes, {
    value: false,
    updatedAt: 0,
    deviceId: "default",
  });
  const saved = await store.write(
    "guest",
    updateSettings(read, { showMistakes: true }, "new-device", 100),
    9,
  );
  assert.deepEqual(saved.activeGame, raw.activeGame);
  assert.deepEqual(saved.summaries, raw.summaries);
  const oldWrite = structuredClone(saved);
  delete oldWrite.settings.showMistakes;
  oldWrite.settings.bgmEnabled = {
    value: false,
    updatedAt: 200,
    deviceId: "old-device",
  };
  const preserved = await store.write("guest", oldWrite, 10);
  assert.deepEqual(
    preserved.settings.showMistakes,
    saved.settings.showMistakes,
  );
  assert.equal(preserved.settings.bgmEnabled.value, false);
  store.close();
  db.close();
});

test("mistake display is a strict timestamped boolean and missing legacy cloud values preserve it", () => {
  for (const value of [true, false])
    assert.equal(
      validSetting("showMistakes", { value, updatedAt: 1, deviceId: "d" }),
      true,
    );
  for (const value of ["true", 1, null, {}, []]) {
    assert.equal(
      validSetting("showMistakes", { value, updatedAt: 1, deviceId: "d" }),
      false,
    );
    assert.throws(
      () =>
        updateSettings(createProfile("guest"), { showMistakes: value }, "d", 1),
      { code: "SETTINGS" },
    );
  }
  const selected = updateSettings(
      createProfile("guest"),
      { showMistakes: true },
      "a",
      100,
    ),
    legacy = empty();
  legacy.settings = createProfile("guest").settings;
  delete legacy.settings.showMistakes;
  assert.equal(
    mergeSyncData(selected, legacy).settings.showMistakes.value,
    true,
  );
  const remote = empty();
  remote.settings.showMistakes = { value: false, updatedAt: 99, deviceId: "z" };
  assert.equal(
    mergeSyncData(selected, remote).settings.showMistakes.value,
    true,
  );
  remote.settings.showMistakes.updatedAt = 100;
  assert.equal(
    mergeSyncData(selected, remote).settings.showMistakes.value,
    false,
  );
  remote.settings.showMistakes.value = "false";
  assert.throws(() => mergeSyncData(selected, remote), { code: "CLOUD_DATA" });
});
