import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ORIGIN = 'https://example.test';
const SCOPE = `${ORIGIN}/Arrow-Journey/`;
const OLD_CACHE = 'arrow-journey-previous-build';
const SECOND_OLD_CACHE = 'arrow-journey-older-build';
const FOREIGN_CACHE = 'sudoku-separate-pwa';
const OLD_WORKER = `${SCOPE}assets/generator-worker-OLD.js`;
const CURRENT_SCRIPT = `${SCOPE}assets/index-CURRENT.js`;
const CURRENT_WORKER = `${SCOPE}assets/generator-worker-CURRENT.js`;

// Execute the real generator, with small build inputs, rather than duplicating SW
// code or requiring an ignored dist/ directory to exist on a clean checkout.
async function generatedWorkerSource() {
  const temporary = await mkdtemp(join(tmpdir(), 'arrow-journey-sw-test-'));
  try {
    await mkdir(join(temporary, 'dist', 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(temporary, 'dist', 'index.html'), '<main>current shell</main>'),
      writeFile(join(temporary, 'dist', 'assets', 'index-CURRENT.js'), 'export const current = true;'),
      writeFile(join(temporary, 'dist', 'assets', 'generator-worker-CURRENT.js'), 'self.onmessage = () => {};'),
    ]);
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../tools/build-sw.js', import.meta.url))], { cwd: temporary });
    return await readFile(join(temporary, 'dist', 'sw.js'), 'utf8');
  } finally {
    const target = resolve(temporary);
    assert.ok(target.startsWith(resolve(tmpdir(), 'arrow-journey-sw-test-')));
    await rm(target, { recursive: true, force: true });
  }
}

const source = await generatedWorkerSource();
const windowClient = (id, url = SCOPE) => ({ id, url, type: 'window' });

function workerHarness({ clients = [windowClient('current-window')], network = async () => new Response('network', { status: 200 }) } = {}) {
  const handlers = new Map();
  const entries = new Map();
  const deleted = [], opened = [], networkRequests = [];
  let claims = 0, skipped = 0;
  const normalized = (request) => new URL(typeof request === 'string' ? request : request.url, SCOPE).href;
  function cacheFor(name) {
    if (!entries.has(name)) entries.set(name, new Map());
    const values = entries.get(name);
    return {
      async match(request) { return values.get(normalized(request))?.clone(); },
      async put(request, response) { values.set(normalized(request), response.clone()); },
      async addAll(urls) {
        for (const url of urls) values.set(normalized(url), new Response(`precache:${normalized(url)}`));
      },
    };
  }
  const caches = {
    async open(name) { opened.push(name); return cacheFor(name); },
    async keys() { return [...entries.keys()]; },
    async delete(name) { deleted.push(name); return entries.delete(name); },
  };
  const self = {
    location: { origin: ORIGIN, href: `${SCOPE}sw.js` },
    registration: { scope: SCOPE },
    addEventListener(type, listener) { handlers.set(type, listener); },
    async skipWaiting() { skipped += 1; },
    clients: {
      async claim() { claims += 1; },
      async matchAll(options = {}) { return clients.filter((client) => !options.type || client.type === options.type); },
      async get(id) { return clients.find((client) => client.id === id); },
    },
  };
  const context = vm.createContext({ self, caches, URL, Set, Promise, Response,
    fetch: async (request) => { networkRequests.push(request.url); return network(request); } });
  vm.runInContext(source, context, { filename: 'generated-sw.js' });
  const currentCache = vm.runInContext('CACHE', context);
  async function dispatch(type, details = {}) {
    const pending = [];
    let response;
    const event = { ...details, waitUntil(promise) { pending.push(promise); }, respondWith(promise) { response = Promise.resolve(promise); } };
    await handlers.get(type)(event);
    await Promise.all(pending);
    return response ? { handled: true, response: await response } : { handled: false };
  }
  function put(name, url, body) { cacheFor(name); entries.get(name).set(normalized(url), new Response(body)); }
  return {
    currentCache, clients, entries, deleted, opened, networkRequests, dispatch, put,
    get claims() { return claims; }, get skipped() { return skipped; },
    fetch(url, options = {}) { return dispatch('fetch', { request: { url, method: 'GET', mode: 'cors', ...options } }); },
    message(data, client = clients[0]) { return dispatch('message', { data, source: client }); },
  };
}

test('activate claims clients and retains previous Arrow Journey caches', async () => {
  const harness = workerHarness();
  harness.put(OLD_CACHE, OLD_WORKER, 'old worker');
  harness.put(FOREIGN_CACHE, `${ORIGIN}/Sudoku/index.html`, 'other app');
  await harness.dispatch('activate');
  assert.equal(harness.claims, 1);
  assert.equal(harness.entries.has(OLD_CACHE), true);
  assert.equal(harness.entries.has(FOREIGN_CACHE), true);
  assert.deepEqual(harness.deleted, []);
});

test('a previous hashed worker is served from its cache with online 404 or offline network', async () => {
  for (const network of [async () => new Response('not found', { status: 404 }), async () => { throw new TypeError('offline'); }]) {
    const harness = workerHarness({ network });
    harness.put(OLD_CACHE, OLD_WORKER, 'previous worker bytes');
    await harness.dispatch('install');
    await harness.dispatch('activate');
    const result = await harness.fetch(OLD_WORKER);
    assert.equal(result.handled, true);
    assert.equal(result.response.status, 200);
    assert.equal(await result.response.text(), 'previous worker bytes');
    assert.deepEqual(harness.networkRequests, []);
    assert.equal(harness.entries.has(OLD_CACHE), true);
  }
});

test('current assets take precedence and unrelated PWA caches are never fallback sources', async () => {
  const harness = workerHarness();
  harness.put(harness.currentCache, CURRENT_WORKER, 'current worker bytes');
  harness.put(OLD_CACHE, CURRENT_WORKER, 'previous bytes at the same URL');
  harness.put(FOREIGN_CACHE, OLD_WORKER, 'foreign-cache bytes');
  const current = await harness.fetch(CURRENT_WORKER);
  assert.equal(await current.response.text(), 'current worker bytes');
  const missing = await harness.fetch(OLD_WORKER);
  assert.equal(await missing.response.text(), 'network');
  assert.equal(harness.opened.includes(FOREIGN_CACHE), false);
  assert.equal(harness.entries.has(FOREIGN_CACHE), true);
});

test('a remaining old tab prevents cleanup until every scoped window runs a current bundle', async () => {
  const oldTab = windowClient('old-tab');
  const newTab = windowClient('new-tab', `${SCOPE}?fresh`);
  const foreignTab = windowClient('sudoku-tab', `${ORIGIN}/Sudoku/`);
  const harness = workerHarness({ clients: [oldTab, newTab, foreignTab] });
  harness.put(harness.currentCache, CURRENT_SCRIPT, 'current bundle');
  harness.put(OLD_CACHE, OLD_WORKER, 'previous worker');
  harness.put(SECOND_OLD_CACHE, `${SCOPE}assets/older.js`, 'older bundle');
  harness.put(FOREIGN_CACHE, `${ORIGIN}/Sudoku/worker.js`, 'other app worker');
  await harness.dispatch('activate');
  await harness.message({ type: 'CLIENT_READY', script: CURRENT_SCRIPT }, newTab);
  assert.equal(harness.entries.has(OLD_CACHE), true);
  await harness.message({ type: 'CLIENT_READY', script: `${SCOPE}assets/index-OLD.js` }, oldTab);
  assert.equal(harness.entries.has(OLD_CACHE), true);
  const response = await harness.fetch(OLD_WORKER);
  assert.equal(await response.response.text(), 'previous worker');
  await harness.message({ type: 'CLIENT_READY', script: CURRENT_SCRIPT }, oldTab);
  assert.equal(harness.entries.has(OLD_CACHE), false);
  assert.equal(harness.entries.has(SECOND_OLD_CACHE), false);
  assert.equal(harness.entries.has(harness.currentCache), true);
  assert.equal(harness.entries.has(FOREIGN_CACHE), true);
  assert.deepEqual(harness.deleted.slice().sort(), [OLD_CACHE, SECOND_OLD_CACHE].sort());
});

test('ready messages require the expected type, source scope and exact current asset URL', async () => {
  const scoped = windowClient('scoped');
  const harness = workerHarness({ clients: [scoped] });
  harness.put(OLD_CACHE, OLD_WORKER, 'previous worker');
  const current = { type: 'CLIENT_READY', script: CURRENT_SCRIPT };
  const invalid = [
    [undefined, scoped], [null, scoped], ['CLIENT_READY', scoped],
    [{ ...current, type: 'OTHER' }, scoped], [{ type: 'CLIENT_READY' }, scoped],
    [{ ...current, script: `${SCOPE}assets/index-OLD.js` }, scoped],
    [{ ...current, script: './assets/index-CURRENT.js' }, scoped],
    [{ ...current, script: `${CURRENT_SCRIPT}?stale` }, scoped],
    [{ ...current, script: `${ORIGIN}/Sudoku/assets/index-CURRENT.js` }, scoped],
    [current, null], [current, { url: SCOPE }], [current, { id: scoped.id }],
    [current, windowClient(scoped.id, `${ORIGIN}/Sudoku/`)],
    [current, windowClient(scoped.id, `${ORIGIN}/Arrow-Journey-elsewhere/`)],
    [current, windowClient(scoped.id, 'https://other.test/Arrow-Journey/')],
    [current, { id: 'worker-client', url: CURRENT_WORKER, type: 'worker' }],
  ];
  for (const [data, client] of invalid) {
    await harness.message(data, client);
    assert.equal(harness.entries.has(OLD_CACHE), true, JSON.stringify({ data, client }));
  }
  await harness.message(current, scoped);
  assert.equal(harness.entries.has(OLD_CACHE), false);
});

test('a stale bundle report revokes readiness and no-window state retains old caches', async () => {
  const first = windowClient('first'), second = windowClient('second');
  const harness = workerHarness({ clients: [first, second] });
  harness.put(OLD_CACHE, OLD_WORKER, 'previous worker');
  await harness.message({ type: 'CLIENT_READY', script: CURRENT_SCRIPT }, first);
  await harness.message({ type: 'CLIENT_READY', script: `${SCOPE}assets/index-OLD.js` }, first);
  await harness.message({ type: 'CLIENT_READY', script: CURRENT_SCRIPT }, second);
  assert.equal(harness.entries.has(OLD_CACHE), true);
  await harness.message({ type: 'CLIENT_READY', script: CURRENT_SCRIPT }, first);
  assert.equal(harness.entries.has(OLD_CACHE), false);

  const empty = workerHarness({ clients: [] });
  empty.put(OLD_CACHE, OLD_WORKER, 'previous worker');
  await empty.message({ type: 'CLIENT_READY', script: CURRENT_SCRIPT }, windowClient('closed-client'));
  assert.equal(empty.entries.has(OLD_CACHE), true);
});

test('fetch handling stays inside GET requests for this origin and app scope', async () => {
  const harness = workerHarness();
  const requests = [
    [CURRENT_SCRIPT, { method: 'POST' }],
    [`${ORIGIN}/Sudoku/assets/index.js`, {}],
    [`${ORIGIN}/Arrow-Journey-other/assets/index.js`, {}],
    ['https://other.test/Arrow-Journey/assets/index.js', {}],
  ];
  for (const [url, options] of requests) assert.equal((await harness.fetch(url, options)).handled, false);
  assert.deepEqual(harness.networkRequests, []);
  assert.deepEqual(harness.opened, []);
});

test('offline navigation uses the current shell and only the skip command skips waiting', async () => {
  const harness = workerHarness({ network: async () => { throw new TypeError('offline'); } });
  harness.put(harness.currentCache, `${SCOPE}index.html`, 'offline current shell');
  const response = await harness.fetch(`${SCOPE}play`, { mode: 'navigate' });
  assert.equal(await response.response.text(), 'offline current shell');
  await harness.message('OTHER');
  await harness.message({ type: 'SKIP_WAITING' });
  assert.equal(harness.skipped, 0);
  await harness.message('SKIP_WAITING');
  assert.equal(harness.skipped, 1);
});
