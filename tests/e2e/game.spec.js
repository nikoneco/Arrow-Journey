import { test, expect } from "@playwright/test";
import { getRemovable, canRemove, solveBoard } from "../../js/engine.js";
import { mkdir } from "node:fs/promises";
const evidence =
  "C:/Users/aqua_/.codex/visualizations/2026/10/20/01a15956-6698-7a93-94ae-729f1decee32";
async function readProfile(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("arrow-journey-local-v1");
        r.onsuccess = () => {
          const db = r.result;
          const q = db
            .transaction("profiles")
            .objectStore("profiles")
            .get("guest");
          q.onsuccess = () => {
            db.close();
            resolve(q.result);
          };
          q.onerror = reject;
        };
        r.onerror = reject;
      }),
  );
}
async function start(page, difficulty = "easy") {
  await page.locator(`[data-difficulty="${difficulty}"]`).click();
  await expect(page.locator("#board .board-arrow")).not.toHaveCount(0);
}
async function activate(page, id) {
  await page.locator(`#board [data-arrow-id="${id}"]`).press("Enter");
}
test("UI, blocked tap, drag exclusion, hint persistence and new-game replacement", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page).toHaveTitle("Arrow Journey");
  await expect(page.getByText("新しい問題", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("ほどけていく");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: evidence + "/arrow-home-desktop.png" });
  await start(page);
  let p = await readProfile(page),
    g = p.activeGame;
  expect(g.board.arrows.reduce((n, a) => n + a.cells.length, 0)).toBe(400);
  const blocked = g.remainingIds.find(
    (id) => !canRemove(g.board, g.remainingIds, id).allowed,
  );
  expect(blocked).toBeTruthy();
  // Use an actual body click rather than only keyboard activation.
  const arrow = g.board.arrows.find((a) => a.id === blocked),
    cell = arrow.cells[Math.floor(arrow.cells.length / 2)],
    r = await page.locator("#board svg").boundingBox();
  await page.mouse.click(
    r.x + ((cell[0] + 0.5) * r.width) / 20,
    r.y + ((cell[1] + 0.5) * r.height) / 20,
  );
  await expect(page.locator("#misses")).toHaveText("1");
  const before = (await readProfile(page)).activeGame.remainingIds.length;
  await page.mouse.move(r.x + 30, r.y + 30);
  await page.mouse.down();
  await page.mouse.move(r.x + 90, r.y + 65, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#misses")).toHaveText("1");
  expect((await readProfile(page)).activeGame.remainingIds.length).toBe(before);
  await page.getByRole("button", { name: "ヒント 残り 3 回" }).click();
  await expect(page.locator("#hint-left")).toHaveText("残り 2 回");
  await page.getByRole("button", { name: "ヒント 残り 2 回" }).click();
  await expect(page.locator("#hint-left")).toHaveText("残り 2 回");
  p = await readProfile(page);
  const hint = p.activeGame.hintId;
  await activate(page, hint);
  await expect(page.locator("#remaining")).toHaveText(String(before - 1));
  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await expect(page.getByRole("button", { name: /つづきから/ })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /つづきから/ }).click();
  await expect(page.locator("#misses")).toHaveText("1");
  await expect(page.locator("#hint-left")).toHaveText("残り 2 回");
  await page.getByRole("button", { name: "拡大", exact: true }).click();
  await page.getByRole("button", { name: "盤面を全体表示" }).click();
  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await start(page, "hard");
  p = await readProfile(page);
  expect(p.activeGame.board.width).toBe(28);
  expect(p.activeGame.playId).not.toBe(g.playId);
  expect(p.summaries[g.playId].misses).toBe(1);
  expect(errors).toEqual([]);
});
test("full clear is atomic, returns home and is counted once after reload", async ({
  page,
}) => {
  await page.goto("/");
  await start(page);
  const p = await readProfile(page),
    order = solveBoard(p.activeGame.board).order;
  for (const id of order) {
    await activate(page, id);
    await expect(page.locator(`#board [data-arrow-id="${id}"]`)).toHaveCount(0);
  }
  await expect(page.getByText("クリア", { exact: true })).toBeVisible();
  await expect(page.locator('[data-difficulty="easy"]')).toBeEnabled();
  let after = await readProfile(page);
  expect(after.activeGame).toBeNull();
  expect(Object.keys(after.clears)).toHaveLength(1);
  await page.reload();
  after = await readProfile(page);
  expect(Object.keys(after.clears)).toHaveLength(1);
  await page.getByRole("button", { name: "成績", exact: true }).click();
  await expect(page.locator(".stats-total strong")).toHaveText("1");
});

test("the next arrow can leave while another one is moving, including a newly unblocked arrow", async ({
  page,
}) => {
  await page.goto("/");
  await start(page);
  const first = (await readProfile(page)).activeGame;
  const removable = getRemovable(first.board, first.remainingIds);
  const id = removable.sort(
    (a, b) =>
      first.board.arrows.find((v) => v.id === b).cells.length -
      first.board.arrows.find((v) => v.id === a).cells.length,
  )[0];
  await activate(page, id);
  await expect(page.locator("#remaining")).toHaveText(
    String(first.remainingIds.length - 1),
  );
  await expect(page.locator(".arrow-ghosts > g")).toHaveCount(1);
  const after = (await readProfile(page)).activeGame;
  const candidates = getRemovable(after.board, after.remainingIds);
  const next = candidates.find((v) => !removable.includes(v)) || candidates[0];
  await activate(page, next);
  await expect(page.locator("#remaining")).toHaveText(
    String(first.remainingIds.length - 2),
  );
  await expect(page.locator(".arrow-ghosts > g")).toHaveCount(2);
  const saved = (await readProfile(page)).activeGame;
  expect(saved.remainingIds).not.toContain(id);
  expect(saved.remainingIds).not.toContain(next);
  expect(saved.misses).toBe(0);
  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await page.getByRole("button", { name: /つづきから/ }).click();
  await expect(page.locator("#remaining")).toHaveText(
    String(saved.remainingIds.length),
  );
});

test("four arrow colors update the current puzzle and persist after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 354, height: 780 });
  await page.goto("/");
  await start(page);
  const before = (await readProfile(page)).activeGame;
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const colors = [
    ["グリーン", "forest", "#293f37"],
    ["ブルー", "ocean", "#205879"],
    ["パープル", "grape", "#66517a"],
    ["テラコッタ", "ember", "#a04e35"],
  ];
  await expect(page.getByRole("radio")).toHaveCount(4);
  for (const [label, id, ink] of colors) {
    await page.getByRole("radio", { name: label, exact: true }).check();
    await expect
      .poll(async () => (await readProfile(page)).settings.arrowTheme.value)
      .toBe(id);
    await expect(page.locator(".board-arrow").first()).toHaveAttribute(
      "stroke",
      ink,
    );
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  const bodies = await page
    .locator(".board-arrow .arrow-body")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")));
  expect(bodies.some((body) => body.includes("Q"))).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /つづきから/ }).click();
  await expect(page.locator(".board-arrow").first()).toHaveAttribute(
    "stroke",
    "#a04e35",
  );
  const after = (await readProfile(page)).activeGame;
  expect(after.playId).toBe(before.playId);
  expect(after.remainingIds).toEqual(before.remainingIds);
});
test("mobile 390/354px fits; offline shell, worker generation and resume work", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.screenshot({ path: evidence + "/arrow-home-mobile.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await start(page, "expert");
  await expect(page.locator(".play-meta")).toContainText("32 × 32");
  await page.screenshot({ path: evidence + "/arrow-play-mobile.png" });
  await page.setViewportSize({ width: 354, height: 780 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "ヒント 残り 3 回" }).click();
  await expect(page.locator("#hint-left")).toHaveText("残り 2 回");
  await page.reload();
  await page.getByRole("button", { name: /つづきから/ }).click();
  await expect(page.locator("#hint-left")).toHaveText("残り 2 回");
  await context.setOffline(false);
});
test("an old tab cannot overwrite another tab new game", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await start(page);
  const second = await context.newPage();
  await second.goto("/");
  await second.getByRole("button", { name: /つづきから/ }).click();
  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await start(page, "normal");
  await expect(
    second.getByText("別のタブで保存内容が変わりました。", { exact: false }),
  ).toBeVisible();
  await second.getByRole("button", { name: "最新の状態を開く →" }).click();
  await second.getByRole("button", { name: /つづきから/ }).click();
  await expect(second.locator(".play-meta")).toContainText("Normal");
  await second.close();
});

test("Home works during escape and preserves the accepted removal", async ({
  page,
}) => {
  await page.goto("/");
  await start(page);
  const before = await readProfile(page),
    g = before.activeGame,
    id = getRemovable(g.board, g.remainingIds)[0];
  await activate(page, id);
  await expect(page.locator(`#board [data-arrow-id="${id}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await expect(page.getByRole("button", { name: /つづきから/ })).toBeVisible();
  await page.getByRole("button", { name: /つづきから/ }).click();
  await expect(page.locator("#remaining")).toHaveText(
    String(g.remainingIds.length - 1),
  );
  expect((await readProfile(page)).activeGame.remainingIds).not.toContain(id);
});

test("whole-cell corners respond to mouse and touch, including after zoom, while removed cells stay empty", async ({
  browser,
}) => {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: mobile
        ? { width: 354, height: 780 }
        : { width: 1440, height: 1000 },
      hasTouch: mobile,
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("/");
      await start(page);
      const g = (await readProfile(page)).activeGame;
      const blocked = g.board.arrows.find(
        (a) =>
          a.cells.length >= 3 &&
          !canRemove(g.board, g.remainingIds, a.id).allowed,
      );
      const rect = await page.locator("#board svg").boundingBox();
      const tap = async (
        cell,
        offset = [0.92, 0.92],
        zoom = 1,
        panX = 0,
        panY = 0,
      ) => {
        const x =
          rect.x + (((cell[0] + offset[0]) * zoom + panX) * rect.width) / 20;
        const y =
          rect.y + (((cell[1] + offset[1]) * zoom + panY) * rect.height) / 20;
        if (mobile) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
      };
      let misses = 0;
      // Tail, body and head: these corners are outside the old 0.3-cell line radius.
      for (const cell of [
        blocked.cells[0],
        blocked.cells[Math.floor(blocked.cells.length / 2)],
        blocked.cells.at(-1),
      ]) {
        for (const offset of [
          [0.08, 0.08],
          [0.92, 0.08],
          [0.08, 0.92],
          [0.92, 0.92],
        ]) {
          await tap(cell, offset);
          await expect(page.locator("#misses")).toHaveText(String(++misses));
        }
      }
      const id = getRemovable(g.board, g.remainingIds)[0];
      const free = g.board.arrows.find((a) => a.id === id).cells[0];
      await tap(free);
      await expect(page.locator("#remaining")).toHaveText(
        String(g.remainingIds.length - 1),
      );
      await tap(free);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const after = (await readProfile(page)).activeGame;
      expect(after.misses).toBe(misses);
      expect(after.remainingIds).toHaveLength(g.remainingIds.length - 1);
      await page.getByRole("button", { name: "拡大", exact: true }).click();
      const transform = await page
        .locator("#board svg > g")
        .getAttribute("transform");
      const [, panX, panY, zoom] = transform
        .match(/translate\(([-.\d]+) ([-.\d]+)\) scale\(([-.\d]+)\)/)
        .map(Number);
      const current = (await readProfile(page)).activeGame;
      const zoomedCell = current.board.arrows
        .filter(
          (a) =>
            current.remainingIds.includes(a.id) &&
            !canRemove(current.board, current.remainingIds, a.id).allowed,
        )
        .flatMap((a) => a.cells)
        .find(([x, y]) => x >= 5 && x <= 14 && y >= 5 && y <= 14);
      await tap(zoomedCell, [0.92, 0.92], zoom, panX, panY);
      await expect(page.locator("#misses")).toHaveText(String(++misses));
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
