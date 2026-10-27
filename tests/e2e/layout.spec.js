import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { canRemove } from "../../js/engine.js";
import { boardCoordinates } from "./board-coordinates.js";

const evidence =
  "C:/Users/aqua_/Documents/Codex/2026-10-27/Arrow-Journey-layout";
async function game(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("arrow-journey-local-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            read = db
              .transaction("profiles")
              .objectStore("profiles")
              .get("guest");
          read.onsuccess = () => {
            db.close();
            resolve(read.result.activeGame);
          };
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
        };
      }),
  );
}
async function checkToolbar(page) {
  const frame = await page.locator("#board").boundingBox();
  const controls = await Promise.all(
    [
      ".play-count",
      '[data-action="zoomOut"]',
      '[data-action="fit"]',
      '[data-action="zoomIn"]',
      '[data-action="hint"]',
    ].map((selector) => page.locator(selector).boundingBox()),
  );
  const centers = controls.map((rect) => rect.y + rect.height / 2);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(5);
  for (const rect of controls)
    expect(rect.y + rect.height).toBeLessThan(frame.y);
  for (const rect of controls.slice(1)) {
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  return frame;
}

test("phone viewport uses one top control row and keeps an undistorted square board through rotation and resume", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 430, height: 932 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("./");
    await expect(page).toHaveTitle("Arrow Journey");
    await page.locator("#new-shape").selectOption("square");
    await page.locator('[data-difficulty="expert"]').click();
    await expect(page.locator("#board .board-arrow")).not.toHaveCount(0);
    const original = await game(page);
    expect(original.board.width).toBe(original.board.height);
    for (const [width, height] of [
      [430, 932],
      [430, 739],
      [354, 780],
      [320, 640],
      [932, 430],
    ]) {
      await page.setViewportSize({ width, height });
      await expect
        .poll(() =>
          page
            .locator("#board svg")
            .evaluate(
              (svg) =>
                svg.viewBox.baseVal.width / svg.viewBox.baseVal.height -
                svg.clientWidth / svg.clientHeight,
            ),
        )
        .toBeCloseTo(0, 5);
      const frame = await checkToolbar(page);
      if (height > 700 && width < 500)
        expect(frame.height).toBeGreaterThan(frame.width + 60);
      expect(frame.y + frame.height).toBeLessThanOrEqual(height);
      const matrix = await page.locator("#board svg > g").evaluate((scene) => {
        const m = scene.getScreenCTM();
        return { a: m.a, b: m.b, c: m.c, d: m.d };
      });
      expect(matrix.a).toBeCloseTo(matrix.d, 6);
      expect(matrix.b).toBe(0);
      expect(matrix.c).toBe(0);
    }
    await page.setViewportSize({ width: 430, height: 932 });
    await expect
      .poll(async () => (await page.locator("#board").boundingBox()).height)
      .toBeGreaterThan(650);
    // Simulate standalone safe-area padding separately from Safari's shorter content viewport.
    await page.addStyleTag({
      content: ".shell-play { padding-top:59px; padding-bottom:34px; }",
    });
    const safeFrame = await checkToolbar(page);
    expect(safeFrame.height).toBeGreaterThan(safeFrame.width + 150);
    expect(safeFrame.y + safeFrame.height).toBeLessThan(932 - 34);
    await page.getByRole("button", { name: "ヒント 残り 3 回" }).click();
    await expect(page.locator("#hint-count")).toHaveText("2");
    await expect(
      page.getByRole("button", { name: "ヒント 残り 2 回" }),
    ).toBeEnabled();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: evidence + "/iphone-fit.png" });
    for (let step = 0; step < 3; step++)
      await page.getByRole("button", { name: "拡大", exact: true }).click();
    await expect
      .poll(async () => (await game(page)).view?.zoom)
      .toBeCloseTo(2.197, 3);
    await page.screenshot({ path: evidence + "/iphone-zoom.png" });
    await page.getByRole("button", { name: "ホーム", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: /つづきから/ }).click();
    const resumed = await game(page);
    expect(resumed.board).toEqual(original.board);
    expect(resumed.playId).toBe(original.playId);
    expect(resumed.remainingIds).toEqual(original.remainingIds);
    expect(resumed.hintsUsed).toBe(1);
    await expect(page.locator("#board svg > g")).toHaveAttribute(
      "transform",
      /scale\(2\.197/,
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("touches and holds reach zoomed arrows in the added upper and lower viewport areas", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 430, height: 932 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await page.goto("./");
    await page.locator("#new-shape").selectOption("square");
    await page.locator('[data-difficulty="expert"]').click();
    await expect(page.locator("#board .board-arrow")).not.toHaveCount(0);
    const original = await game(page);
    for (let step = 0; step < 3; step++)
      await page.getByRole("button", { name: "拡大", exact: true }).click();
    const boundaries = await page.locator("#board svg").evaluate((svg) => {
      const m = svg.getScreenCTM(),
        b = svg.getBoundingClientRect();
      return {
        top: new DOMPoint(0, 0).matrixTransform(m).y,
        bottom: new DOMPoint(
          0,
          Number(svg.querySelector("clipPath rect").getAttribute("height")),
        ).matrixTransform(m).y,
        left: b.left,
        right: b.right,
        frameTop: b.top,
        frameBottom: b.bottom,
      };
    });
    const coordinates = await boardCoordinates(page);
    const targets = original.board.arrows
      .filter(
        (arrow) =>
          !canRemove(original.board, original.remainingIds, arrow.id).allowed,
      )
      .flatMap((arrow) =>
        arrow.cells.map((cell) => ({ id: arrow.id, ...coordinates(cell) })),
      )
      .filter(
        (point) =>
          point.x > boundaries.left + 5 &&
          point.x < boundaries.right - 5 &&
          point.y > boundaries.frameTop + 5 &&
          point.y < boundaries.frameBottom - 5,
      );
    const upper = targets.find((point) => point.y < boundaries.top - 5),
      lower = targets.find((point) => point.y > boundaries.bottom + 5);
    expect(upper).toBeTruthy();
    expect(lower).toBeTruthy();
    await page.touchscreen.tap(upper.x, upper.y);
    await expect(page.locator("#misses")).toHaveText("1");
    await page.touchscreen.tap(lower.x, lower.y);
    await expect(page.locator("#misses")).toHaveText("2");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: upper.x, y: upper.y, id: 41 }],
    });
    await expect(page.locator(".board-ray-guide")).toHaveCount(1);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(page.locator(".board-ray-guide")).toHaveCount(0);
    const scene = page.locator("#board svg > g"),
      beforeDrag = await scene.getAttribute("transform");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 215, y: 500, id: 42 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 250, y: 540, id: 42 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(scene).not.toHaveAttribute("transform", beforeDrag);
    expect((await game(page)).remainingIds).toEqual(original.remainingIds);
    await expect(page.locator("#misses")).toHaveText("2");
  } finally {
    await context.close();
  }
});
