import test from "node:test";
import assert from "node:assert/strict";
import { initializeCloud } from "../js/cloud.js";
import { createProfile, updateSettings } from "../js/storage.js";
const config = {
  apiKey: "test",
  projectId: "demo-arrow",
  authDomain: "example.test",
  appId: "test",
};
function mockSdk() {
  const records = new Map(),
    auth = { currentUser: { uid: "alice", displayName: "A" } },
    snapshot = (path) => ({
      id: path.split("/").at(-1),
      exists: () => records.has(path),
      data: () => structuredClone(records.get(path)),
    });
  let listener = () => {};
  const sdk = {
    records,
    auth,
    readHook: null,
    getApps: () => [],
    initializeApp: () => ({}),
    getAuth: () => auth,
    getFirestore: () => ({}),
    onAuthStateChanged: (_, fn) => {
      listener = fn;
      fn(auth.currentUser);
      return () => {};
    },
    changeUser: (uid) => {
      auth.currentUser = uid ? { uid, displayName: uid } : null;
      listener(auth.currentUser);
    },
    GoogleAuthProvider: class {
      setCustomParameters() {}
    },
    signInWithPopup: async () => ({}),
    signOut: async () => sdk.changeUser(null),
    doc: (_, ...parts) => parts.join("/"),
    collection: (_, ...parts) => parts.join("/"),
    getDoc: async (path) => snapshot(path),
    getDocs: async (path) => {
      if (sdk.readHook) await sdk.readHook();
      return {
        docs: [...records.keys()]
          .filter((k) => k.startsWith(path + "/"))
          .map(snapshot),
      };
    },
    runTransaction: async (_, fn) => {
      const writes = [];
      await fn({
        get: async (path) => snapshot(path),
        set: (path, v) => writes.push([path, structuredClone(v)]),
      });
      for (const [path, v] of writes) records.set(path, v);
    },
  };
  return sdk;
}
const sample = () => {
  const p = createProfile("uid:alice");
  p.summaries["play-1"] = {
    playId: "play-1",
    difficulty: "easy",
    misses: 4,
    hintsUsed: 1,
  };
  p.clears["fp-1"] = {
    boardFingerprint: "fp-1",
    playId: "play-1",
    difficulty: "easy",
    misses: 4,
    hintsUsed: 1,
    completedAt: 100,
  };
  return p;
};
test("absent config remains usable locally and explicitly reports unconfigured cloud", async () => {
  const cloud = await initializeCloud(null);
  assert.equal(cloud.configured, false);
  assert.equal(cloud.currentUser(), null);
  await assert.rejects(cloud.login(), { code: "UNCONFIGURED" });
});
test("sync replay retains one immutable clear and monotonic summaries, never uploads puzzle", async () => {
  const sdk = mockSdk(),
    cloud = await initializeCloud(config, {}, sdk),
    p = sample();
  const first = await cloud.sync("uid:alice", p),
    second = await cloud.sync("uid:alice", first);
  assert.deepEqual(first, second);
  assert.equal(sdk.records.size, 3);
  sdk.records.get("users/alice/playSummaries/play-1").misses = 9;
  sdk.records.get("users/alice/clears/fp-1").misses = 2;
  const third = await cloud.sync("uid:alice", p);
  assert.equal(third.summaries["play-1"].misses, 9);
  assert.equal(third.clears["fp-1"].misses, 2);
  const text = JSON.stringify([...sdk.records]);
  for (const forbidden of [
    "activeGame",
    "remainingIds",
    "seed",
    "cells",
    "ownerKey",
  ])
    assert.equal(text.includes(forbidden), false);
});
test("wrong owner, guest and changed account never write to another UID", async () => {
  const sdk = mockSdk(),
    cloud = await initializeCloud(config, {}, sdk);
  await assert.rejects(cloud.sync("uid:bob", createProfile("uid:bob")), {
    code: "ACCOUNT_CHANGED",
  });
  await assert.rejects(cloud.sync("guest", createProfile("guest")), {
    code: "ACCOUNT_CHANGED",
  });
  await assert.rejects(cloud.sync("uid:alice", createProfile("uid:bob")), {
    code: "OWNER",
  });
  assert.equal(sdk.records.size, 0);
  sdk.readHook = async () => sdk.changeUser("bob");
  await assert.rejects(cloud.sync("uid:alice", sample()), {
    code: "ACCOUNT_CHANGED",
  });
  assert.equal(
    [...sdk.records.keys()].some((k) => k.includes("/bob/")),
    false,
  );
});
test("invalid remote record is surfaced, not overwritten or dropped", async () => {
  const sdk = mockSdk(),
    cloud = await initializeCloud(config, {}, sdk);
  sdk.records.set("users/alice/playSummaries/play-1", {
    playId: "play-1",
    difficulty: "easy",
    misses: 4,
    hintsUsed: 0,
    board: { cells: [] },
  });
  await assert.rejects(cloud.sync("uid:alice", sample()), {
    code: "CLOUD_DATA",
  });
  assert.ok(sdk.records.get("users/alice/playSummaries/play-1").board);
});
test("new client imports legacy five-setting cloud and adds theme without resetting existing fields", async () => {
  const sdk = mockSdk(),
    cloud = await initializeCloud(config, {}, sdk),
    legacy = createProfile("uid:alice").settings;
  delete legacy.arrowTheme;
  delete legacy.colorMode;
  delete legacy.showMistakes;
  legacy.bgmVolume = { value: 0.9, updatedAt: 500, deviceId: "old-device" };
  sdk.records.set("users/alice/preferences/app", structuredClone(legacy));
  const p = createProfile("uid:alice");
  delete p.settings.arrowTheme;
  delete p.settings.colorMode;
  delete p.settings.showMistakes;
  const merged = await cloud.sync("uid:alice", p);
  assert.deepEqual(merged.settings.arrowTheme, {
    value: "forest",
    updatedAt: 0,
    deviceId: "default",
  });
  assert.deepEqual(merged.settings.colorMode, {
    value: "light",
    updatedAt: 0,
    deviceId: "default",
  });
  assert.deepEqual(merged.settings.bgmVolume, legacy.bgmVolume);
  const stored = sdk.records.get("users/alice/preferences/app");
  const existing = structuredClone(stored);
  delete existing.arrowTheme;
  delete existing.colorMode;
  delete existing.showMistakes;
  assert.deepEqual(existing, legacy);
  const chosen = updateSettings(
    merged,
    { arrowTheme: "ember" },
    "new-device",
    100,
  );
  const synced = await cloud.sync("uid:alice", chosen);
  assert.equal(synced.settings.arrowTheme.value, "ember");
  assert.deepEqual(await cloud.sync("uid:alice", synced), synced);
});
test("cloud invalid theme is surfaced and preserved rather than silently replaced", async () => {
  const sdk = mockSdk(),
    cloud = await initializeCloud(config, {}, sdk),
    settings = createProfile("uid:alice").settings;
  settings.arrowTheme.value = "invalid-theme";
  sdk.records.set("users/alice/preferences/app", settings);
  await assert.rejects(cloud.sync("uid:alice", createProfile("uid:alice")), {
    code: "CLOUD_DATA",
  });
  assert.equal(
    sdk.records.get("users/alice/preferences/app").arrowTheme.value,
    "invalid-theme",
  );
});
test("new client imports six-setting cloud to eight without resetting selected theme or volume", async () => {
  const sdk = mockSdk(),
    cloud = await initializeCloud(config, {}, sdk);
  const legacy = updateSettings(
    createProfile("uid:alice"),
    { arrowTheme: "grape", bgmVolume: 0.8 },
    "old-device",
    500,
  ).settings;
  delete legacy.colorMode;
  delete legacy.showMistakes;
  sdk.records.set("users/alice/preferences/app", structuredClone(legacy));
  const p = createProfile("uid:alice");
  delete p.settings.colorMode;
  delete p.settings.showMistakes;
  const imported = await cloud.sync("uid:alice", p);
  assert.equal(Object.keys(imported.settings).length, 8);
  assert.equal(imported.settings.colorMode.value, "light");
  assert.deepEqual(imported.settings.arrowTheme, legacy.arrowTheme);
  assert.deepEqual(imported.settings.bgmVolume, legacy.bgmVolume);
  const synced = await cloud.sync(
    "uid:alice",
    updateSettings(imported, { colorMode: "dark" }, "new-device", 600),
  );
  assert.equal(synced.settings.colorMode.value, "dark");
  assert.deepEqual(await cloud.sync("uid:alice", synced), synced);
});
test("invalid remote color mode is preserved and reported, not defaulted", async () => {
  const sdk = mockSdk(),
    cloud = await initializeCloud(config, {}, sdk),
    settings = createProfile("uid:alice").settings;
  settings.colorMode.value = "auto";
  sdk.records.set("users/alice/preferences/app", settings);
  await assert.rejects(cloud.sync("uid:alice", createProfile("uid:alice")), {
    code: "CLOUD_DATA",
  });
  assert.equal(
    sdk.records.get("users/alice/preferences/app").colorMode.value,
    "auto",
  );
});

test("seven-setting cloud imports the hidden default and replays display changes without gameplay upload", async () => {
  const sdk = mockSdk(),
    cloud = await initializeCloud(config, {}, sdk);
  const seven = createProfile("uid:alice").settings;
  delete seven.showMistakes;
  sdk.records.set("users/alice/preferences/app", structuredClone(seven));
  const p = sample();
  delete p.settings.showMistakes;
  const imported = await cloud.sync("uid:alice", p);
  assert.equal(imported.settings.showMistakes.value, false);
  assert.equal(Object.keys(imported.settings).length, 8);
  const chosen = await cloud.sync(
    "uid:alice",
    updateSettings(imported, { showMistakes: true }, "device-a", 100),
  );
  assert.equal(chosen.settings.showMistakes.value, true);
  assert.deepEqual(await cloud.sync("uid:alice", chosen), chosen);
  const remote = sdk.records.get("users/alice/preferences/app");
  assert.equal(remote.showMistakes.value, true);
  remote.showMistakes.value = "invalid";
  await assert.rejects(cloud.sync("uid:alice", chosen), { code: "CLOUD_DATA" });
  assert.equal(remote.showMistakes.value, "invalid");
});
