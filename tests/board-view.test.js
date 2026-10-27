import test from "node:test";
import assert from "node:assert/strict";
import { BoardView } from "../js/board-view.js";

function fixture() {
  const rows = [
    ["tail", "tail", "other", "other"],
    ["tail", "tail", "other", "other"],
    ["7", "7", null, null],
  ];
  const taps = [];
  const view = Object.assign(Object.create(BoardView.prototype), {
    board: { width: 4, height: 3 },
    destroyed: false,
    panX: 0,
    panY: 0,
    zoomLevel: 1,
    localPoint: (x, y) => ({ x, y }),
    cellOwners: new Map(),
    arrows: new Map([
      ["tail", { id: "tail" }],
      ["other", { id: "other" }],
      ["7", { id: 7 }],
    ]),
    remaining: new Set(["tail", "other", "7"]),
    ghosts: new Map(),
    onTap: (id) => taps.push(id),
  });
  rows.forEach((row, y) =>
    row.forEach((id, x) => {
      if (id !== null) view.cellOwners.set(y * 4 + x, id);
    }),
  );
  return { view, taps, rows };
}

test("every occupied square accepts its center and all four corners, including line-free areas", () => {
  const { view, taps, rows } = fixture();
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 4; x++) {
      const id = rows[y][x];
      for (const [dx, dy] of [
        [0.01, 0.01],
        [0.99, 0.01],
        [0.01, 0.99],
        [0.99, 0.99],
        [0.5, 0.5],
      ]) {
        taps.length = 0;
        view.tapAt(x + dx, y + dy);
        assert.deepEqual(
          taps,
          id === null ? [] : [id === "7" ? 7 : id],
          `square ${x},${y} at ${dx},${dy}`,
        );
      }
    }
});

test("shared edges select one owning square; empty, removed, escaping and out-of-board squares do nothing", () => {
  const { view, taps } = fixture();
  for (const [x, y, expected] of [
    [1.999, 1, "tail"],
    [2, 1, "other"],
    [2.001, 1, "other"],
    [0.5, 2, 7],
  ]) {
    taps.length = 0;
    view.tapAt(x, y);
    assert.deepEqual(taps, [expected]);
  }
  view.remaining.delete("tail");
  view.ghosts.set("other", {});
  for (const [x, y] of [
    [0.99, 0.99],
    [2.01, 0.99],
    [3.5, 2.5],
    [-0.001, 1],
    [4, 1],
    [1, -0.001],
    [1, 3],
  ]) {
    taps.length = 0;
    view.tapAt(x, y);
    assert.deepEqual(taps, []);
  }
});

test("zoom and pan preserve square ownership and pointer capture cannot select outside the visible viewport", () => {
  const { view, taps } = fixture();
  view.zoomLevel = 2;
  view.panX = -1;
  view.panY = -1;
  view.tapAt(2.98, 1.98);
  assert.deepEqual(taps, ["tail"]);
  taps.length = 0;
  view.tapAt(3, 1.98);
  assert.deepEqual(taps, ["other"]);
  // Inverse-transforming these points alone would land on an occupied square.
  for (const [x, y] of [
    [-0.01, 1],
    [4, 1],
    [1, -0.01],
    [1, 3],
  ]) {
    taps.length = 0;
    view.tapAt(x, y);
    assert.deepEqual(taps, []);
  }
  view.destroyed = true;
  view.tapAt(1, 1);
  assert.deepEqual(taps, []);
});

test("a tall viewport accepts zoomed cells above and below the original square, but rejects captured pointers outside the frame", () => {
  const { view, taps } = fixture();
  view.viewport = { x: 0, y: -2.5, width: 4, height: 8 };
  view.zoomLevel = 2;
  view.panX = -1;
  view.panY = -1.5;
  view.tapAt(0.5, -0.5);
  view.tapAt(0.5, 3.5);
  assert.deepEqual(taps, ["tail", 7]);
  taps.length = 0;
  view.zoomLevel = 4;
  view.panY = -5.5;
  view.tapAt(0.5, -2.501);
  view.tapAt(0.5, 5.5);
  assert.deepEqual(taps, []);
});

test("viewport geometry keeps cells square and fallback input accounts for the extended vertical area", () => {
  const { view } = fixture();
  const attributes = new Map();
  view.svg = {
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 200,
      height: 400,
    }),
    getScreenCTM: () => null,
    setAttribute: (key, value) => attributes.set(key, value),
  };
  assert.equal(view.updateViewport(), true);
  assert.deepEqual(view.viewport, { x: 0, y: -2.5, width: 4, height: 8 });
  assert.equal(attributes.get("viewBox"), "0 -2.5 4 8");
  assert.equal(view.updateViewport(), false);
  assert.deepEqual(BoardView.prototype.localPoint.call(view, 110, 220), {
    x: 2,
    y: 1.5,
  });
  assert.deepEqual(BoardView.prototype.localPoint.call(view, 110, 45), {
    x: 2,
    y: -2,
  });
});

test("pan centers a zoomed board that fits vertically and clamps both edges when it exceeds the taller viewport", () => {
  const { view } = fixture();
  view.viewport = { x: 0, y: -2.5, width: 4, height: 8 };
  view.scene = { setAttribute() {} };
  view.onViewChange = () => {};
  view.zoomLevel = 2;
  view.panX = 100;
  view.panY = -100;
  view.applyView();
  assert.equal(view.panX, 0);
  assert.equal(view.panY, -1.5);
  view.zoomLevel = 4;
  view.panY = -100;
  view.applyView();
  assert.equal(view.panY, -6.5);
  view.panY = 100;
  view.applyView();
  assert.equal(view.panY, -2.5);
});
