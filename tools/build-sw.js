import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
async function list(dir) {
  const es = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      es.map((e) =>
        e.isDirectory() ? list(`${dir}/${e.name}`) : `${dir}/${e.name}`,
      ),
    )
  ).flat();
}
const files = (await list("dist")).filter((f) => !f.endsWith("/sw.js"));
const hash = createHash("sha256");
hash.update(await readFile(new URL(import.meta.url)));
for (const f of files) hash.update(await readFile(f));
const version = hash.digest("hex").slice(0, 16);
const urls = files.map((f) => "./" + f.slice(5));
urls.push("./");
await writeFile(
  "dist/sw.js",
  `const CACHE='arrow-journey-${version}';
const ASSETS=${JSON.stringify(urls)};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('message',e=>{if(e.data==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('arrow-journey-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||!u.pathname.startsWith(new URL(self.registration.scope).pathname))return;e.respondWith(caches.open(CACHE).then(async c=>{const cached=await c.match(e.request,{ignoreVary:true});if(cached)return cached;try{return await fetch(e.request)}catch(error){if(e.request.mode==='navigate')return c.match('./index.html');throw error}}))});
`,
);
console.log(`Offline shell: ${files.length} assets, ${version}`);
