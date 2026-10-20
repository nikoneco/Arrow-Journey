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
