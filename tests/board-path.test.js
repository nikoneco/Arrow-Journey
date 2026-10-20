import test from "node:test";
import assert from "node:assert/strict";
import { BoardView, pathData } from "../js/board-view.js";
import { sampleArrow } from "../js/engine.js";
import { ARROW_THEMES } from "../js/themes.js";

test("quarter-cell quadratic corners preserve endpoints and straight lines", () => {
  assert.equal(
    pathData([
      [0, 0],
      [1, 0],
    ]),
    "M0.5,0.5 L1.5,0.5",
  );
  assert.equal(
    pathData([
      [0, 0],
      [1, 0],
      [1, 1],
    ]),
    "M0.5,0.5 L1.25,0.5 Q1.5,0.5 1.5,0.75 L1.5,1.5",
  );
  assert.equal(
    pathData([
      [0, 0],
      [0, 0],
      [1, 0],
    ]),
    "M0.5,0.5 L1.5,0.5",
  );
});

test("short moving tail segments shrink corners without overshooting the sampled path", () => {
  const arrow = {
    cells: [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
    ],
  };
  const short = pathData(sampleArrow(arrow, 0.9));
  const firstCurve = [...short.matchAll(/([MLQ])([^MLQ]+)/g)].slice(0, 3);
  const entry = firstCurve[1][2].split(",").map(Number);
  const curve = firstCurve[2][2].trim().split(/[ ,]+/).map(Number);
  assert.ok(Math.abs(entry[0] - 1.45) < 1e-12);
  assert.deepEqual(curve.slice(0, 2), [1.5, 0.5]);
  assert.ok(Math.abs(curve[3] - 0.55) < 1e-12);
  for (let distance = 0; distance <= 8; distance += 0.03125) {
    const points = sampleArrow(arrow, distance);
    const commands = [...pathData(points).matchAll(/([MLQ])([^MLQ]+)/g)];
    assert.deepEqual(
      commands[0][2].split(",").map(Number),
      points[0].map((n) => n + 0.5),
    );
    assert.deepEqual(
      commands.at(-1)[2].split(",").map(Number),
      points.at(-1).map((n) => n + 0.5),
    );
    const xs = points.map(([x]) => x + 0.5),
      ys = points.map(([, y]) => y + 0.5);
    for (const [, , coordinates] of commands) {
      const numbers = coordinates.trim().split(/[ ,]+/).map(Number);
      assert.ok(numbers.every(Number.isFinite));
      for (let i = 0; i < numbers.length; i += 2) {
        assert.ok(
          numbers[i] >= Math.min(...xs) - 1e-10 &&
            numbers[i] <= Math.max(...xs) + 1e-10,
        );
        assert.ok(
          numbers[i + 1] >= Math.min(...ys) - 1e-10 &&
            numbers[i + 1] <= Math.max(...ys) + 1e-10,
        );
      }
    }
  }
});

// A small SVG host isolates render/animation contracts without a browser or clock.
class SvgNode {
  constructor() {
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.dataset = {};
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "data-arrow-id") this.dataset.arrowId = String(value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children.forEach((node) => {
      node.parent = null;
    });
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (node) => node !== this,
      );
    this.parent = null;
  }
  querySelectorAll(selector) {
    const classes = selector.split(",").map((part) => part.trim().slice(1));
    return this.children.flatMap((node) => [
      ...(classes.includes(node.getAttribute("class")) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {
    document.activeElement = this;
  }
}

function renderHost(context) {
  const original = {
    document: globalThis.document,
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
  };
  const frames = new Map();
  let nextFrame = 0;
  globalThis.document = {
    createElementNS: () => new SvgNode(),
    activeElement: null,
  };
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  context.after(() => {
    globalThis.document = original.document;
    globalThis.requestAnimationFrame = original.request;
    globalThis.cancelAnimationFrame = original.cancel;
  });
  return {
    view: new BoardView(new SvgNode()),
    frame(time) {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(time));
    },
  };
}

const board = {
  width: 4,
  height: 3,
  arrows: [
    {
      id: "bend",
      cells: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    },
    {
      id: "straight",
      cells: [
        [2, 0],
        [3, 0],
      ],
    },
  ],
};

test("themes cover existing, hinted and blocked arrows, then recover to the selected ink", (context) => {
  const { view, frame } = renderHost(context);
  view.setBoard(board);
  view.setHint("bend");
  for (const theme of ARROW_THEMES) {
    view.setTheme(theme.id);
    for (const group of view.groups.values())
      assert.equal(group.getAttribute("stroke"), theme.ink);
  }
  view.markBlocked("bend");
  frame(0);
  view.setTheme("ocean");
  assert.equal(view.groups.get("bend").getAttribute("stroke"), "#a46b51");
  frame(400);
  assert.equal(
    view.groups.get("bend").getAttribute("stroke"),
    ARROW_THEMES.find((theme) => theme.id === "ocean").ink,
  );
  view.setTheme("unknown");
  assert.equal(view.themeId, "forest");
  view.destroy();
});

test("same-board renders retain simultaneous removal ghosts, theme them and await all completions", async (context) => {
  const { view, frame } = renderHost(context);
  view.setBoard(board);
  const first = view.removeArrow("bend");
  view.setBoard(board, ["straight"]);
  assert.equal(view.ghosts.size, 1);
  assert.equal(view.removeArrow("bend"), first);
  const second = view.removeArrow("straight");
  view.setBoard(board, []);
  assert.equal(view.ghosts.size, 2);
  assert.equal(view.ghostLayer.getAttribute("class"), "arrow-ghosts");
  assert.equal(view.groups.size, 0);
  let finished = false;
  const idle = view.whenIdle().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  view.setTheme("grape");
  frame(0);
  frame(50);
  for (const { group } of view.ghosts.values()) {
    assert.equal(
      group.getAttribute("stroke"),
      ARROW_THEMES.find((theme) => theme.id === "grape").ink,
    );
    const paths = group.querySelectorAll(
      ".arrow-body, .arrow-outline, .arrow-focus",
    );
    assert.equal(new Set(paths.map((path) => path.getAttribute("d"))).size, 1);
    assert.equal(group.querySelectorAll(".arrow-head").length, 1);
  }
  frame(1000);
  await Promise.all([first, second, idle]);
  assert.equal(finished, true);
  assert.equal(view.ghosts.size, 0);
  view.destroy();
});
