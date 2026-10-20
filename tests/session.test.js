import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
// Exercise the production auth callback with controlled asynchronous reads.
// The assertions concern visible ownership and stale responses, not code spelling.
const source = await readFile(
  new URL("../js/main.js", import.meta.url),
  "utf8",
);
const callback = source.slice(
  source.indexOf("async function switchUser("),
  source.indexOf("function validateSavedGame("),
);
const actions = source.slice(
  source.indexOf("async function action("),
  source.indexOf("async function applyUpdate("),
);
const viewSave = source.slice(
  source.indexOf("function scheduleViewSave("),
  source.indexOf("async function generate("),
);
const refresh = source.slice(
  source.indexOf("function updatePlay("),
  source.indexOf("async function persist("),
);
function setup(read) {
  const events = [],
    app = {
      innerHTML: "Alice private board",
      querySelectorAll() {
        return [];
      },
      querySelector() {
        return null;
      },
    },
    context = vm.createContext({
      owner: "uid:alice",
      profile: { ownerKey: "uid:alice", summaries: { private: 1 } },
      epoch: 0,
      screen: "play",
      completion: null,
      busy: false,
      stale: false,
      viewState: { zoom: 2 },
      boardView: {
        destroy() {
          events.push("destroy");
        },
      },
      saveViewTimer: null,
      syncTimer: null,
      store: { read },
      ownerForUid: (uid) => "uid:" + uid,
      clearTimeout() {},
      structuredClone,
      renderNotices() {},
      updatePlay() {
        events.push("refresh");
      },
      failed(e) {
        context.stale = true;
        events.push("failed:" + e.message);
      },
      header: () => "",
      app,
      applySettings() {},
      render() {
        events.push([
          "render",
          context.owner,
          context.profile?.ownerKey,
          context.busy,
        ]);
      },
      scheduleSync() {},
      fatal(e) {
        app.innerHTML = "recovery:" + e.message;
        events.push("fatal");
      },
    });
  vm.runInContext(callback + "\n" + actions, context);
  return { context, events, app };
}
test("failed target-owner read keeps recovery visible and never renders the previous owner", async () => {
  const { context, events, app } = setup(async () => {
    throw Error("corrupt Bob");
  });
  await context.switchUser({ uid: "bob" });
  assert.equal(context.owner, "uid:bob");
  assert.equal(context.profile, null);
  assert.equal(context.busy, false);
  assert.equal(app.innerHTML, "recovery:corrupt Bob");
  assert.equal(events.filter(Array.isArray).length, 0);
});

test("a profile reload started before an account switch cannot replace the current account", async () => {
  const pending = {};
  const { context } = setup(
    (key) =>
      new Promise((resolve, reject) => {
        pending[key] = { resolve, reject };
      }),
  );
  const old = context.action("reload");
  const next = context.switchUser({ uid: "bob" });
  pending["uid:bob"].resolve({ ownerKey: "uid:bob" });
  await next;
  pending["uid:alice"].resolve({
    ownerKey: "uid:alice",
    summaries: { private: 1 },
  });
  await old;
  assert.equal(context.owner, "uid:bob");
  assert.equal(context.profile.ownerKey, "uid:bob");
  assert.equal(context.busy, false);
  assert.equal(context.stale, false);
});

test("old view-save conflicts do not block a newly selected account", async () => {
  const { context, events } = setup(async (key) => ({ ownerKey: key }));
  let reject;
  context.profile.activeGame = { playId: "p" };
  context.setTimeout = (fn) => {
    context.timer = fn;
    return 1;
  };
  context.persist = () =>
    new Promise((_, no) => {
      reject = no;
    });
  vm.runInContext(viewSave, context);
  context.scheduleViewSave();
  const old = context.timer();
  await context.switchUser({ uid: "bob" });
  reject(Object.assign(Error("old conflict"), { code: "CONFLICT" }));
  await old;
  assert.equal(context.profile.ownerKey, "uid:bob");
  assert.equal(context.stale, false);
  assert.ok(
    !events.some((e) => typeof e === "string" && e.startsWith("failed:")),
  );
});

test("Home controls are re-enabled after a pending display save finishes", async () => {
  const { context, app } = setup(async () => null),
    buttons = [{ disabled: false }, { disabled: false }];
  let done;
  context.profile.activeGame = {
    playId: "p",
    remainingIds: ["a"],
    board: { arrows: [{}] },
    misses: 0,
    hintsUsed: 0,
  };
  context.setTimeout = (fn) => {
    context.timer = fn;
    return 1;
  };
  context.persist = () =>
    new Promise((resolve) => {
      done = resolve;
    });
  app.querySelectorAll = () => buttons;
  context.render = () => {
    for (const b of buttons) b.disabled = context.busy || context.stale;
  };
  vm.runInContext(refresh + "\n" + viewSave, context);
  context.scheduleViewSave();
  const save = context.timer();
  await context.action("home");
  assert.equal(context.screen, "home");
  assert.ok(buttons.every((b) => b.disabled));
  done();
  await save;
  assert.equal(context.busy, false);
  assert.ok(buttons.every((b) => !b.disabled));
});
test("obsolete account reads cannot unlock, render over or replace a newer account", async () => {
  const pending = {};
  const { context, events } = setup(
    (key) =>
      new Promise((resolve, reject) => {
        pending[key] = { resolve, reject };
      }),
  );
  const bob = context.switchUser({ uid: "bob" }),
    carol = context.switchUser({ uid: "carol" });
  pending["uid:bob"].reject(Error("old request"));
  await bob;
  assert.equal(context.busy, true);
  assert.equal(context.profile, null);
  assert.ok(!events.includes("fatal"));
  pending["uid:carol"].resolve({ ownerKey: "uid:carol" });
  await carol;
  assert.equal(context.profile.ownerKey, "uid:carol");
  assert.equal(context.busy, false);
  assert.deepEqual(events.filter(Array.isArray), [
    ["render", "uid:carol", "uid:carol", false],
  ]);
});
