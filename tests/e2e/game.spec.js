import { test, expect } from "@playwright/test";
import { getRemovable, canRemove, solveBoard } from "../../js/engine.js";
import { trackForBoard, musicEvents } from "../../js/music.js";
import { mkdir } from "node:fs/promises";
const evidence =
  "C:/Users/aqua_/Documents/Codex/2026-10-27/Arrow-Journey-balance";
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

test("six selectable shapes fill only playable cells and retain shape, dots and geometry on resume", async ({
  page,
}) => {
  await page.setViewportSize({ width: 354, height: 780 });
  await page.goto("/");
  await mkdir(evidence, { recursive: true });
  await expect(
    page.getByRole("combobox", { name: "形", exact: true }),
  ).toHaveValue("random");
  for (const [shape, label] of [
    ["square", "正方形"],
    ["circle", "円"],
    ["diamond", "ひし形"],
    ["cross", "十字"],
    ["heart", "ハート"],
    ["ring", "ドーナツ"],
  ]) {
    await page
      .getByRole("combobox", { name: "形", exact: true })
      .selectOption(shape);
    await start(page, "normal");
    const game = (await readProfile(page)).activeGame;
    expect(game.board.shape).toBe(shape);
    await expect(page.locator(".play-meta")).toContainText(label);
    const mask = new Set(game.board.mask.map(([x, y]) => `${x},${y}`));
    const occupied = game.board.arrows
      .flatMap((arrow) => arrow.cells)
      .map(([x, y]) => `${x},${y}`);
    expect(new Set(occupied)).toEqual(mask);
    expect(occupied).toHaveLength(mask.size);
    await expect(page.locator(".board-shape-fill")).toHaveCount(
      shape === "square" ? 0 : 1,
    );
    if (shape !== "square") {
      expect(mask.size).toBeLessThan(game.board.width * game.board.height);
      const voidCell = Array.from(
        { length: game.board.width * game.board.height },
        (_, i) => [i % game.board.width, Math.floor(i / game.board.width)],
      ).find(([x, y]) => !mask.has(`${x},${y}`));
      const rect = await page.locator("#board svg").boundingBox();
      await page.mouse.click(
        rect.x + ((voidCell[0] + 0.5) * rect.width) / game.board.width,
        rect.y + ((voidCell[1] + 0.5) * rect.height) / game.board.height,
      );
      await expect(page.locator("#misses")).toHaveText("0");
      await expect(page.locator("#remaining")).toHaveText(
        String(game.remainingIds.length),
      );
    }
    await page.screenshot({ path: evidence + `/shape-${shape}-mobile.png` });
    const id = getRemovable(game.board, game.remainingIds)[0];
    const cells = game.board.arrows.find((arrow) => arrow.id === id).cells;
    await activate(page, id);
    await expect(page.locator(".board-empty-dot")).toHaveCount(cells.length);
    await page.getByRole("button", { name: "ホーム", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: /つづきから/ }).click();
    const resumed = (await readProfile(page)).activeGame;
    expect(resumed.board).toEqual(game.board);
    expect(resumed.playId).toBe(game.playId);
    expect(resumed.remainingIds).not.toContain(id);
    await expect(page.locator(".board-empty-dot")).toHaveCount(cells.length);
    const dots = await page
      .locator(".board-empty-dot")
      .evaluateAll((nodes) =>
        nodes.map(
          (node) =>
            `${Number(node.getAttribute("cx")) - 0.5},${Number(node.getAttribute("cy")) - 0.5}`,
        ),
      );
    expect(dots.every((cell) => mask.has(cell))).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (shape === "heart") {
      await page.getByRole("button", { name: "設定", exact: true }).click();
      await page.getByLabel("表示", { exact: true }).selectOption("dark");
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        "dark",
      );
      await page.getByRole("button", { name: "閉じる", exact: true }).click();
      await page.screenshot({
        path: evidence + "/shape-heart-dark-mobile.png",
      });
    }
    await page.getByRole("button", { name: "ホーム", exact: true }).click();
  }
});

test("real AudioContext schedules the board-selected score and the same score after resume", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.qaNotes = [];
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (...args) {
      const oscillator = create.apply(this, args);
      const start = oscillator.start;
      oscillator.start = function (...times) {
        window.qaNotes.push({
          frequency: this.frequency.value,
          type: this.type,
          at: times[0],
        });
        return start.apply(this, times);
      };
      return oscillator;
    };
  });
  await page.goto("/");
  await start(page);
  let game = (await readProfile(page)).activeGame;
  const expectScore = async (playId) => {
    const expected = musicEvents(trackForBoard(playId), 0);
    await expect
      .poll(() => page.evaluate(() => window.qaNotes.length))
      .toBeGreaterThanOrEqual(expected.length);
    const actual = await page.evaluate(
      (n) => window.qaNotes.slice(-n),
      expected.length,
    );
    for (let index = 0; index < expected.length; index++) {
      expect(actual[index].frequency).toBeCloseTo(
        440 * 2 ** ((expected[index].midi - 69) / 12),
        2,
      );
      expect(actual[index].type).toBe(expected[index].type);
    }
  };
  await expectScore(game.playId);
  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await start(page, "hard");
  game = (await readProfile(page)).activeGame;
  await page.reload();
  await page.getByRole("button", { name: /つづきから/ }).click();
  expect((await readProfile(page)).activeGame.playId).toBe(game.playId);
  await expectScore(game.playId);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.locator("#bgm-enabled").uncheck();
  await expect
    .poll(async () => (await readProfile(page)).settings.bgmEnabled.value)
    .toBe(false);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.evaluate(() => {
    window.qaNotes = [];
  });
  const current = (await readProfile(page)).activeGame;
  await activate(page, getRemovable(current.board, current.remainingIds)[0]);
  await expect.poll(() => page.evaluate(() => window.qaNotes.length)).toBe(1);
  const effect = await page.evaluate(() => window.qaNotes[0]);
  const chordFrequencies = trackForBoard(current.playId)
    .chords.flat()
    .map((midi) => 440 * 2 ** ((midi + 12 - 69) / 12));
  expect(
    chordFrequencies.some(
      (frequency) => Math.abs(frequency - effect.frequency) < 0.01,
    ),
  ).toBe(true);
});

test("mistakes are optional in play and completion, persist, and no-miss statistics are absent", async ({
  page,
}) => {
  await page.goto("/");
  await start(page);
  const game = (await readProfile(page)).activeGame;
  await expect(page.locator("#misses")).toBeHidden();
  const blocked = game.remainingIds.find(
    (id) => !canRemove(game.board, game.remainingIds, id).allowed,
  );
  await activate(page, blocked);
  await expect(page.locator("#misses")).toHaveText("1");
  await expect(page.locator("#misses")).toBeHidden();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.locator("#show-mistakes").check();
  await expect(page.locator("#misses")).toBeVisible();
  await expect
    .poll(async () => (await readProfile(page)).settings.showMistakes.value)
    .toBe(true);
  await page.screenshot({ path: evidence + "/mistakes-setting.png" });
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: /つづきから/ }).click();
  await expect(page.locator("#misses")).toBeVisible();
  await expect(page.locator("#misses")).toHaveText("1");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.locator("#show-mistakes").uncheck();
  await expect(page.locator("#misses")).toBeHidden();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  for (const id of solveBoard(game.board).order) {
    await activate(page, id);
    await expect(page.locator(`#board [data-arrow-id="${id}"]`)).toHaveCount(0);
  }
  await expect(page.locator(".completion")).toBeVisible();
  expect(await page.locator(".completion").innerText()).not.toContain("ミス");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.locator("#show-mistakes").check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  expect(await page.locator(".completion").innerText()).toContain("ミス 1");
  await page.getByRole("button", { name: "成績", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toContainText(/ノーミス|累計ミス/);
  expect(Object.values((await readProfile(page)).clears)[0].misses).toBe(1);
});

test("trusted mouse and touch holds show neutral guides across a ring hole, never remove, and leave quick taps and drag usable", async ({
  browser,
}) => {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: mobile
        ? { width: 354, height: 780 }
        : { width: 1440, height: 1000 },
      hasTouch: mobile,
      isMobile: mobile,
    });
    try {
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/");
      await page
        .getByRole("combobox", { name: "形", exact: true })
        .selectOption("ring");
      await start(page, "normal");
      const game = (await readProfile(page)).activeGame;
      const mask = new Set(game.board.mask.map(([x, y]) => `${x},${y}`));
      const target = game.board.arrows.find((arrow) => {
        const [hx, hy] = arrow.cells.at(-1),
          [px, py] = arrow.cells.at(-2),
          dx = hx - px,
          dy = hy - py;
        for (
          let x = hx + dx, y = hy + dy;
          x >= 0 && x < game.board.width && y >= 0 && y < game.board.height;
          x += dx, y += dy
        ) {
          if (
            !mask.has(`${x},${y}`) &&
            Math.hypot(
              x + 0.5 - game.board.width / 2,
              y + 0.5 - game.board.height / 2,
            ) <
              game.board.width * 0.2
          )
            return true;
        }
        return false;
      });
      expect(target).toBeTruthy();
      const rect = await page.locator("#board svg").boundingBox();
      const point = ([x, y]) => ({
        x: rect.x + ((x + 0.85) * rect.width) / game.board.width,
        y: rect.y + ((y + 0.85) * rect.height) / game.board.height,
      });
      const cdp = mobile ? await context.newCDPSession(page) : null;
      const down = async (point) =>
        mobile
          ? cdp.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ ...point, id: 31 }],
            })
          : (await page.mouse.move(point.x, point.y), page.mouse.down());
      const up = async () =>
        mobile
          ? cdp.send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            })
          : page.mouse.up();
      const tap = async (point) =>
        mobile
          ? page.touchscreen.tap(point.x, point.y)
          : page.mouse.click(point.x, point.y);
      await down(point(target.cells[0]));
      await expect(page.locator(".board-ray-guide")).toHaveCount(1);
      expect(
        await page
          .locator(".board-ray-guide")
          .evaluate((line) =>
            Math.max(line.getBBox().width, line.getBBox().height),
          ),
      ).toBeGreaterThan(0);
      const head = target.cells.at(-1),
        previous = target.cells.at(-2);
      await expect(page.locator(".board-ray-guide")).toHaveAttribute(
        "x1",
        String(head[0] + 0.5),
      );
      await expect(page.locator(".board-ray-guide")).toHaveAttribute(
        "y1",
        String(head[1] + 0.5),
      );
      await expect(page.locator(".board-ray-guide")).toHaveAttribute(
        "x2",
        String(
          head[0] > previous[0]
            ? game.board.width
            : head[0] < previous[0]
              ? 0
              : head[0] + 0.5,
        ),
      );
      await expect(page.locator(".board-ray-guide")).toHaveAttribute(
        "y2",
        String(
          head[1] > previous[1]
            ? game.board.height
            : head[1] < previous[1]
              ? 0
              : head[1] + 0.5,
        ),
      );
      await page.screenshot({
        path: evidence + `/ring-hold-${mobile ? "touch" : "mouse"}.png`,
      });
      await up();
      await expect(page.locator(".board-ray-guide")).toHaveCount(0);
      expect((await readProfile(page)).activeGame.remainingIds).toEqual(
        game.remainingIds,
      );
      expect((await readProfile(page)).activeGame.misses).toBe(0);
      const free = getRemovable(game.board, game.remainingIds)[0];
      await tap(
        point(game.board.arrows.find((arrow) => arrow.id === free).cells[0]),
      );
      await expect(page.locator("#remaining")).toHaveText(
        String(game.remainingIds.length - 1),
      );
      const dragArrow = game.board.arrows.find((arrow) => arrow.id !== free),
        from = point(dragArrow.cells[0]),
        to = { x: from.x + 20, y: from.y + 15 };
      await down(from);
      if (mobile)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ ...to, id: 31 }],
        });
      else await page.mouse.move(to.x, to.y, { steps: 3 });
      await page.waitForTimeout(500); // Pass the real hold threshold after cancelling by drag.
      await expect(page.locator(".board-ray-guide")).toHaveCount(0);
      await up();
      expect((await readProfile(page)).activeGame.remainingIds).toHaveLength(
        game.remainingIds.length - 1,
      );
      expect((await readProfile(page)).activeGame.misses).toBe(0);
      await page.getByRole("button", { name: "盤面を全体表示" }).click();
      const hole = point([
        Math.floor(game.board.width / 2),
        Math.floor(game.board.height / 2),
      ]);
      expect(
        mask.has(
          `${Math.floor(game.board.width / 2)},${Math.floor(game.board.height / 2)}`,
        ),
      ).toBe(false);
      await down(hole);
      await page.waitForTimeout(500);
      await expect(page.locator(".board-ray-guide")).toHaveCount(0);
      await up();
      expect((await readProfile(page)).activeGame.misses).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
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
  expect(g.board.arrows.reduce((n, a) => n + a.cells.length, 0)).toBe(
    g.board.mask?.length ?? g.board.width * g.board.height,
  );
  const blocked = g.remainingIds.find(
    (id) => !canRemove(g.board, g.remainingIds, id).allowed,
  );
  expect(blocked).toBeTruthy();
  // Use an actual body click rather than only keyboard activation.
  const arrow = g.board.arrows.find((a) => a.id === blocked),
    cell = arrow.cells[Math.floor(arrow.cells.length / 2)],
    r = await page.locator("#board svg").boundingBox();
  await page.mouse.click(
    r.x + ((cell[0] + 0.5) * r.width) / g.board.width,
    r.y + ((cell[1] + 0.5) * r.height) / g.board.height,
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
  expect([28, 32, 36, 40]).toContain(p.activeGame.board.width);
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
  await expect(page.getByRole("dialog")).not.toContainText("累計ミス");
  await expect(page.getByRole("dialog")).not.toContainText("ノーミス率");
  await expect(page.locator(".stats-list")).toContainText("Easy");
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

test("dark appearance and all four colors persist; system mode follows the device", async ({
  page,
}) => {
  await page.setViewportSize({ width: 354, height: 780 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-mode",
    "light",
  );
  await start(page);
  const before = (await readProfile(page)).activeGame;
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const mode = page.getByLabel("表示", { exact: true });
  await expect(mode.locator("option")).toHaveCount(3);
  await mode.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  expect(
    await page
      .locator("html")
      .evaluate((el) => getComputedStyle(el).colorScheme),
  ).toBe("dark");
  for (const [label, ink] of [
    ["グリーン", "#a0cdb1"],
    ["ブルー", "#8fc2e2"],
    ["パープル", "#c5addf"],
    ["テラコッタ", "#e6ac91"],
  ]) {
    await page.getByRole("radio", { name: label, exact: true }).check();
    await expect(page.locator(".board-arrow").first()).toHaveAttribute(
      "stroke",
      ink,
    );
  }
  await expect
    .poll(async () => (await readProfile(page)).settings.colorMode.value)
    .toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: evidence + "/arrow-dark-settings.png" });
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.screenshot({ path: evidence + "/arrow-dark-board.png" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page.getByRole("button", { name: /つづきから/ }).click();
  await expect(page.locator(".board-arrow").first()).toHaveAttribute(
    "stroke",
    "#e6ac91",
  );
  expect((await readProfile(page)).activeGame.playId).toBe(before.playId);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await mode.selectOption("system");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-mode",
    "light",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await expect(page.locator(".board-arrow").first()).toHaveAttribute(
    "stroke",
    "#e6ac91",
  );
  await mode.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-mode",
    "light",
  );
  await expect(page.locator(".board-arrow").first()).toHaveAttribute(
    "stroke",
    "#a04e35",
  );
});

test("the desktop cursor stays a pointer across arrow lines, cell corners and dragging", async ({
  page,
}) => {
  await page.goto("/");
  await start(page);
  const game = (await readProfile(page)).activeGame;
  const cell = game.board.arrows.find((a) => a.cells.length > 3).cells[1];
  const svg = page.locator("#board svg"),
    rect = await svg.boundingBox();
  for (const [dx, dy] of [
    [0.5, 0.5],
    [0.08, 0.08],
    [0.92, 0.92],
  ]) {
    const x = rect.x + ((cell[0] + dx) * rect.width) / game.board.width;
    const y = rect.y + ((cell[1] + dy) * rect.height) / game.board.height;
    await page.mouse.move(x, y);
    expect(
      await page.evaluate(
        ({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor,
        { x, y },
      ),
    ).toBe("pointer");
  }
  await page.mouse.move(rect.x + 50, rect.y + 50);
  await page.mouse.down();
  await page.mouse.move(rect.x + 90, rect.y + 80, { steps: 4 });
  await expect(svg).toHaveCSS("cursor", "pointer");
  await page.mouse.up();
  await expect(svg).toHaveCSS("cursor", "pointer");
  await page.getByRole("button", { name: "盤面を全体表示" }).click();
  await expect(svg).toHaveCSS("cursor", "pointer");
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
  const offlineGame = (await readProfile(page)).activeGame;
  expect([28, 32, 36, 40]).toContain(offlineGame.board.width);
  await expect(page.locator(".play-meta")).toContainText(
    `${offlineGame.board.width} × ${offlineGame.board.height}`,
  );
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
          rect.x +
          (((cell[0] + offset[0]) * zoom + panX) * rect.width) / g.board.width;
        const y =
          rect.y +
          (((cell[1] + offset[1]) * zoom + panY) * rect.height) /
            g.board.height;
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

test("removed cells keep centered guide dots through resume, zoom and dark appearance", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await start(page, "hard");
  const game = (await readProfile(page)).activeGame;
  await expect(page.locator(".board-empty-dot")).toHaveCount(0);
  const removed = solveBoard(game.board).order.slice(0, 10);
  let count = 0;
  for (const id of removed) {
    count += game.board.arrows.find((a) => a.id === id).cells.length;
    await activate(page, id);
    await expect(page.locator(".board-empty-dot")).toHaveCount(count);
  }
  const coordinates = await page
    .locator(".board-empty-dot")
    .evaluateAll((nodes) =>
      nodes.map((n) => [
        Number(n.getAttribute("cx")),
        Number(n.getAttribute("cy")),
      ]),
    );
  const expected = game.board.arrows
    .filter((a) => removed.includes(a.id))
    .flatMap((a) => a.cells.map(([x, y]) => [x + 0.5, y + 0.5]));
  const sort = (items) => items.map((v) => v.join(",")).sort();
  expect(sort(coordinates)).toEqual(sort(expected));
  await expect(page.locator(".board-empty-dots")).toHaveAttribute(
    "pointer-events",
    "none",
  );
  await page.getByRole("button", { name: "拡大", exact: true }).click();
  await expect(page.locator(".board-empty-dot")).toHaveCount(count);
  await page.getByRole("button", { name: "盤面を全体表示" }).click();
  await expect(page.locator(".arrow-ghosts > g")).toHaveCount(0);
  await page.screenshot({ path: evidence + "/arrow-guide-dots.png" });
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const lightFill = await page
    .locator(".board-empty-dots")
    .getAttribute("fill");
  await page.getByLabel("表示", { exact: true }).selectOption("dark");
  await expect(page.locator(".board-empty-dots")).not.toHaveAttribute(
    "fill",
    lightFill,
  );
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.screenshot({ path: evidence + "/arrow-guide-dots-dark.png" });
  await page.reload();
  await page.getByRole("button", { name: /つづきから/ }).click();
  await expect(page.locator(".board-empty-dot")).toHaveCount(count);
  expect((await readProfile(page)).activeGame.remainingIds.length).toBe(
    game.remainingIds.length - removed.length,
  );
  await expect(page.locator("#misses")).toHaveText("0");
});

test("taps received while a view save is blocked are processed after that save", async ({
  page,
}) => {
  await page.goto("/");
  await start(page);
  const game = (await readProfile(page)).activeGame;
  const ids = getRemovable(game.board, game.remainingIds).slice(0, 2);
  expect(ids).toHaveLength(2);
  // Hold a real IDB transaction so the production view-save stays in flight.
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("arrow-journey-local-v1");
        request.onerror = reject;
        request.onsuccess = () => {
          const db = request.result,
            original = IDBDatabase.prototype.transaction;
          const transaction = original.call(db, "profiles", "readwrite");
          let holding = true;
          window.qaViewWriteStarted = false;
          IDBDatabase.prototype.transaction = function (
            stores,
            mode,
            ...options
          ) {
            if (mode === "readwrite") window.qaViewWriteStarted = true;
            return original.call(this, stores, mode, ...options);
          };
          window.qaReleaseLock = () => {
            holding = false;
            IDBDatabase.prototype.transaction = original;
          };
          const keepAlive = () => {
            transaction.objectStore("profiles").get("guest").onsuccess = () => {
              if (holding) keepAlive();
            };
          };
          transaction.oncomplete = () => db.close();
          keepAlive();
          resolve();
        };
      }),
  );
  try {
    await page.getByRole("button", { name: "拡大", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.qaViewWriteStarted))
      .toBe(true);
    await activate(page, ids[0]);
    await activate(page, ids[1]);
    await expect(page.locator("#remaining")).toHaveText(
      String(game.remainingIds.length),
    );
  } finally {
    await page.evaluate(() => window.qaReleaseLock());
  }
  await expect(page.locator("#remaining")).toHaveText(
    String(game.remainingIds.length - 2),
  );
  const saved = (await readProfile(page)).activeGame;
  expect(saved.remainingIds).not.toContain(ids[0]);
  expect(saved.remainingIds).not.toContain(ids[1]);
  expect(saved.misses).toBe(0);
});

test("rapid nearby touch taps suppress browser zoom while board pinch and controls still work", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await start(page);
    const game = (await readProfile(page)).activeGame;
    const svg = page.locator("#board svg"),
      rect = await svg.boundingBox();
    const scene = page.locator("#board svg > g");
    const transform = await scene.getAttribute("transform");
    const scale = await page.evaluate(() => visualViewport.scale);
    const point = ([x, y]) => ({
      x: rect.x + ((x + 0.5) * rect.width) / game.board.width,
      y: rect.y + ((y + 0.5) * rect.height) / game.board.height,
    });
    const free = game.board.arrows.filter((a) =>
      getRemovable(game.board, game.remainingIds).includes(a.id),
    );
    let nearest;
    for (let i = 0; i < free.length; i++)
      for (let j = i + 1; j < free.length; j++) {
        for (const a of free[i].cells)
          for (const b of free[j].cells) {
            const first = point(a),
              second = point(b),
              distance = Math.hypot(first.x - second.x, first.y - second.y);
            if (!nearest || distance < nearest.distance)
              nearest = {
                first,
                second,
                distance,
                ids: [free[i].id, free[j].id],
              };
          }
      }
    expect(nearest.distance).toBeLessThan(40);
    await page.evaluate(() => {
      window.qaTouchStarts = [];
      window.qaTouchTimes = [];
      document.addEventListener(
        "touchstart",
        (event) => {
          window.qaTouchTimes.push(event.timeStamp);
          window.qaTouchStarts.push({
            prevented: event.defaultPrevented,
            board: Boolean(event.target.closest?.("#board")),
            trusted: event.isTrusted,
          });
        },
        { passive: true },
      );
    });
    await page.touchscreen.tap(nearest.first.x, nearest.first.y);
    await page.touchscreen.tap(nearest.second.x, nearest.second.y);
    await expect(page.locator("#remaining")).toHaveText(
      String(game.remainingIds.length - 2),
    );
    const saved = (await readProfile(page)).activeGame;
    expect(nearest.ids.every((id) => !saved.remainingIds.includes(id))).toBe(
      true,
    );
    await expect(scene).toHaveAttribute("transform", transform);
    expect(await page.evaluate(() => visualViewport.scale)).toBe(scale);
    const times = await page.evaluate(() => window.qaTouchTimes);
    expect(times[1] - times[0]).toBeLessThan(300);
    expect(await page.evaluate(() => window.qaTouchStarts)).toEqual([
      { prevented: true, board: true, trusted: true },
      { prevented: true, board: true, trusted: true },
    ]);
    await expect(page.locator("html")).toHaveCSS(
      "touch-action",
      "manipulation",
    );
    await expect(page.locator(".game-frame")).toHaveCSS("touch-action", "none");
    await expect(page.locator("#board")).toHaveCSS("touch-action", "none");
    const defaults = await page.evaluate(() => {
      const board = document.querySelector("#board svg"),
        control = document.querySelector('[data-action="zoomIn"]');
      const dbl = new MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
      });
      board.dispatchEvent(dbl);
      const touch = new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
      });
      control.dispatchEvent(touch);
      return {
        doubleClickPrevented: dbl.defaultPrevented,
        controlTouchPrevented: touch.defaultPrevented,
        viewport: document.querySelector('meta[name="viewport"]').content,
      };
    });
    expect(defaults.doubleClickPrevented).toBe(true);
    expect(defaults.controlTouchPrevented).toBe(false);
    expect(defaults.viewport).not.toMatch(/user-scalable|maximum-scale/);
    const cdp = await context.newCDPSession(page);
    const cx = rect.x + rect.width / 2,
      cy = rect.y + rect.height / 2;
    const fingers = (offset) => [
      { x: cx - offset, y: cy, id: 11 },
      { x: cx + offset, y: cy, id: 12 },
    ];
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: fingers(30),
    });
    for (const offset of [38, 46, 54, 60])
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: fingers(offset),
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(scene).toHaveAttribute("transform", /scale\(2\)/);
    expect(await page.evaluate(() => visualViewport.scale)).toBe(scale);
    await expect(page.locator("#remaining")).toHaveText(
      String(game.remainingIds.length - 2),
    );
    const pinched = await scene.getAttribute("transform");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: cy, id: 13 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: cx + 25, y: cy + 25, id: 13 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(scene).not.toHaveAttribute("transform", pinched);
    await expect(page.locator("#misses")).toHaveText("0");
    await page.getByRole("button", { name: "盤面を全体表示" }).tap();
    await expect(scene).toHaveAttribute("transform", transform);
    await page.getByRole("button", { name: "拡大", exact: true }).tap();
    await expect(scene).toHaveAttribute("transform", /scale\(1\.3\)/);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: evidence + "/rapid-touch-and-pinch.png" });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
