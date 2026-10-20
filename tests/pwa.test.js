import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("Arrow Journey has its own resolved PWA ID and contained launch/scope", async () => {
  const m = JSON.parse(
    await readFile(
      new URL("../public/manifest.webmanifest", import.meta.url),
      "utf8",
    ),
  );
  const manifest =
    "https://nikoneco.github.io/Arrow-Journey/manifest.webmanifest";
  const start = new URL(m.start_url, manifest);
  const identity = new URL(m.id, start.origin);
  assert.equal(identity.href, "https://nikoneco.github.io/Arrow-Journey/");
  assert.equal(
    new URL(m.scope, manifest).href,
    "https://nikoneco.github.io/Arrow-Journey/",
  );
  assert.equal(start.href, identity.href);
  assert.notEqual(identity.href, "https://nikoneco.github.io/Sudoku/");
  assert.notEqual(identity.href, "https://nikoneco.github.io/");
});
