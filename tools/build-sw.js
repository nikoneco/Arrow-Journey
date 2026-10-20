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
const files = (await list("dist")).filter((f) => !f.endsWith("/sw.js")).sort();
const hash = createHash("sha256");
hash.update((await readFile(new URL(import.meta.url), "utf8")).replace(/\r\n/g, "\n"));
for (const f of files) hash.update(await readFile(f));
const version = hash.digest("hex").slice(0, 16);
const urls = files.map((f) => "./" + f.slice(5));
urls.push("./");
await writeFile(
  "dist/sw.js",
  `const CACHE='arrow-journey-${version}';
const ASSETS=${JSON.stringify(urls)};
const SCOPE=new URL(self.registration.scope);
const CURRENT_ASSETS=new Set(ASSETS.map(u=>new URL(u,SCOPE).href));
const readyClients=new Set();
async function prune(){
 const clients=(await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(c=>c.url.startsWith(SCOPE.href));
 if(!clients.length||clients.some(c=>!readyClients.has(c.id)))return;
 const keys=await caches.keys();
 await Promise.all(keys.filter(k=>k.startsWith('arrow-journey-')&&k!==CACHE).map(k=>caches.delete(k)));
}
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('message',e=>{
 if(e.data==='SKIP_WAITING'){self.skipWaiting();return;}
 if(e.data?.type==='CLIENT_READY'&&e.source?.id&&e.source.url?.startsWith(SCOPE.href)){
  if(CURRENT_ASSETS.has(e.data.script))readyClients.add(e.source.id);else readyClients.delete(e.source.id);
  e.waitUntil(prune());
 }
});
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||!u.pathname.startsWith(SCOPE.pathname))return;e.respondWith(caches.open(CACHE).then(async c=>{const cached=await c.match(e.request,{ignoreVary:true});if(cached)return cached;for(const key of await caches.keys()){if(key.startsWith('arrow-journey-')&&key!==CACHE){const old=await(await caches.open(key)).match(e.request,{ignoreVary:true});if(old)return old;}}try{return await fetch(e.request)}catch(error){if(e.request.mode==='navigate')return c.match('./index.html');throw error}}))});
`,
);
console.log(`Offline shell: ${files.length} assets, ${version}`);
