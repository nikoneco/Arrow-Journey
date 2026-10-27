import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { boardCoordinates } from "./board-coordinates.js";
import {
  DIFFICULTIES,
  GENERATOR_VERSION,
  generateBoard,
  getRemovable,
  solveBoard,
} from "../../js/engine.js";

const evidence =
  "C:/Users/aqua_/Documents/Codex/2026-10-27/Arrow-Journey-balance";
const largestSize = DIFFICULTIES.expert.sizes.at(-1);
// Exercise a real Worker and the ordinary seed-based size selection, without a size override.
let largestSeed;
for (let index = 0; index < 100; index += 1) {
  const seed = `large-browser-${index}`;
  if (
    generateBoard("expert", seed, { shape: "square" }).width === largestSize
  ) {
    largestSeed = seed;
    break;
  }
}

async function readGame(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("arrow-journey-local-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db
            .transaction("profiles")
            .objectStore("profiles")
            .get("guest");
          get.onsuccess = () => {
            db.close();
            resolve(get.result.activeGame);
          };
          get.onerror = () => {
            db.close();
            reject(get.error);
          };
        };
      }),
  );
}

for (const [label, shape, viewport, touch] of [
  ["desktop", "square", { width: 1440, height: 1000 }, false],
  ["mobile", "ring", { width: 354, height: 780 }, true],
]) {
  test(`largest Expert ${label}: real generation, cell input, zoom and unchanged resume`, async ({
    browser,
  }) => {
    expect(largestSize).toBeGreaterThan(32);
    expect(largestSeed).toBeTruthy();
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport,
      hasTouch: touch,
      isMobile: touch,
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((seed) => {
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, ...rest) {
          return post.call(
            this,
            message?.difficulty ? { ...message, seed } : message,
            ...rest,
          );
        };
      }, largestSeed);
      await page.goto("./");
      await expect(page).toHaveTitle("Arrow Journey");
      await expect(
        page.locator('[data-difficulty="expert"] small'),
      ).toContainText(`${largestSize} × ${largestSize}`);
      await page
        .getByRole("combobox", { name: "形", exact: true })
        .selectOption(shape);
      await page.locator('[data-difficulty="expert"]').click();
      await expect(page.locator("#board .board-arrow")).not.toHaveCount(0);
      const game = await readGame(page);
      expect(game.board.width).toBe(largestSize);
      expect(game.board.height).toBe(largestSize);
      expect(game.board.shape).toBe(shape);
      expect(game.board.generatorVersion).toBe(GENERATOR_VERSION);
      expect(solveBoard(game.board).solvable).toBe(true);
      const visible = await page
        .locator("#board svg")
        .evaluate((svg) => ({
          width: svg.viewBox.baseVal.width,
          height: svg.viewBox.baseVal.height,
        }));
      expect(visible.width).toBeGreaterThanOrEqual(largestSize);
      expect(visible.height).toBeGreaterThanOrEqual(largestSize);
      await expect(page.locator("#remaining")).toHaveText(
        String(game.board.arrows.length),
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/expert-${label}.png` });

      const id = getRemovable(game.board, game.remainingIds)[0];
      const cell = game.board.arrows.find((arrow) => arrow.id === id).cells[0];
      const point = (await boardCoordinates(page))(cell);
      if (touch) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      await expect(page.locator("#remaining")).toHaveText(
        String(game.remainingIds.length - 1),
      );
      await expect(page.locator("#misses")).toHaveText("0");
      await page.getByRole("button", { name: "拡大", exact: true }).click();
      await expect(page.locator("#board svg > g")).toHaveAttribute(
        "transform",
        /scale\(1\.3\)/,
      );
      await page
        .getByRole("button", { name: "盤面を全体表示", exact: true })
        .click();
      await expect(page.locator("#board svg > g")).toHaveAttribute(
        "transform",
        /scale\(1\)/,
      );
      await page.getByRole("button", { name: "ホーム", exact: true }).click();
      await page.reload();
      await page.getByRole("button", { name: /つづきから/ }).click();
      const resumed = await readGame(page);
      expect(resumed.playId).toBe(game.playId);
      expect(resumed.board).toEqual(game.board);
      expect(resumed.remainingIds).toEqual(
        game.remainingIds.filter((other) => other !== id),
      );
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("a strict Expert board can finish its twentieth attempt under Chrome CPU throttling", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...rest) {
        return post.call(
          this,
          message?.difficulty
            ? { ...message, seed: "size-selection-11" }
            : message,
          ...rest,
        );
      };
    });
    await page.goto("./");
    await expect(page.locator('[data-difficulty="expert"]')).toBeEnabled();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    const started = Date.now();
    await page.locator('[data-difficulty="expert"]').click();
    await expect(page.locator("#board .board-arrow")).not.toHaveCount(0, {
      timeout: 15000,
    });
    const elapsedMs = Date.now() - started;
    const game = await readGame(page);
    expect(game.board.generatorVersion).toBe(GENERATOR_VERSION);
    expect(game.board.width).toBe(40);
    expect(game.board.shape).toBe("square");
    expect(game.board.generationMetrics.boardAttempts).toBe(20);
    expect(solveBoard(game.board).metrics.greedyMaxUnlocks).toBeLessThanOrEqual(
      4,
    );
    expect(elapsedMs).toBeLessThan(12000);
    expect(errors).toEqual([]);
    test.info().annotations.push({
      type: "Chrome CPU rate=6",
      description: `start to rendered board: ${elapsedMs}ms; desktop emulation, not physical mobile proof`,
    });
  } finally {
    await context.close();
  }
});
