import { sampleArrow } from "./engine.js";
import { ARROW_THEMES } from "./themes.js";

const NS = "http://www.w3.org/2000/svg";
const HOLD_GUIDE_MS = 450;
const ACCENT_COLORS = Object.freeze({
  light: Object.freeze({
    hint: "#b78b3e",
    focus: "#718b78",
    blocked: "#a46b51",
    dot: "#aab1a8",
    guide: "#87958c",
  }),
  dark: Object.freeze({
    hint: "#e4bc72",
    focus: "#a9c8b2",
    blocked: "#e2a489",
    dot: "#7d8a81",
    guide: "#98aba0",
  }),
});
let nextClip = 0;

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
  return element;
}

export function pathData(points) {
  const vertices = points.filter(
    (point, index) =>
      !index ||
      point[0] !== points[index - 1][0] ||
      point[1] !== points[index - 1][1],
  );
  if (!vertices.length) return "";
  const coordinate = ([x, y]) => `${x + 0.5},${y + 0.5}`;
  const commands = [`M${coordinate(vertices[0])}`];
  for (let index = 1; index < vertices.length - 1; index += 1) {
    const previous = vertices[index - 1],
      corner = vertices[index],
      next = vertices[index + 1];
    const incoming = [corner[0] - previous[0], corner[1] - previous[1]];
    const outgoing = [next[0] - corner[0], next[1] - corner[1]];
    const before = Math.hypot(...incoming),
      after = Math.hypot(...outgoing);
    const cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
    if (Math.abs(cross) <= before * after * 1e-10) {
      commands.push(`L${coordinate(corner)}`);
      continue;
    }
    // Half-length limits keep neighboring bends and fractional moving tails apart.
    const radius = Math.min(0.25, before / 2, after / 2);
    const entry = corner.map(
      (value, axis) => value - (incoming[axis] / before) * radius,
    );
    const exit = corner.map(
      (value, axis) => value + (outgoing[axis] / after) * radius,
    );
    commands.push(
      `L${coordinate(entry)} Q${coordinate(corner)} ${coordinate(exit)}`,
    );
  }
  if (vertices.length > 1) commands.push(`L${coordinate(vertices.at(-1))}`);
  return commands.join(" ");
}

function headData(points) {
  const tip = points[points.length - 1];
  const previous = points[points.length - 2];
  const length = Math.hypot(tip[0] - previous[0], tip[1] - previous[1]) || 1;
  const dx = (tip[0] - previous[0]) / length;
  const dy = (tip[1] - previous[1]) / length;
  const x = tip[0] + 0.5,
    y = tip[1] + 0.5;
  return `M${x - dx * 0.23 - dy * 0.17},${y - dy * 0.23 + dx * 0.17} L${x},${y} L${x - dx * 0.23 + dy * 0.17},${y - dy * 0.23 - dx * 0.17}`;
}

/** SVG board and gestures. Game rules and input locking remain with the caller. */
export class BoardView {
  constructor(container, { onTap = () => {}, onViewChange = () => {} } = {}) {
    this.container = container;
    this.onTap = onTap;
    this.onViewChange = onViewChange;
    this.board = null;
    this.fingerprint = "";
    this.remaining = new Set();
    this.arrows = new Map();
    this.cellOwners = new Map();
    this.groups = new Map();
    this.ghosts = new Map();
    this.feedback = new Map();
    this.pointers = new Map();
    this.zoomLevel = 1;
    this.panX = 0;
    this.panY = 0;
    this.destroyed = false;
    this.gestureCancelled = false;
    this.dragging = false;
    this.pinch = null;
    this.holdGuide = null;
    this.listeners = [];
    this.themeId = "forest";
    this.dark = false;
    this.colors = ACCENT_COLORS.light;
    this.ink = ARROW_THEMES.find((theme) => theme.id === "forest").ink;

    this.svg = svgElement("svg", {
      class: "board-svg",
      viewBox: "0 0 20 20",
      preserveAspectRatio: "xMidYMid meet",
      role: "group",
      "aria-label": "矢印パズル盤面",
    });
    this.svg.style.cssText =
      "display:block;width:100%;height:100%;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;cursor:pointer;";
    const defs = svgElement("defs");
    this.clipId = `arrow-board-clip-${++nextClip}`;
    const clip = svgElement("clipPath", {
      id: this.clipId,
      clipPathUnits: "userSpaceOnUse",
    });
    this.clipRect = svgElement("rect", { x: 0, y: 0, width: 20, height: 20 });
    clip.append(this.clipRect);
    defs.append(clip);
    const focusStyle = svgElement("style");
    focusStyle.textContent =
      ".board-arrow:focus{outline:none}.board-arrow:focus-visible .arrow-focus{opacity:1}";
    defs.append(focusStyle);
    this.scene = svgElement("g");
    this.clipped = svgElement("g", { "clip-path": `url(#${this.clipId})` });
    this.shapeLayer = svgElement("g", {
      class: "board-shape",
      "aria-hidden": "true",
      "pointer-events": "none",
    });
    this.dotLayer = svgElement("g", {
      class: "board-empty-dots",
      "aria-hidden": "true",
      "pointer-events": "none",
      fill: this.colors.dot,
      opacity: 0.45,
    });
    this.staticLayer = svgElement("g");
    this.guideLayer = svgElement("g", {
      class: "board-guide",
      "aria-hidden": "true",
      "pointer-events": "none",
    });
    this.ghostLayer = svgElement("g", {
      class: "arrow-ghosts",
      "aria-hidden": "true",
      "pointer-events": "none",
    });
    this.clipped.append(
      this.shapeLayer,
      this.dotLayer,
      this.guideLayer,
      this.staticLayer,
      this.ghostLayer,
    );
    this.scene.append(this.clipped);
    this.svg.append(defs, this.scene);
    container.append(this.svg);

    // Some iOS versions still zoom after rapid taps despite touch-action.
    // Cancel only the browser gesture; Pointer Events handle every game tap
    // and our two-finger pinch, without a double-tap debounce or second input path.
    for (const type of [
      "touchstart",
      "touchmove",
      "touchend",
      "dblclick",
      "contextmenu",
    ])
      this.listen(
        type,
        (event) => {
          if (event.cancelable) event.preventDefault();
        },
        { passive: false },
      );

    this.listen("pointerdown", (event) => this.pointerDown(event));
    this.listen("pointermove", (event) => this.pointerMove(event));
    this.listen("pointerup", (event) => this.pointerEnd(event, false));
    this.listen("pointercancel", (event) => this.pointerEnd(event, true));
    this.listen("lostpointercapture", (event) => {
      if (this.pointers.has(event.pointerId)) this.pointerEnd(event, true);
    });
    this.listen(
      "wheel",
      (event) => {
        if (!this.board) return;
        event.preventDefault();
        const units =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? this.svg.clientHeight
              : 1;
        this.zoomAt(
          Math.exp(-event.deltaY * units * 0.0016),
          this.localPoint(event.clientX, event.clientY),
        );
        if (this.pointers.size) this.gestureCancelled = true;
      },
      { passive: false },
    );
    this.listen("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const group = event.target.closest?.("[data-arrow-id]");
      if (!group || !this.svg.contains(group)) return;
      event.preventDefault();
      if (!event.repeat && this.remaining.has(group.dataset.arrowId))
        this.onTap(this.arrows.get(group.dataset.arrowId).id);
    });
    this.pageDocument = this.svg.ownerDocument || document;
    if (this.pageDocument.addEventListener)
      this.listen(
        "visibilitychange",
        () => {
          if (this.pageDocument.hidden) this.cancelGesture();
        },
        undefined,
        this.pageDocument,
      );
    const pageWindow = this.pageDocument.defaultView || globalThis.window;
    if (pageWindow?.addEventListener)
      this.listen("blur", () => this.cancelGesture(), undefined, pageWindow);
    const resize = () => {
      if (this.updateViewport()) {
        this.cancelGesture();
        this.applyView();
      }
    };
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(resize);
      this.resizeObserver.observe(this.svg);
    } else if (pageWindow?.addEventListener) {
      this.listen("resize", resize, undefined, pageWindow);
    }
  }

  listen(type, handler, options, target = this.svg) {
    target.addEventListener(type, handler, options);
    this.listeners.push([target, type, handler, options]);
  }

  setBoard(
    board,
    remainingIds = board.arrows.map((arrow) => arrow.id),
    { hintId = null, reducedMotion = false } = {},
  ) {
    if (this.destroyed) return;
    const fingerprint = JSON.stringify([
      board.width,
      board.height,
      board.shape,
      board.mask,
      board.arrows.map(({ id, cells }) => [id, cells]),
    ]);
    const changed = this.fingerprint !== fingerprint;
    if (changed) {
      this.cancelAnimations();
      this.cancelGesture();
      this.fingerprint = fingerprint;
      this.zoomLevel = 1;
      this.panX = this.panY = 0;
    }
    this.board = board;
    if (changed) this.updateShape();
    this.reducedMotion = reducedMotion;
    this.hintId = hintId == null ? null : String(hintId);
    this.arrows = new Map(
      board.arrows.map((arrow) => [String(arrow.id), arrow]),
    );
    this.cellOwners.clear();
    for (const [id, arrow] of this.arrows)
      for (const [x, y] of arrow.cells)
        this.cellOwners.set(y * board.width + x, id);
    this.remaining = new Set(Array.from(remainingIds, String));
    // A save for another arrow or a settings render keeps the same gesture.
    // In particular, it must not discard a rapid tap already in progress.
    if (
      this.holdGuide &&
      (!this.remaining.has(this.holdGuide.id) ||
        this.ghosts.has(this.holdGuide.id))
    )
      this.cancelGesture();
    this.updateDots();
    this.updateViewport();
    this.clipRect.setAttribute("width", board.width);
    this.clipRect.setAttribute("height", board.height);
    const focusedId = document.activeElement?.dataset?.arrowId;
    this.stopFeedback();
    this.staticLayer.replaceChildren();
    this.groups.clear();
    for (const [id, arrow] of this.arrows) {
      if (!this.remaining.has(id) || this.ghosts.has(id)) continue;
      const group = this.makeArrow(arrow, true);
      this.groups.set(id, group);
      this.staticLayer.append(group);
    }
    if (focusedId && this.groups.has(focusedId))
      this.groups.get(focusedId).focus({ preventScroll: true });
    this.updateHints();
    this.applyView();
  }

  makeArrow(arrow, interactive = false) {
    const bodyPath = pathData(arrow.cells);
    const group = svgElement("g", {
      fill: "none",
      stroke: this.ink,
      "stroke-width": 0.13,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    if (interactive) {
      const cells = arrow.cells;
      const head = cells.at(-1),
        previous = cells.at(-2);
      const direction =
        head[0] > previous[0]
          ? "右"
          : head[0] < previous[0]
            ? "左"
            : head[1] > previous[1]
              ? "下"
              : "上";
      group.setAttribute("class", "board-arrow");
      group.setAttribute("data-arrow-id", String(arrow.id));
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `${direction}向きの矢印 ${arrow.id}`);
      group.style.cursor = "pointer";
    }
    const outline = svgElement("path", {
      class: "arrow-outline",
      d: bodyPath,
      stroke: this.colors.hint,
      "stroke-width": 0.28,
      opacity: 0,
    });
    const body = svgElement("path", {
      class: "arrow-body",
      d: bodyPath,
    });
    const head = svgElement("path", {
      class: "arrow-head",
      d: headData(arrow.cells),
    });
    const focus = svgElement("path", {
      class: "arrow-focus",
      d: bodyPath,
      stroke: this.colors.focus,
      "stroke-width": 0.34,
      opacity: 0,
      "pointer-events": "none",
    });
    // The focus halo sits behind the line and never adds a second arrowhead.
    group.append(focus, outline, body, head);
    return group;
  }

  setHint(id) {
    this.hintId = id == null ? null : String(id);
    this.updateHints();
  }

  updateShape() {
    this.shapeLayer.replaceChildren();
    if (!this.board?.mask || this.board.shape === "square") return;
    const cells = new Set(this.board.mask.map(([x, y]) => `${x},${y}`));
    const fill = [],
      edges = [];
    for (const [x, y] of this.board.mask) {
      fill.push(`M${x},${y}h1v1h-1Z`);
      if (!cells.has(`${x},${y - 1}`)) edges.push(`M${x},${y}h1`);
      if (!cells.has(`${x + 1},${y}`)) edges.push(`M${x + 1},${y}v1`);
      if (!cells.has(`${x},${y + 1}`)) edges.push(`M${x},${y + 1}h1`);
      if (!cells.has(`${x - 1},${y}`)) edges.push(`M${x},${y}v1`);
    }
    this.shapeLayer.append(
      svgElement("path", { class: "board-shape-fill", d: fill.join(" ") }),
      svgElement("path", { class: "board-shape-outline", d: edges.join(" ") }),
    );
  }

  updateDots() {
    if (!this.board || this.destroyed) return;
    this.dotLayer.replaceChildren();
    for (const [id, arrow] of this.arrows) {
      if (this.remaining.has(id)) continue;
      for (const [x, y] of arrow.cells)
        this.dotLayer.append(
          svgElement("circle", {
            class: "board-empty-dot",
            cx: x + 0.5,
            cy: y + 0.5,
            r: 0.065,
          }),
        );
    }
  }

  setTheme(themeId, dark = false) {
    if (this.destroyed) return;
    const theme =
      ARROW_THEMES.find((candidate) => candidate.id === themeId) ||
      ARROW_THEMES.find((candidate) => candidate.id === "forest");
    this.themeId = theme.id;
    this.dark = Boolean(dark);
    this.colors = this.dark ? ACCENT_COLORS.dark : ACCENT_COLORS.light;
    this.ink = this.dark ? theme.darkInk : theme.ink;
    this.dotLayer.setAttribute("fill", this.colors.dot);
    this.guideLayer
      .querySelector(".board-ray-guide")
      ?.setAttribute("stroke", this.colors.guide);
    this.updateHints();
    for (const { group } of this.ghosts.values()) this.colorArrow(group);
  }

  colorArrow(group, blocked = false) {
    group.setAttribute("stroke", blocked ? this.colors.blocked : this.ink);
    group
      .querySelector(".arrow-outline")
      .setAttribute("stroke", this.colors.hint);
    group
      .querySelector(".arrow-focus")
      .setAttribute("stroke", this.colors.focus);
  }

  updateHints() {
    for (const [id, group] of this.groups) {
      const hinted = id === this.hintId;
      group
        .querySelector(".arrow-outline")
        .setAttribute("opacity", hinted ? "0.9" : "0");
      const blocked = this.feedback.get(id);
      this.colorArrow(group, blocked && blocked.progress < 0.8);
      group.setAttribute("stroke-width", hinted ? "0.16" : "0.13");
      if (hinted) group.setAttribute("aria-description", "ヒントの矢印");
      else group.removeAttribute("aria-description");
    }
  }

  markBlocked(id) {
    const key = String(id),
      group = this.groups.get(key);
    if (!group || this.destroyed) return;
    const prior = this.feedback.get(key);
    if (prior) cancelAnimationFrame(prior.frame);
    let started;
    const feedback = { frame: 0, progress: 0 };
    this.feedback.set(key, feedback);
    const tick = (time) => {
      if (started === undefined) started = time;
      const progress = Math.min(1, (time - started) / 460);
      feedback.progress = progress;
      group.setAttribute(
        "stroke",
        progress < 0.8 ? this.colors.blocked : this.ink,
      );
      const offset = this.reducedMotion
        ? 0
        : Math.sin(progress * Math.PI * 6) * 0.085 * (1 - progress);
      group.setAttribute("transform", `translate(${offset} 0)`);
      if (progress < 1) feedback.frame = requestAnimationFrame(tick);
      else {
        group.removeAttribute("transform");
        this.feedback.delete(key);
      }
    };
    feedback.frame = requestAnimationFrame(tick);
  }

  removeArrow(id) {
    const key = String(id);
    if (this.holdGuide?.id === key) this.cancelGesture();
    if (this.ghosts.has(key)) return this.ghosts.get(key).promise;
    const arrow = this.arrows.get(key);
    this.remaining.delete(key);
    this.updateDots();
    this.groups.get(key)?.remove();
    this.groups.delete(key);
    if (!arrow || !this.board || this.reducedMotion || this.destroyed)
      return Promise.resolve();
    const group = this.makeArrow(arrow);
    this.ghostLayer.append(group);
    const head = arrow.cells.at(-1),
      previous = arrow.cells.at(-2);
    const dx = head[0] - previous[0],
      dy = head[1] - previous[1];
    const exit =
      dx > 0
        ? this.board.width - head[0] - 0.5
        : dx < 0
          ? head[0] + 0.5
          : dy > 0
            ? this.board.height - head[1] - 0.5
            : head[1] + 0.5;
    const travel = arrow.cells.length - 1 + exit + 0.4;
    const duration = Math.max(350, Math.min(800, 280 + travel * 12));
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const animation = { group, promise, resolve, frame: 0 };
    this.ghosts.set(key, animation);
    let started;
    const tick = (time) => {
      if (started === undefined) started = time;
      const progress = Math.min(1, (time - started) / duration);
      // Sampling Q([s, L+s]) preserves every bend until the tail reaches it.
      const distance = travel * progress * progress * (3 - 2 * progress);
      const points = sampleArrow(arrow, distance);
      const bodyPath = pathData(points);
      for (const path of group.querySelectorAll(
        ".arrow-body, .arrow-outline, .arrow-focus",
      ))
        path.setAttribute("d", bodyPath);
      group.querySelector(".arrow-head").setAttribute("d", headData(points));
      if (progress < 1) animation.frame = requestAnimationFrame(tick);
      else {
        group.remove();
        this.ghosts.delete(key);
        resolve();
      }
    };
    animation.frame = requestAnimationFrame(tick);
    return promise;
  }

  whenIdle() {
    return Promise.all(
      Array.from(this.ghosts.values(), ({ promise }) => promise),
    );
  }

  localPoint(clientX, clientY) {
    const matrix = this.svg.getScreenCTM();
    if (matrix) {
      const point = this.svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const result = point.matrixTransform(matrix.inverse());
      return { x: result.x, y: result.y };
    }
    const rect = this.svg.getBoundingClientRect();
    const viewport = this.viewport || {
      x: 0,
      y: 0,
      width: this.board?.width || 20,
      height: this.board?.height || 20,
    };
    const { width, height } = viewport;
    const scale = Math.min(rect.width / width, rect.height / height) || 1;
    return {
      x:
        viewport.x +
        (clientX - rect.left - (rect.width - width * scale) / 2) / scale,
      y:
        viewport.y +
        (clientY - rect.top - (rect.height - height * scale) / 2) / scale,
    };
  }

  pointerDown(event) {
    if (
      !this.board ||
      this.destroyed ||
      this.pageDocument.hidden ||
      (event.pointerType === "mouse" && event.button !== 0)
    )
      return;
    event.preventDefault();
    if (!this.pointers.size) {
      this.gestureCancelled = false;
      this.dragging = false;
    }
    this.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
    try {
      this.svg.setPointerCapture(event.pointerId);
    } catch {
      /* A detached pointer is cancelled on its next event. */
    }
    if (this.pointers.size >= 2) {
      this.gestureCancelled = true;
      this.clearHoldGuide();
      this.startPinch();
    } else this.startHoldGuide(event.pointerId);
  }

  startHoldGuide(pointerId) {
    this.clearHoldGuide();
    const pointer = this.pointers.get(pointerId);
    const id = this.arrowAt(pointer.x, pointer.y);
    if (id == null) return;
    const hold = { pointerId, id, fingerprint: this.fingerprint, timer: null };
    this.holdGuide = hold;
    hold.timer = setTimeout(() => {
      // Check the gesture identity as well as current board state: even an
      // already-queued callback cannot revive a cancelled or replaced hold.
      if (this.holdGuide !== hold) return;
      hold.timer = null;
      const current = this.pointers.get(pointerId);
      if (
        this.destroyed ||
        this.pageDocument.hidden ||
        this.svg.isConnected === false ||
        this.fingerprint !== hold.fingerprint ||
        this.gestureCancelled ||
        this.dragging ||
        this.pointers.size !== 1 ||
        !current ||
        this.arrowAt(current.x, current.y) !== id
      ) {
        this.gestureCancelled = true;
        this.clearHoldGuide();
        return;
      }
      // A guide conveys direction only. Never ask the rules whether this arrow
      // can move, or use collision state to change the ray's length or color.
      const cells = this.arrows.get(id).cells;
      const head = cells.at(-1),
        previous = cells.at(-2);
      const dx = head[0] - previous[0],
        dy = head[1] - previous[1];
      const x = head[0] + 0.5,
        y = head[1] + 0.5;
      this.guideLayer.replaceChildren(
        svgElement("line", {
          class: "board-ray-guide",
          x1: x,
          y1: y,
          x2: dx > 0 ? this.board.width : dx < 0 ? 0 : x,
          y2: dy > 0 ? this.board.height : dy < 0 ? 0 : y,
          fill: "none",
          stroke: this.colors.guide,
          "stroke-width": 0.07,
          "stroke-dasharray": "0.18 0.16",
          "stroke-linecap": "round",
          opacity: 0.7,
          "pointer-events": "none",
          "aria-hidden": "true",
        }),
      );
      hold.shown = true;
    }, HOLD_GUIDE_MS);
  }

  clearHoldGuide() {
    if (this.holdGuide?.timer != null) clearTimeout(this.holdGuide.timer);
    this.holdGuide = null;
    this.guideLayer.replaceChildren();
  }

  startPinch() {
    const [a, b] = this.pointers.values();
    if (!b) {
      this.pinch = null;
      return;
    }
    const center = this.localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    this.pinch = {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      zoom: this.zoomLevel,
      boardX: (center.x - this.panX) / this.zoomLevel,
      boardY: (center.y - this.panY) / this.zoomLevel,
    };
  }

  pointerMove(event) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    const old = this.localPoint(pointer.x, pointer.y);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (this.pointers.size >= 2) {
      const [a, b] = this.pointers.values();
      if (!this.pinch) this.startPinch();
      const center = this.localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.zoomLevel = Math.min(
        4,
        Math.max(
          1,
          (this.pinch.zoom * Math.hypot(b.x - a.x, b.y - a.y)) /
            this.pinch.distance,
        ),
      );
      this.panX = center.x - this.pinch.boardX * this.zoomLevel;
      this.panY = center.y - this.pinch.boardY * this.zoomLevel;
      this.applyView();
      return;
    }
    const moved =
      Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) >= 8;
    if (moved) {
      this.dragging = true;
      this.gestureCancelled = true;
      this.clearHoldGuide();
    }
    if (this.dragging || this.gestureCancelled) {
      const now = this.localPoint(pointer.x, pointer.y);
      this.panX += now.x - old.x;
      this.panY += now.y - old.y;
      this.svg.style.cursor = "pointer";
      this.applyView();
    }
  }

  pointerEnd(event, cancelled) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    if (
      cancelled ||
      Math.hypot(
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
      ) >= 8
    )
      this.gestureCancelled = true;
    const shouldTap =
      !cancelled &&
      !this.gestureCancelled &&
      !this.dragging &&
      !this.holdGuide?.shown &&
      this.pointers.size === 1;
    this.clearHoldGuide();
    this.pointers.delete(event.pointerId);
    try {
      if (this.svg.hasPointerCapture(event.pointerId))
        this.svg.releasePointerCapture(event.pointerId);
    } catch {
      /* Already released by the browser. */
    }
    if (this.pointers.size >= 2) this.startPinch();
    else this.pinch = null;
    if (shouldTap) this.tapAt(event.clientX, event.clientY);
    if (!this.pointers.size) {
      this.svg.style.cursor = "pointer";
      this.dragging = false;
      // Cancellation is only reset by the beginning of a fresh gesture.
    }
  }

  tapAt(clientX, clientY) {
    const id = this.arrowAt(clientX, clientY);
    if (id != null) this.onTap(this.arrows.get(id).id);
  }

  arrowAt(clientX, clientY) {
    if (!this.board || this.destroyed) return null;
    const point = this.localPoint(clientX, clientY);
    const viewport = this.viewport || {
      x: 0,
      y: 0,
      width: this.board.width,
      height: this.board.height,
    };
    // A cell occupies [x,x+1) × [y,y+1), including the area off its line.
    // Check the visible viewport too: pointer capture can end just outside it.
    if (
      point.x < viewport.x ||
      point.x >= viewport.x + viewport.width ||
      point.y < viewport.y ||
      point.y >= viewport.y + viewport.height
    )
      return null;
    const x = Math.floor((point.x - this.panX) / this.zoomLevel);
    const y = Math.floor((point.y - this.panY) / this.zoomLevel);
    if (x < 0 || x >= this.board.width || y < 0 || y >= this.board.height)
      return null;
    const id = this.cellOwners.get(y * this.board.width + x);
    return this.remaining.has(id) && !this.ghosts.has(id) ? id : null;
  }

  zoom(factor) {
    if (!this.board || !Number.isFinite(factor) || factor <= 0) return;
    this.zoomAt(factor, { x: this.board.width / 2, y: this.board.height / 2 });
  }

  zoomAt(factor, center) {
    this.cancelGesture();
    const next = Math.min(4, Math.max(1, this.zoomLevel * factor));
    const ratio = next / this.zoomLevel;
    this.panX = center.x - (center.x - this.panX) * ratio;
    this.panY = center.y - (center.y - this.panY) * ratio;
    this.zoomLevel = next;
    this.applyView();
  }

  reset() {
    this.cancelGesture();
    this.zoomLevel = 1;
    this.panX = this.panY = 0;
    this.applyView();
  }

  setView(view) {
    if (!view || ![view.zoom, view.panX, view.panY].every(Number.isFinite))
      return;
    this.cancelGesture();
    this.zoomLevel = Math.min(4, Math.max(1, view.zoom));
    this.panX = view.panX;
    this.panY = view.panY;
    this.applyView();
  }

  updateViewport() {
    if (this.destroyed || !this.board) return false;
    const { width, height } = this.board;
    const rect = this.svg.getBoundingClientRect?.();
    const aspect =
      rect?.width > 0 && rect?.height > 0
        ? rect.width / rect.height
        : width / height;
    const visibleWidth = Math.max(width, height * aspect);
    const visibleHeight = Math.max(height, width / aspect);
    const next = {
      x: (width - visibleWidth) / 2,
      y: (height - visibleHeight) / 2,
      width: visibleWidth,
      height: visibleHeight,
    };
    if (
      this.viewport &&
      Object.keys(next).every((key) => this.viewport[key] === next[key])
    )
      return false;
    this.viewport = next;
    this.svg.setAttribute(
      "viewBox",
      `${next.x} ${next.y} ${next.width} ${next.height}`,
    );
    return true;
  }

  applyView() {
    if (!this.board) return;
    const viewport = this.viewport || {
      x: 0,
      y: 0,
      width: this.board.width,
      height: this.board.height,
    };
    const clamp = (pan, extent, start, visible) =>
      extent * this.zoomLevel <= visible
        ? (extent * (1 - this.zoomLevel)) / 2
        : Math.min(
            start,
            Math.max(start + visible - extent * this.zoomLevel, pan),
          );
    this.panX = clamp(this.panX, this.board.width, viewport.x, viewport.width);
    this.panY = clamp(
      this.panY,
      this.board.height,
      viewport.y,
      viewport.height,
    );
    this.scene.setAttribute(
      "transform",
      `translate(${this.panX} ${this.panY}) scale(${this.zoomLevel})`,
    );
    this.onViewChange({
      zoom: this.zoomLevel,
      panX: this.panX,
      panY: this.panY,
      canZoomIn: this.zoomLevel < 4,
      canZoomOut: this.zoomLevel > 1,
    });
  }

  cancelGesture() {
    this.gestureCancelled = true;
    this.clearHoldGuide();
    const ids = Array.from(this.pointers.keys());
    this.pointers.clear();
    for (const id of ids) {
      try {
        if (this.svg.hasPointerCapture(id)) this.svg.releasePointerCapture(id);
      } catch {
        /* Pointer has ended. */
      }
    }
    this.pinch = null;
    this.dragging = false;
    this.svg.style.cursor = "pointer";
  }

  stopFeedback() {
    for (const feedback of this.feedback.values())
      cancelAnimationFrame(feedback.frame);
    this.feedback.clear();
  }

  cancelAnimations() {
    this.stopFeedback();
    for (const animation of this.ghosts.values()) {
      cancelAnimationFrame(animation.frame);
      animation.group.remove();
      animation.resolve();
    }
    this.ghosts.clear();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.cancelGesture();
    this.cancelAnimations();
    for (const [target, type, handler, options] of this.listeners)
      target.removeEventListener(type, handler, options);
    this.listeners = [];
    this.svg.remove();
  }
}
