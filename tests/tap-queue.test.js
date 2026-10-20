import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const source = await readFile(
  new URL("../js/main.js", import.meta.url),
  "utf8",
);
const queue = source.slice(
  source.indexOf("function tap(id)"),
  source.indexOf("async function performTap(id)"),
);
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup() {
  const calls = [],
    timers = [],
    writes = [];
  const context = vm.createContext({
    pendingTaps: [],
    drainingTaps: false,
    owner: "guest",
    epoch: 0,
    screen: "play",
    stale: false,
    busy: true,
    profile: { activeGame: { playId: "one", remainingIds: ["a", "b"] } },
    setTimeout: (callback) => timers.push(callback),
    performTap: async (id) => {
      calls.push(id);
      await new Promise((resolve) => writes.push(resolve));
      context.profile.activeGame.remainingIds =
        context.profile.activeGame.remainingIds.filter((v) => v !== id);
    },
  });
  vm.runInContext(queue, context);
  return { context, calls, timers, writes };
}
test("taps arriving during a display save are retained and their logical writes run in order", async () => {
  const { context, calls, timers, writes } = setup();
  context.tap("a");
  context.tap("b");
  assert.deepEqual(calls, []);
  context.busy = false;
  timers.shift()();
  await flush();
  assert.deepEqual(calls, ["a"]);
  writes.shift()();
  await flush();
  assert.deepEqual(calls, ["a", "b"]);
  writes.shift()();
  await flush();
  assert.equal(context.drainingTaps, false);
  assert.equal(context.pendingTaps.length, 0);
});
test("queued taps never cross owner, game, Home or stale-state changes", async () => {
  for (const change of [
    (c) => {
      c.owner = "uid:bob";
      c.epoch++;
    },
    (c) => {
      c.profile.activeGame.playId = "two";
    },
    (c) => {
      c.screen = "home";
    },
    (c) => {
      c.stale = true;
    },
  ]) {
    const { context, calls, timers } = setup();
    context.tap("a");
    change(context);
    context.busy = false;
    timers.shift()();
    await flush();
    assert.deepEqual(calls, []);
    assert.equal(context.pendingTaps.length, 0);
  }
});
test("duplicate taps on an arrow already removed by the first request do not select a neighbor", async () => {
  const { context, calls, timers, writes } = setup();
  context.tap("a");
  context.tap("a");
  context.busy = false;
  timers.shift()();
  await flush();
  writes.shift()();
  await flush();
  assert.deepEqual(calls, ["a"]);
  assert.equal(context.pendingTaps.length, 0);
});
