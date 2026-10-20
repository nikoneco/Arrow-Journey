import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
test("a waiting service worker exposes Update and preserves saved progress", async ({
  page,
}) => {
  let release = 0;
  const root = resolve("dist");
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      ),
      file = resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
    if (
      !file.startsWith(
        root + "/".replace("/", process.platform === "win32" ? "\\" : "/"),
      )
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = await readFile(file);
      if (pathname === "/sw.js")
        body = Buffer.concat([
          body,
          Buffer.from(`\n// QA release ${release}\n`),
        ]);
      res.writeHead(200, {
        "Content-Type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".html": "text/html",
            ".svg": "image/svg+xml",
            ".webmanifest": "application/manifest+json",
            ".png": "image/png",
          }[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('[data-difficulty="easy"]').click();
    await expect(page.locator("#board .board-arrow")).not.toHaveCount(0);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.getByRole("button", { name: "ヒント 残り 3 回" }).click();
    await expect(page.locator("#hint-left")).toHaveText("残り 2 回");
    const read = () =>
      page.evaluate(
        () =>
          new Promise((r) => {
            const q = indexedDB.open("arrow-journey-local-v1");
            q.onsuccess = () => {
              const db = q.result,
                g = db
                  .transaction("profiles")
                  .objectStore("profiles")
                  .get("guest");
              g.onsuccess = () => {
                db.close();
                r(g.result.activeGame);
              };
            };
          }),
      );
    const before = await read();
    release = 1;
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update();
    });
    await expect(
      page.getByRole("button", { name: "更新", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#board")).toBeVisible();
    await page.screenshot({
      path: "C:/Users/aqua_/.codex/visualizations/2026/10/20/01a15956-6698-7a93-94ae-729f1decee32/arrow-update-mobile.png",
    });
    await Promise.all([
      page.waitForNavigation(),
      page.getByRole("button", { name: "更新", exact: true }).click(),
    ]);
    await page.getByRole("button", { name: /つづきから/ }).click();
    await expect(page.locator("#hint-left")).toHaveText("残り 2 回");
    const after = await read();
    expect(after.playId).toBe(before.playId);
    expect(after.remainingIds).toEqual(before.remainingIds);
    expect(after.misses).toBe(before.misses);
    expect(after.hintsUsed).toBe(before.hintsUsed);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("an old tab can generate offline after another tab installs changed asset URLs", async ({
  browser,
}) => {
  const root = resolve("dist");
  const names = await readdir(resolve(root, "assets"));
  const renamed = new Map(
    names.map((name) => [name, name.replace(/(\.[^.]+)$/, "-qa-next$1")]),
  );
  const reverse = new Map([...renamed].map(([a, b]) => [b, a]));
  let release = 0;
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    let original = pathname;
    if (release && pathname.startsWith("/assets/")) {
      const name = reverse.get(pathname.slice(8));
      if (!name) {
        res.writeHead(404).end();
        return;
      }
      original = "/assets/" + name;
    }
    const file = resolve(
      root,
      "." + (original === "/" ? "/index.html" : original),
    );
    if (!file.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = await readFile(file);
      if (release && [".js", ".css", ".html"].includes(extname(file))) {
        let source = body.toString();
        for (const [oldName, newName] of renamed)
          source = source.replaceAll(oldName, newName);
        if (pathname === "/sw.js")
          source = source.replace(
            /arrow-journey-([a-f0-9]{16})/,
            "arrow-journey-$1-qa-next",
          );
        body = Buffer.from(source);
      }
      res
        .writeHead(200, {
          "Content-Type":
            {
              ".js": "text/javascript",
              ".html": "text/html",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".webmanifest": "application/manifest+json",
              ".png": "image/png",
            }[extname(file)] || "application/octet-stream",
          "Cache-Control": "no-store",
        })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const context = await browser.newContext();
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const first = await context.newPage(),
      old = await context.newPage();
    await first.goto(url);
    await first.evaluate(() => navigator.serviceWorker.ready);
    await old.goto(url);
    await old.evaluate(() => navigator.serviceWorker.ready);
    const beforeWorker = await old.evaluate(
      () => navigator.serviceWorker.controller.scriptURL,
    );
    const oldAssets = await old
      .locator('script[type="module"]')
      .getAttribute("src");
    release = 1;
    await first.evaluate(async () =>
      (await navigator.serviceWorker.getRegistration()).update(),
    );
    await expect(
      first.getByRole("button", { name: "更新", exact: true }),
    ).toBeVisible();
    await Promise.all([
      first.waitForNavigation(),
      first.getByRole("button", { name: "更新", exact: true }).click(),
    ]);
    await expect(first.locator('script[type="module"]')).not.toHaveAttribute(
      "src",
      oldAssets,
    );
    // The other page stays in its existing JavaScript realm, without an automatic reload.
    await expect(old.locator('script[type="module"]')).toHaveAttribute(
      "src",
      oldAssets,
    );
    expect(
      await old.evaluate(() => navigator.serviceWorker.controller.scriptURL),
    ).toBe(beforeWorker);
    await context.setOffline(true);
    await old.locator('[data-difficulty="expert"]').click();
    await expect(old.locator("#board .board-arrow")).not.toHaveCount(0);
    expect(
      (await old.evaluate(() => caches.keys())).filter((k) =>
        k.startsWith("arrow-journey-"),
      ).length,
    ).toBe(2);
    await context.setOffline(false);
    await old.reload();
    await expect
      .poll(
        async () =>
          (await old.evaluate(() => caches.keys())).filter((k) =>
            k.startsWith("arrow-journey-"),
          ).length,
      )
      .toBe(1);
    await old.getByRole("button", { name: /つづきから/ }).click();
    await expect(old.locator("#board .board-arrow")).not.toHaveCount(0);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
