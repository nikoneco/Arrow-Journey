import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createProfile, updateSettings } from "../js/storage.js";
import { initializeCloud } from "../js/cloud.js";

test(
  "Firestore UID boundaries, field allowlists and immutable/monotonic records",
  {
    skip:
      !process.env.FIRESTORE_EMULATOR_HOST &&
      "isolated Firestore emulator required",
  },
  async (t) => {
    const modulePath = process.env.ARROW_RULES_TEST_MODULE;
    const { initializeTestEnvironment, assertSucceeds, assertFails } =
      await import(
        modulePath
          ? pathToFileURL(modulePath).href
          : "@firebase/rules-unit-testing"
      );
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
    const env = await initializeTestEnvironment({
      projectId: "demo-arrow-journey",
      firestore: {
        host,
        port: Number(port),
        rules: await readFile(
          new URL("../firestore.rules", import.meta.url),
          "utf8",
        ),
      },
    });
    try {
      await env.clearFirestore();
      const alice = env.authenticatedContext("alice").firestore(),
        bob = env.authenticatedContext("bob").firestore(),
        anon = env.unauthenticatedContext().firestore();
      const summary = {
        playId: "play-1",
        difficulty: "easy",
        misses: 2,
        hintsUsed: 1,
      };
      const record = {
        boardFingerprint: "fp-1",
        playId: "play-1",
        difficulty: "easy",
        misses: 2,
        hintsUsed: 1,
        completedAt: 100,
      };
      const ref = (db, path) => db.doc(`users/alice/${path}`);
      await t.test("only authenticated owner may read and write", async () => {
        await assertFails(ref(anon, "playSummaries/play-1").set(summary));
        await assertFails(ref(bob, "playSummaries/play-1").set(summary));
        await assertSucceeds(ref(alice, "playSummaries/play-1").set(summary));
        await assertSucceeds(ref(alice, "playSummaries/play-1").get());
        await assertFails(ref(bob, "playSummaries/play-1").get());
        await assertFails(ref(anon, "playSummaries/play-1").get());
        await assertFails(
          alice.doc("users/alice/private/board").set({ cells: [] }),
        );
        for (const [path, data] of [
          ["clears/fp-1", record],
          ["preferences/app", createProfile("uid:alice").settings],
        ]) {
          await assertFails(ref(anon, path).set(data));
          await assertFails(ref(bob, path).set(data));
          await assertFails(ref(anon, path).get());
          await assertFails(ref(bob, path).get());
        }
      });
      await t.test(
        "summary cannot decrease, change identity/difficulty, add board or be deleted",
        async () => {
          const r = ref(alice, "playSummaries/play-1");
          await assertFails(r.update({ misses: 1 }));
          await assertFails(r.update({ hintsUsed: 0 }));
          await assertFails(r.update({ difficulty: "hard" }));
          await assertFails(r.update({ playId: "other" }));
          await assertFails(r.update({ board: { cells: [] } }));
          await assertFails(r.update({ seed: "secret" }));
          await assertFails(r.update({ hintsUsed: 4 }));
          await assertFails(r.update({ misses: -1 }));
          await assertSucceeds(r.update({ misses: 3, hintsUsed: 2 }));
          await assertFails(r.delete());
        },
      );
      await t.test(
        "clear is create-only and rejects extra fields and mismatching key",
        async () => {
          await assertFails(ref(alice, "clears/bad-fp").set(record));
          await assertFails(
            ref(alice, "clears/fp-1").set({ ...record, cells: [] }),
          );
          await assertSucceeds(ref(alice, "clears/fp-1").set(record));
          await assertFails(ref(alice, "clears/fp-1").update({ misses: 0 }));
          await assertFails(ref(alice, "clears/fp-1").delete());
        },
      );
      await t.test(
        "settings reject unknown keys, type/range and old timestamps",
        async () => {
          const settings = createProfile("uid:alice").settings,
            r = ref(alice, "preferences/app");
          await assertFails(
            r.set({
              ...settings,
              token: { value: "no", updatedAt: 0, deviceId: "default" },
            }),
          );
          await assertFails(
            r.set({
              ...settings,
              bgmVolume: { value: 5, updatedAt: 0, deviceId: "default" },
            }),
          );
          await assertFails(
            r.set({
              ...settings,
              sfxEnabled: { value: "yes", updatedAt: 0, deviceId: "default" },
            }),
          );
          await assertSucceeds(r.set(settings));
          await assertSucceeds(
            r.update({
              bgmVolume: { value: 0.7, updatedAt: 100, deviceId: "device-z" },
            }),
          );
          await assertFails(
            r.update({
              bgmVolume: { value: 0.2, updatedAt: 99, deviceId: "device-z" },
            }),
          );
          await assertFails(
            r.update({
              bgmVolume: { value: 0.2, updatedAt: 100, deviceId: "device-a" },
            }),
          );
          await assertFails(r.delete());
        },
      );
      await t.test(
        "all eight settings support timestamp ties and replay while each field stays monotonic",
        async () => {
          const db = env.authenticatedContext("all-settings").firestore(),
            r = db.doc("users/all-settings/preferences/app"),
            defaults = createProfile("uid:all-settings").settings;
          const withMetadata = (settings, updatedAt, deviceId) =>
            Object.fromEntries(
              Object.entries(settings).map(([key, value]) => [
                key,
                { ...value, updatedAt, deviceId },
              ]),
            );
          const allNewer = withMetadata(defaults, 300, "all-fields");
          await assertSucceeds(r.set(defaults));
          await assertSucceeds(r.set(allNewer));
          const changedValues = {
            bgmEnabled: false,
            sfxEnabled: false,
            bgmVolume: 0,
            sfxVolume: 1,
            reducedMotion: true,
            arrowTheme: "ember",
            colorMode: "system",
            showMistakes: true,
          };
          const allTied = Object.fromEntries(
            Object.entries(allNewer).map(([key, value]) => [
              key,
              { ...value, value: changedValues[key], deviceId: "z-fields" },
            ]),
          );
          // This takes every same-timestamp/deviceId comparison branch.
          await assertSucceeds(r.set(allTied));
          await assertSucceeds(r.set(allTied));
          for (const key of Object.keys(allTied)) {
            await assertFails(r.update({ [key]: allNewer[key] }));
            await assertFails(
              r.update({
                [key]: { ...allTied[key], value: defaults[key].value },
              }),
            );
            const removed = { ...allTied };
            delete removed[key];
            await assertFails(r.set(removed));
          }
          // A later timestamp wins even when its deviceId sorts before the old one.
          const later = withMetadata(
            allTied,
            Number.MAX_SAFE_INTEGER,
            "a-fields",
          );
          await assertSucceeds(r.set(later));
          await assertSucceeds(r.set(later));
          assert.deepEqual((await r.get()).data(), later);
        },
      );
      await t.test(
        "every setting requires complete bounded metadata and the full resulting schema stays valid",
        async () => {
          const db = env.authenticatedContext("metadata").firestore(),
            r = db.doc("users/metadata/preferences/app"),
            settings = createProfile("uid:metadata").settings;
          await assertSucceeds(r.set(settings));
          for (const key of Object.keys(settings)) {
            for (const missing of ["value", "updatedAt", "deviceId"]) {
              const incomplete = { ...settings[key] };
              delete incomplete[missing];
              await assertFails(r.update({ [key]: incomplete }));
            }
            for (const invalid of [null, false, [], "setting"]) {
              await assertFails(r.update({ [key]: invalid }));
            }
            await assertFails(
              r.update({ [key]: { ...settings[key], extra: true } }),
            );
          }
          for (const key of [
            "bgmEnabled",
            "bgmVolume",
            "arrowTheme",
            "colorMode",
          ]) {
            for (const updatedAt of [
              -1,
              0.5,
              Number.MAX_SAFE_INTEGER + 1,
              "100",
              null,
            ]) {
              await assertFails(
                r.update({ [key]: { ...settings[key], updatedAt } }),
              );
            }
            for (const deviceId of [
              "",
              "x".repeat(129),
              "__proto__",
              "constructor",
              "prototype",
              "bad/id",
              1,
              null,
            ]) {
              await assertFails(
                r.update({
                  [key]: { ...settings[key], deviceId, updatedAt: 100 },
                }),
              );
            }
          }
          for (const value of [-0.1, 1.1, "0.5", null, true]) {
            await assertFails(
              r.update({
                bgmVolume: { value, updatedAt: 100, deviceId: "device" },
              }),
            );
          }
          await assertFails(
            r.update({
              token: { value: false, updatedAt: 100, deviceId: "device" },
            }),
          );
          // A patch cannot leave an invalid, unchanged sibling in the document.
          await env.withSecurityRulesDisabled(async (context) => {
            await context
              .firestore()
              .doc("users/metadata/preferences/app")
              .set({
                ...settings,
                showMistakes: {
                  value: "false",
                  updatedAt: 0,
                  deviceId: "default",
                },
              });
          });
          await assertFails(
            r.update({
              bgmVolume: { value: 0.5, updatedAt: 100, deviceId: "device" },
            }),
          );
        },
      );
      await t.test(
        "legacy five-setting writes remain valid; theme cannot be erased, invalid or regressed",
        async () => {
          const db = env.authenticatedContext("legacy").firestore(),
            r = db.doc("users/legacy/preferences/app");
          const legacy = createProfile("uid:legacy").settings;
          delete legacy.arrowTheme;
          delete legacy.colorMode;
          delete legacy.showMistakes;
          await assertSucceeds(r.set(legacy));
          legacy.bgmEnabled = {
            value: false,
            updatedAt: 20,
            deviceId: "old-device",
          };
          await assertSucceeds(r.set(legacy));
          for (const value of ["unknown", true, "#293f37", null])
            await assertFails(
              r.update({
                arrowTheme: { value, updatedAt: 100, deviceId: "new-device" },
              }),
            );
          await assertFails(
            r.update({
              arrowTheme: {
                value: "forest",
                updatedAt: 100,
                deviceId: "new-device",
                css: "red",
              },
            }),
          );
          await assertSucceeds(
            r.update({
              arrowTheme: {
                value: "ocean",
                updatedAt: 100,
                deviceId: "new-device",
              },
            }),
          );
          await assertFails(r.set(legacy));
          const patch = {
            ...legacy,
            sfxVolume: { value: 0.3, updatedAt: 30, deviceId: "old-device" },
          };
          await assertSucceeds(r.update(patch));
          assert.equal((await r.get()).data().arrowTheme.value, "ocean");
          await assertFails(
            r.update({
              arrowTheme: {
                value: "forest",
                updatedAt: 99,
                deviceId: "z-device",
              },
            }),
          );
          await assertFails(
            r.update({
              arrowTheme: {
                value: "forest",
                updatedAt: 100,
                deviceId: "a-device",
              },
            }),
          );
          let stamp = 101;
          for (const value of ["forest", "grape", "ember"])
            await assertSucceeds(
              r.update({
                arrowTheme: {
                  value,
                  updatedAt: stamp++,
                  deviceId: "new-device",
                },
              }),
            );
          await assertFails(
            r.update({
              arrowTheme: {
                value: "ocean",
                updatedAt: 101,
                deviceId: "z-device",
              },
            }),
          );
        },
      );
      await t.test(
        "six-setting legacy updates preserve color mode once added and reject invalid or old values",
        async () => {
          const db = env.authenticatedContext("legacy-mode").firestore(),
            r = db.doc("users/legacy-mode/preferences/app");
          const six = updateSettings(
            createProfile("uid:legacy-mode"),
            { arrowTheme: "grape" },
            "old-device",
            100,
          ).settings;
          delete six.colorMode;
          delete six.showMistakes;
          await assertSucceeds(r.set(six));
          for (const value of ["auto", "DARK", true, null])
            await assertFails(
              r.update({
                colorMode: { value, updatedAt: 100, deviceId: "new-device" },
              }),
            );
          await assertFails(
            r.update({
              colorMode: {
                value: "dark",
                updatedAt: 100,
                deviceId: "new-device",
                css: "black",
              },
            }),
          );
          await assertSucceeds(
            r.update({
              colorMode: {
                value: "dark",
                updatedAt: 100,
                deviceId: "new-device",
              },
            }),
          );
          await assertFails(r.set(six));
          const five = { ...six };
          delete five.arrowTheme;
          await assertFails(r.set(five));
          await assertSucceeds(
            r.update({
              ...six,
              bgmVolume: { value: 0.6, updatedAt: 200, deviceId: "old-device" },
            }),
          );
          let stored = (await r.get()).data();
          assert.equal(stored.colorMode.value, "dark");
          assert.deepEqual(stored.arrowTheme, six.arrowTheme);
          await assertFails(
            r.update({
              colorMode: {
                value: "light",
                updatedAt: 99,
                deviceId: "z-device",
              },
            }),
          );
          await assertFails(
            r.update({
              colorMode: {
                value: "light",
                updatedAt: 100,
                deviceId: "a-device",
              },
            }),
          );
          await assertSucceeds(
            r.update({
              colorMode: {
                value: "light",
                updatedAt: 101,
                deviceId: "new-device",
              },
            }),
          );
          await assertSucceeds(
            r.update({
              colorMode: {
                value: "system",
                updatedAt: 102,
                deviceId: "new-device",
              },
            }),
          );
          stored = (await r.get()).data();
          assert.equal(stored.colorMode.value, "system");
        },
      );
      await t.test(
        "seven-setting legacy writes preserve optional mistake display and reject invalid values",
        async () => {
          const db = env.authenticatedContext("legacy-display").firestore(),
            r = db.doc("users/legacy-display/preferences/app");
          const seven = createProfile("uid:legacy-display").settings;
          delete seven.showMistakes;
          await assertSucceeds(r.set(seven));
          for (const value of ["false", 1, null, {}, []])
            await assertFails(
              r.update({
                showMistakes: { value, updatedAt: 100, deviceId: "new-device" },
              }),
            );
          await assertFails(
            r.update({
              showMistakes: {
                value: false,
                updatedAt: 100,
                deviceId: "new-device",
                extra: true,
              },
            }),
          );
          await assertSucceeds(
            r.update({
              showMistakes: {
                value: false,
                updatedAt: 100,
                deviceId: "new-device",
              },
            }),
          );
          await assertFails(r.set(seven));
          await assertSucceeds(
            r.update({
              ...seven,
              bgmVolume: { value: 0.6, updatedAt: 200, deviceId: "old-device" },
            }),
          );
          assert.equal((await r.get()).data().showMistakes.value, false);
          await assertFails(
            r.update({
              showMistakes: {
                value: true,
                updatedAt: 99,
                deviceId: "z-device",
              },
            }),
          );
          await assertFails(
            r.update({
              showMistakes: {
                value: true,
                updatedAt: 100,
                deviceId: "a-device",
              },
            }),
          );
          await assertSucceeds(
            r.update({
              showMistakes: {
                value: true,
                updatedAt: 101,
                deviceId: "new-device",
              },
            }),
          );
          assert.equal((await r.get()).data().showMistakes.value, true);
        },
      );
      await t.test(
        "actual modular SDK imports five/six/seven-setting cloud, adds display settings and replays",
        async () => {
          const appSdk = await import("firebase/app"),
            firestoreSdk = await import("firebase/firestore");
          for (const settingCount of [5, 6, 7]) {
            const uid = "sdk-legacy" + settingCount,
              owner = "uid:" + uid,
              legacyDb = env.authenticatedContext(uid).firestore(),
              legacyRef = legacyDb.doc(`users/${uid}/preferences/app`);
            const oldSettings = createProfile(owner).settings;
            delete oldSettings.showMistakes;
            if (settingCount < 7) delete oldSettings.colorMode;
            if (settingCount === 5) delete oldSettings.arrowTheme;
            else
              oldSettings.arrowTheme = {
                value: "grape",
                updatedAt: 70,
                deviceId: "old-device",
              };
            oldSettings.bgmVolume = {
              value: 0.8,
              updatedAt: 50,
              deviceId: "old-device",
            };
            await legacyRef.set(oldSettings);
            let firebaseApp, firestore;
            const sdk = {
              ...appSdk,
              ...firestoreSdk,
              initializeApp: (...args) => {
                firebaseApp = appSdk.initializeApp(...args);
                return firebaseApp;
              },
              getAuth: () => ({ currentUser: { uid } }),
              onAuthStateChanged: (_, fn) => {
                fn({ uid });
                return () => {};
              },
              getFirestore: (app) => {
                firestore = firestoreSdk.getFirestore(app);
                firestoreSdk.connectFirestoreEmulator(
                  firestore,
                  host,
                  Number(port),
                  { mockUserToken: { sub: uid, user_id: uid } },
                );
                return firestore;
              },
            };
            const cloud = await initializeCloud(
              {
                apiKey: "demo-key",
                projectId: "demo-arrow-journey",
                appId: "demo-app",
                authDomain: "example.test",
              },
              {},
              sdk,
            );
            try {
              const p = createProfile(owner);
              delete p.settings.showMistakes;
              if (settingCount < 7) delete p.settings.colorMode;
              if (settingCount === 5) delete p.settings.arrowTheme;
              p.summaries["tx-play"] = {
                playId: "tx-play",
                difficulty: "easy",
                misses: 5,
                hintsUsed: 1,
              };
              p.clears["tx-fp"] = {
                boardFingerprint: "tx-fp",
                playId: "tx-play",
                difficulty: "easy",
                misses: 5,
                hintsUsed: 1,
                completedAt: 100,
              };
              p.activeGame = {
                playId: "tx-play",
                board: { seed: "private" },
                remainingIds: ["a"],
                misses: 5,
                hintsUsed: 1,
                hintId: null,
                hintRevision: null,
                boardRevision: 0,
                startedAt: 100,
              };
              const first = await cloud.sync(owner, p),
                second = await cloud.sync(owner, first);
              assert.deepEqual(first, second);
              assert.equal(
                first.settings.arrowTheme.value,
                settingCount === 5 ? "forest" : "grape",
              );
              assert.deepEqual(first.settings.bgmVolume, oldSettings.bgmVolume);
              assert.equal(first.settings.colorMode.value, "light");
              assert.equal(first.settings.showMistakes.value, false);
              assert.equal(Object.keys(first.settings).length, 8);
              const remote = (await legacyRef.get()).data();
              assert.equal(
                remote.arrowTheme.value,
                settingCount === 5 ? "forest" : "grape",
              );
              assert.equal(remote.colorMode.value, "light");
              const themed = await cloud.sync(
                owner,
                updateSettings(
                  first,
                  {
                    arrowTheme: "ember",
                    colorMode: "system",
                    showMistakes: true,
                  },
                  "new-device",
                  100,
                ),
              );
              assert.equal(themed.settings.arrowTheme.value, "ember");
              assert.equal(themed.settings.colorMode.value, "system");
              assert.equal(themed.settings.showMistakes.value, true);
              await legacyRef.update({
                sfxEnabled: {
                  value: false,
                  updatedAt: 200,
                  deviceId: "old-device",
                },
              });
              const patched = await cloud.sync(owner, themed);
              assert.equal(patched.settings.arrowTheme.value, "ember");
              assert.equal(patched.settings.sfxEnabled.value, false);
              assert.equal(patched.settings.colorMode.value, "system");
              assert.equal(patched.settings.showMistakes.value, true);
              const record = (
                await legacyDb.doc(`users/${uid}/playSummaries/tx-play`).get()
              ).data();
              if (
                Object.keys(record).sort().join(",") !==
                "difficulty,hintsUsed,misses,playId"
              )
                throw new Error("Unexpected uploaded fields");
            } finally {
              cloud.dispose();
              await firestoreSdk.terminate(firestore);
              await appSdk.deleteApp(firebaseApp);
            }
          }
        },
      );
    } finally {
      await env.cleanup();
    }
  },
);
