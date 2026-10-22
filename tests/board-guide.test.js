import test from "node:test";
import assert from "node:assert/strict";
import { BoardView } from "../js/board-view.js";

class EventHost {
  constructor() {
    this.handlers = new Map();
  }
  addEventListener(type, handler, options) {
    const handlers = this.handlers.get(type) || [];
    handlers.push({ handler, options });
    this.handlers.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.handlers.set(
      type,
      (this.handlers.get(type) || []).filter(
        (entry) => entry.handler !== handler,
      ),
    );
  }
  emit(type, properties = {}) {
    const event = {
      target: this,
      cancelable: true,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...properties,
    };
    for (const { handler } of this.handlers.get(type) || []) handler(event);
    return event;
  }
}

class SvgNode extends EventHost {
  constructor() {
    super();
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.captured = new Set();
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
  closest() {
    return this.dataset.arrowId != null ? this : this.parent?.closest();
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  focus() {
    document.activeElement = this;
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  hasPointerCapture(id) {
    return this.captured.has(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
}

const board = {
  width: 6,
  height: 4,
  arrows: [
    {
      id: "right",
      cells: [
        [0, 0],
        [1, 0],
      ],
    },
    {
      id: "left",
      cells: [
        [5, 1],
        [4, 1],
      ],
    },
    {
      id: "down",
      cells: [
        [0, 1],
        [0, 2],
      ],
    },
    {
      id: 7,
      cells: [
        [2, 3],
        [2, 2],
      ],
    },
    {
      id: "blocker",
      cells: [
        [4, 0],
        [5, 0],
      ],
    },
  ],
};

function host(context, initialBoard = board) {
  const original = {
    document: globalThis.document,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
  };
  const page = new EventHost();
  page.hidden = false;
  page.activeElement = null;
  page.defaultView = new EventHost();
  page.createElementNS = () => {
    const node = new SvgNode();
    node.ownerDocument = page;
    return node;
  };
  globalThis.document = page;
  const timers = new Map();
  let now = 0,
    nextTimer = 0;
  globalThis.setTimeout = (callback, delay) => {
    timers.set(++nextTimer, { callback, at: now + delay });
    return nextTimer;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const taps = [];
  const view = new BoardView(new SvgNode(), { onTap: (id) => taps.push(id) });
  // Forty CSS pixels per cell keeps the existing 8 CSS-pixel drag threshold
  // independent of board coordinates, zoom and pan.
  view.localPoint = (x, y) => ({ x: x / 40, y: y / 40 });
  view.setBoard(initialBoard);
  context.after(() => {
    view.destroy();
    globalThis.document = original.document;
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    globalThis.requestAnimationFrame = original.request;
    globalThis.cancelAnimationFrame = original.cancel;
  });
  return {
    view,
    taps,
    page,
    timers,
    ray: () => view.guideLayer.querySelector(".board-ray-guide"),
    pointer(type, x = 20, y = 20, properties = {}) {
      return view.svg.emit(type, {
        pointerId: 1,
        pointerType: "touch",
        button: 0,
        clientX: x,
        clientY: y,
        ...properties,
      });
    },
    tick(elapsed) {
      now += elapsed;
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      for (const [id, { callback }] of due) {
        timers.delete(id);
        callback();
      }
    },
  };
}

function coordinates(ray) {
  return ["x1", "y1", "x2", "y2"].map((name) => Number(ray.getAttribute(name)));
}

test("450 ms hold shows a neutral ray from the head; release consumes the hold without a tap", (context) => {
  const h = host(context);
  const group = h.view.groups.get("right");
  const label = group.getAttribute("aria-label");
  // This corner is far from the arrow stroke, but inside its tail square.
  h.pointer("pointerdown", 0.4, 0.4);
  h.tick(449);
  assert.equal(h.ray(), null);
  assert.deepEqual(h.taps, []);
  h.tick(1);
  assert.deepEqual(coordinates(h.ray()), [1.5, 0.5, 6, 0.5]);
  assert.equal(h.ray().getAttribute("stroke-width"), "0.07");
  assert.equal(h.ray().getAttribute("stroke-dasharray"), "0.18 0.16");
  assert.equal(group.getAttribute("aria-label"), label);
  assert.equal(group.getAttribute("aria-description"), null);
  assert.equal(h.view.remaining.size, board.arrows.length);
  h.pointer("pointerup", 0.4, 0.4);
  assert.equal(h.ray(), null);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.taps, []);
});

test("any occupied cell and corner can hold in all four directions, with mouse, touch or pen", (context) => {
  const h = host(context);
  const endpoints = new Map([
    ["right", [1.5, 0.5, 6, 0.5]],
    ["left", [4.5, 1.5, 0, 1.5]],
    ["down", [0.5, 2.5, 0.5, 4]],
    [7, [2.5, 2.5, 2.5, 0]],
  ]);
  for (const arrow of board.arrows.slice(0, 4))
    for (const [x, y] of arrow.cells)
      for (const [dx, dy, pointerType] of [
        [0.01, 0.01, "mouse"],
        [0.99, 0.01, "touch"],
        [0.01, 0.99, "pen"],
        [0.99, 0.99, "touch"],
      ]) {
        const px = (x + dx) * 40,
          py = (y + dy) * 40;
        h.pointer("pointerdown", px, py, { pointerType });
        h.tick(450);
        assert.deepEqual(coordinates(h.ray()), endpoints.get(arrow.id));
        h.pointer("pointerup", px, py, { pointerType });
        assert.equal(h.ray(), null);
      }
  assert.deepEqual(h.taps, []);
  h.pointer("pointerdown", 20, 20, { pointerType: "mouse", button: 2 });
  h.tick(450);
  assert.equal(h.ray(), null);
});

test("quick and rapid successive taps stay immediate, including a same-board save render during a press", (context) => {
  const h = host(context);
  for (const [x, y] of [
    [20, 20],
    [180, 60],
    [100, 100],
  ]) {
    h.pointer("pointerdown", x, y);
    h.tick(100);
    h.pointer("pointerup", x, y);
  }
  assert.deepEqual(h.taps, ["right", "left", 7]);
  assert.equal(h.ray(), null);
  assert.equal(h.timers.size, 0);
  h.pointer("pointerdown");
  h.view.setBoard(board, ["right", "left", "down", 7]);
  h.tick(100);
  h.pointer("pointerup");
  assert.deepEqual(h.taps, ["right", "left", 7, "right"]);
});

test("rays cross shape holes and blockers to the bounding edge without revealing removability", (context) => {
  const ring = {
    width: 6,
    height: 4,
    shape: "ring",
    mask: Array.from({ length: 24 }, (_, index) => [
      index % 6,
      Math.floor(index / 6),
    ]).filter(([x, y]) => x < 2 || x > 3 || y === 0 || y === 3),
    arrows: [
      {
        id: "held",
        cells: [
          [0, 1],
          [1, 1],
        ],
      },
      {
        id: "blocker",
        cells: [
          [4, 1],
          [5, 1],
        ],
      },
    ],
  };
  const h = host(context, ring);
  h.pointer("pointerdown", 20, 60);
  h.tick(450);
  const attributes = new Map(h.ray().attributes);
  assert.deepEqual(coordinates(h.ray()), [1.5, 1.5, 6, 1.5]);
  h.pointer("pointerup", 20, 60);
  h.view.setBoard(ring, ["held"]); // The same ray when it is the only arrow.
  h.pointer("pointerdown", 20, 60);
  h.tick(450);
  assert.deepEqual(h.ray().attributes, attributes);
  h.pointer("pointerup", 20, 60);
  h.pointer("pointerdown", 100, 60); // Hole inside the bounding box.
  h.tick(450);
  assert.equal(h.ray(), null);
  h.pointer("pointerup", 100, 60);
  assert.deepEqual(h.taps, []);
});

test("empty, removed, moving and out-of-viewport cells never become hold targets", async (context) => {
  const h = host(context);
  const removal = h.view.removeArrow("right");
  assert.equal(h.view.ghosts.has("right"), true);
  for (const [x, y] of [
    [20, 20],
    [140, 140],
    [-0.1, 20],
    [240, 20],
  ]) {
    h.pointer("pointerdown", x, y);
    h.tick(600);
    assert.equal(h.ray(), null);
    h.pointer("pointerup", x, y);
  }
  h.view.setView({ zoom: 2, panX: -1, panY: -1 });
  h.pointer("pointerdown", -0.1, 100);
  h.tick(600);
  assert.equal(h.ray(), null);
  h.pointer("pointerup", -0.1, 100);
  assert.deepEqual(h.taps, []);
  h.view.destroy();
  await removal;
});

test("small finger drift retains a stationary guide; reaching 8 CSS pixels cancels it and excludes a tap", (context) => {
  const h = host(context);
  h.view.setView({ zoom: 2, panX: 0, panY: 0 });
  h.pointer("pointerdown");
  h.pointer("pointermove", 27.9, 20);
  h.tick(450);
  assert.ok(h.ray());
  const transform = h.view.scene.getAttribute("transform");
  h.pointer("pointermove", 27, 20);
  assert.equal(h.view.scene.getAttribute("transform"), transform);
  h.pointer("pointermove", 28, 20);
  assert.equal(h.ray(), null);
  h.pointer("pointermove", 20, 20);
  h.pointer("pointerup");
  assert.deepEqual(h.taps, []);
  h.pointer("pointerdown");
  const queued = [...h.timers.values()][0].callback;
  h.pointer("pointermove", 29, 20);
  queued();
  h.tick(600);
  assert.equal(h.ray(), null);
  h.pointer("pointerup", 29, 20);
  assert.deepEqual(h.taps, []);
});

const cancellations = {
  pointercancel: (h) => h.pointer("pointercancel"),
  lostcapture: (h) => h.pointer("lostpointercapture"),
  blur: (h) => h.page.defaultView.emit("blur"),
  hidden: (h) => {
    h.page.hidden = true;
    h.page.emit("visibilitychange");
  },
  wheel: (h) =>
    h.view.svg.emit("wheel", {
      clientX: 20,
      clientY: 20,
      deltaY: -10,
      deltaMode: 0,
    }),
  zoom: (h) => h.view.zoom(1.3),
  fit: (h) => h.view.reset(),
  restoreView: (h) => h.view.setView({ zoom: 2, panX: -1, panY: 0 }),
  boardChange: (h) => h.view.setBoard({ ...board, width: 7 }),
  targetRemoved: (h) => h.view.removeArrow("right"),
  targetMissingFromRender: (h) =>
    h.view.setBoard(board, ["left", "down", 7, "blocker"]),
  secondFinger: (h) => h.pointer("pointerdown", 80, 20, { pointerId: 2 }),
  destroy: (h) => h.view.destroy(),
};

for (const [name, cancel] of Object.entries(cancellations))
  for (const shown of [false, true])
    test(`${name} clears ${shown ? "a shown" : "a pending"} guide and stale callbacks cannot revive it`, (context) => {
      const h = host(context);
      h.pointer("pointerdown");
      const queued = [...h.timers.values()][0].callback;
      if (shown) {
        h.tick(450);
        assert.ok(h.ray());
      }
      cancel(h);
      queued();
      h.tick(1000);
      assert.equal(h.ray(), null);
      assert.equal(h.timers.size, 0);
      h.pointer("pointerup");
      h.pointer("pointerup", 80, 20, { pointerId: 2 });
      assert.deepEqual(h.taps, []);
    });

test("a pinch cannot turn its remaining finger into a hold or a tap; a fresh gesture still works", (context) => {
  const h = host(context);
  h.pointer("pointerdown");
  h.pointer("pointerdown", 80, 20, { pointerId: 2 });
  h.pointer("pointermove", 100, 20, { pointerId: 2 });
  h.pointer("pointerup", 100, 20, { pointerId: 2 });
  h.tick(1000);
  assert.equal(h.ray(), null);
  h.pointer("pointerup");
  assert.deepEqual(h.taps, []);
  h.view.reset();
  h.pointer("pointerdown");
  h.tick(100);
  h.pointer("pointerup");
  assert.deepEqual(h.taps, ["right"]);
});

test("same-board settings renders safely retain pending and shown holds; the ray follows theme and board transform", (context) => {
  const h = host(context);
  h.view.setView({ zoom: 2, panX: -1, panY: 0 });
  h.pointer("pointerdown", 80, 40);
  h.tick(200);
  h.view.setBoard(board, undefined, { reducedMotion: true });
  h.tick(250);
  const ray = h.ray();
  assert.ok(ray);
  assert.deepEqual(coordinates(ray), [1.5, 0.5, 6, 0.5]);
  assert.equal(
    h.view.scene.getAttribute("transform"),
    "translate(-1 0) scale(2)",
  );
  assert.equal(ray.parent, h.view.guideLayer);
  assert.equal(h.view.guideLayer.parent, h.view.clipped);
  assert.equal(h.view.clipped.parent, h.view.scene);
  assert.equal(
    h.view.clipped.getAttribute("clip-path"),
    `url(#${h.view.clipId})`,
  );
  for (const element of [ray, h.view.guideLayer]) {
    assert.equal(element.getAttribute("aria-hidden"), "true");
    assert.equal(element.getAttribute("pointer-events"), "none");
  }
  assert.equal(ray.getAttribute("stroke"), "#87958c");
  h.view.setTheme("ocean", true);
  assert.equal(ray.getAttribute("stroke"), "#98aba0");
  h.view.setBoard(board);
  assert.equal(h.ray(), ray);
  h.view.setTheme("grape", false);
  assert.equal(ray.getAttribute("stroke"), "#87958c");
  h.pointer("pointerup", 80, 40);
  assert.equal(h.ray(), null);
  assert.deepEqual(h.taps, []);
});

test("hidden or detached boards cannot activate a queued hold, including before visibilitychange arrives", (context) => {
  const h = host(context);
  h.pointer("pointerdown");
  h.page.hidden = true;
  h.tick(450);
  assert.equal(h.ray(), null);
  h.pointer("pointerup");
  h.pointer("pointerdown");
  assert.equal(h.timers.size, 0);
  h.page.hidden = false;
  h.pointer("pointerdown");
  h.view.svg.isConnected = false;
  h.tick(450);
  assert.equal(h.ray(), null);
  h.pointer("pointerup");
  assert.deepEqual(h.taps, []);
});

test("native gesture prevention stays board-only, keyboard behavior is preserved, and destroy removes all listeners", (context) => {
  const h = host(context);
  for (const type of [
    "touchstart",
    "touchmove",
    "touchend",
    "dblclick",
    "contextmenu",
  ]) {
    assert.equal(h.view.svg.handlers.get(type)[0].options.passive, false);
    assert.equal(h.view.svg.emit(type).defaultPrevented, true);
    assert.equal(
      h.view.svg.emit(type, { cancelable: false }).defaultPrevented,
      false,
    );
    assert.equal(h.page.handlers.has(type), false);
  }
  assert.deepEqual(h.taps, []);
  const target = h.view.groups.get("right").querySelector(".arrow-body");
  h.view.svg.emit("keydown", { key: "Enter", target, repeat: false });
  h.view.svg.emit("keydown", { key: " ", target, repeat: false });
  h.view.svg.emit("keydown", { key: "Enter", target, repeat: true });
  assert.deepEqual(h.taps, ["right", "right"]);
  h.view.destroy();
  for (const surface of [h.view.svg, h.page, h.page.defaultView])
    for (const handlers of surface.handlers.values())
      assert.equal(handlers.length, 0);
});
