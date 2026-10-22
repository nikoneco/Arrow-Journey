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

test("dark mode recolors existing, hinted, moving and blocked arrows without altering geometry", async (context) => {
  const { view, frame } = renderHost(context);
  view.setBoard(board);
  view.setHint("bend");
  const originalPath = view.groups
    .get("bend")
    .querySelector(".arrow-body")
    .getAttribute("d");
  const ghostDone = view.removeArrow("straight");
  frame(0);
  for (const theme of ARROW_THEMES) {
    assert.match(theme.darkInk, /^#[\da-f]{6}$/i);
    assert.notEqual(theme.darkInk, theme.ink);
    view.setTheme(theme.id, true);
    for (const group of [
      view.groups.get("bend"),
      view.ghosts.get("straight").group,
    ]) {
      assert.equal(group.getAttribute("stroke"), theme.darkInk);
      assert.equal(
        group.querySelector(".arrow-outline").getAttribute("stroke"),
        "#e4bc72",
      );
      assert.equal(
        group.querySelector(".arrow-focus").getAttribute("stroke"),
        "#a9c8b2",
      );
      assert.equal(group.querySelectorAll(".arrow-head").length, 1);
    }
    assert.equal(
      view.groups.get("bend").querySelector(".arrow-body").getAttribute("d"),
      originalPath,
    );
  }
  view.setBoard(board, ["bend"], { hintId: "bend" });
  const recreated = view.groups.get("bend");
  assert.equal(recreated.getAttribute("stroke"), view.ink);
  assert.equal(
    recreated.querySelector(".arrow-outline").getAttribute("stroke"),
    "#e4bc72",
  );
  assert.equal(view.ghosts.size, 1);
  view.setTheme("ocean");
  for (const group of [recreated, view.ghosts.get("straight").group]) {
    assert.equal(
      group.getAttribute("stroke"),
      ARROW_THEMES.find((theme) => theme.id === "ocean").ink,
    );
    assert.equal(
      group.querySelector(".arrow-outline").getAttribute("stroke"),
      "#b78b3e",
    );
    assert.equal(
      group.querySelector(".arrow-focus").getAttribute("stroke"),
      "#718b78",
    );
  }
  view.markBlocked("bend");
  frame(10);
  view.setTheme("ocean", true);
  assert.equal(view.groups.get("bend").getAttribute("stroke"), "#e2a489");
  frame(410);
  assert.equal(
    view.groups.get("bend").getAttribute("stroke"),
    ARROW_THEMES.find((theme) => theme.id === "ocean").darkInk,
  );
  frame(1000);
  await ghostDone;
  view.destroy();
});

test("resumed boards show dots only at removed arrow cell centers below the clipped arrow layers", (context) => {
  const { view } = renderHost(context);
  view.setBoard(board);
  assert.equal(view.dotLayer.children.length, 0);
  assert.deepEqual(view.clipped.children, [
    view.shapeLayer,
    view.dotLayer,
    view.staticLayer,
    view.ghostLayer,
  ]);
  assert.equal(view.dotLayer.parent.parent, view.scene);
  assert.equal(view.dotLayer.getAttribute("aria-hidden"), "true");
  assert.equal(view.dotLayer.getAttribute("pointer-events"), "none");
  view.setBoard(board, ["straight"]);
  assert.deepEqual(
    view.dotLayer.children.map((dot) => [
      Number(dot.getAttribute("cx")),
      Number(dot.getAttribute("cy")),
    ]),
    [
      [0.5, 0.5],
      [1.5, 0.5],
      [1.5, 1.5],
    ],
  );
  for (const dot of view.dotLayer.children) {
    assert.equal(dot.getAttribute("r"), "0.065");
    assert.equal(dot.getAttribute("class"), "board-empty-dot");
  }
  // Original never-occupied cells are not marked as removed.
  assert.equal(view.dotLayer.children.length, board.arrows[0].cells.length);
  view.setBoard(board, ["straight"]);
  assert.equal(view.dotLayer.children.length, 3);
  view.setBoard(board);
  assert.equal(view.dotLayer.children.length, 0);
  view.destroy();
});

test("dots follow saved removal state and theme changes without blocking taps or concurrent ghosts", async (context) => {
  const { view, frame } = renderHost(context);
  const taps = [];
  view.onTap = (id) => taps.push(id);
  view.localPoint = (x, y) => ({ x, y });
  view.setBoard(board);
  const first = view.removeArrow("bend");
  assert.equal(view.dotLayer.children.length, 3);
  assert.equal(view.ghosts.size, 1);
  view.setBoard(board, ["straight"]);
  assert.equal(view.dotLayer.children.length, 3);
  assert.equal(view.ghosts.size, 1);
  const geometry = view.dotLayer.children;
  view.setTheme("grape", true);
  assert.equal(view.dotLayer.getAttribute("fill"), "#7d8a81");
  assert.equal(view.dotLayer.getAttribute("opacity"), "0.45");
  assert.equal(view.dotLayer.children, geometry);
  view.setTheme("ocean", false);
  assert.equal(view.dotLayer.getAttribute("fill"), "#aab1a8");
  view.setView({ zoom: 2, panX: -1, panY: 0 });
  assert.equal(
    view.scene.getAttribute("transform"),
    "translate(-1 0) scale(2)",
  );
  view.tapAt(0.2, 0.5); // A removed cell containing a dot.
  assert.deepEqual(taps, []);
  view.tapAt(3.5, 0.5); // A remaining cell after the same pan and zoom.
  assert.deepEqual(taps, ["straight"]);
  const second = view.removeArrow("straight");
  assert.equal(view.dotLayer.children.length, 5);
  assert.equal(view.ghosts.size, 2);
  frame(0);
  frame(1000);
  await Promise.all([first, second, view.whenIdle()]);
  assert.equal(view.dotLayer.children.length, 5);
  assert.equal(view.ghosts.size, 0);
  view.setBoard(board, ["straight"], { reducedMotion: true });
  await view.removeArrow("straight");
  assert.equal(view.dotLayer.children.length, 5);
  assert.equal(view.ghosts.size, 0);
  view.destroy();
});

test("shape fill and boundary exclude void cells; only removed playable cells become dots", (context) => {
  const { view } = renderHost(context);
  const shaped = {
    ...board,
    shape: "cross",
    mask: board.arrows.flatMap((arrow) => arrow.cells),
  };
  const taps = [];
  view.onTap = (id) => taps.push(id);
  view.localPoint = (x, y) => ({ x, y });
  view.setBoard(shaped);
  const fill = view.shapeLayer.querySelector(".board-shape-fill");
  const outline = view.shapeLayer.querySelector(".board-shape-outline");
  assert.equal(fill.getAttribute("d").match(/Z/g).length, shaped.mask.length);
  assert.equal(outline.getAttribute("d").match(/M/g).length, 12);
  assert.equal(view.shapeLayer.getAttribute("pointer-events"), "none");
  view.tapAt(3.5, 2.5); // Inside the bounding box, outside the playable mask.
  assert.deepEqual(taps, []);
  view.setBoard(shaped, ["straight"]);
  assert.equal(view.dotLayer.children.length, 3);
  for (const dot of view.dotLayer.children) {
    const cell = [
      Number(dot.getAttribute("cx")) - 0.5,
      Number(dot.getAttribute("cy")) - 0.5,
    ];
    assert.ok(shaped.mask.some(([x, y]) => x === cell[0] && y === cell[1]));
  }
  view.setBoard(board); // Legacy rectangular save has no shape/mask metadata.
  assert.equal(view.shapeLayer.children.length, 0);
  view.destroy();
});
