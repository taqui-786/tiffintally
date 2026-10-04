// Isolated Chrome renderer, not a connection to the user's/browser-panel profile.
// Requires an already installed Chrome and the existing tsx -> esbuild dependency.
import { createRequire } from "node:module";
import { readFile, writeFile, mkdtemp, copyFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const cwd = process.cwd();
const output = await mkdtemp("/tmp/opencode/responsive-");
const origin = process.env.RESPONSIVE_ORIGIN || "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) throw new Error("Only a local app origin is accepted.");
const response = await fetch(origin);
if (!response.ok) throw new Error("Start the local app before running this check.");
const html = await response.text();
const htmlClass = html.match(/<html[^>]*class="([^"]+)"/)?.[1] ?? "";
let css = "";
for (const [, href] of html.matchAll(/href="([^"]+\.css(?:\?[^\"]*)?)"/g)) {
  const url = new URL(href.replaceAll("&amp;", "&"), origin);
  let chunk = await (await fetch(url)).text();
  const replacements = new Map();
  for (const match of chunk.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)) {
    if (match[1].startsWith("data:")) continue;
    const asset = new URL(match[1], url);
    if (asset.origin !== origin) throw new Error("Refusing an external fixture asset.");
    const target = join(output, basename(asset.pathname));
    await writeFile(target, new Uint8Array(await (await fetch(asset)).arrayBuffer()));
    replacements.set(match[1], pathToFileURL(target).href);
  }
  for (const [from, to] of replacements) chunk = chunk.replaceAll(from, to);
  css += chunk;
}
await copyFile("public/landing/tiffin-lunchboxes.jpg", join(output, "tiffin-lunchboxes.jpg"));
await copyFile("public/landing/meal.jpg", join(output, "meal.jpg"));
const blocked = "async()=>{throw new Error('Writes disabled in responsive fixtures.')}";
const bundle = await build({
  entryPoints: ["tests/responsive/fixture.jsx"], absWorkingDir: cwd, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "offline-fixtures", setup(b) {
    b.onResolve({ filter: /^(@\/app\/actions\/|@\/lib\/client\/api$|better-auth\/react$|next\/(image|link)$)/ }, (args) => ({ path: args.path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, async ({ path }) => {
      let contents;
      if (path.startsWith("@/app/actions/")) {
        const text = await readFile(resolve(path.replace("@/", "") + ".ts"), "utf8");
        const names = [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
        contents = `import {contacts} from ${JSON.stringify(resolve("tests/responsive/data.mjs"))};` + names.map((name) => {
          const fn = name === "getWhatsAppWebStatusAction" ? `async()=>({ok:true,status:'scan_qr',qrDataUrl:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22224%22 height=%22224%22%3E%3Crect width=%22224%22 height=%22224%22 fill=%22white%22/%3E%3Ctext x=%2220%22 y=%22112%22%3EFictional QR only%3C/text%3E%3C/svg%3E',phoneNumber:null,hasSavedSession:false})` : name === "listWhatsAppContactsAction" ? "async()=>contacts" : blocked;
          return `export const ${name}=${fn};`;
        }).join("\n");
      } else if (path === "@/lib/client/api") contents = `export class ClientError extends Error{constructor(code,message,retryable=false,status){super(message);Object.assign(this,{code,retryable,status})}};export const retryRead=()=>false;export const getOperation=async(name)=>{const scenario=new URLSearchParams(location.search).get('scenario');if(scenario==='error')throw new ClientError('DEPENDENCY_UNAVAILABLE','FictionalErrorWithoutSpaces'.repeat(12),false,503);if(scenario==='loading')return new Promise(()=>{});const value=window.fixtureData[name];if(value===undefined)throw new Error('No fixture for '+name);return value};export const unwrapResult=(name,result)=>{if(!result.ok)throw new Error('Fixture write blocked');return result.data};`;
      else if (path === "better-auth/react") contents = "export const createAuthClient=()=>({useSession:()=>({data:{user:{name:'Fictional Kitchen Owner'}},error:null})});";
      else if (path === "next/link") contents = "import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}";
      else contents = `import React from 'react';export default function Image({src,fill,preload,...props}){return React.createElement('img',{...props,src:${JSON.stringify(pathToFileURL(output).href + "/")}+src.split('/').pop(),style:fill?{position:'absolute',inset:0,width:'100%',height:'100%'}:undefined})}`;
      return { contents, loader: "js", resolveDir: cwd };
    });
  } }],
});
await writeFile(join(output, "fixture.js"), bundle.outputFiles[0].contents);
await writeFile(join(output, "fixture.html"), `<!doctype html><html class="${htmlClass}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
const scenarios = ["landing", "landing-menu", "landing-faq", "landing-demo", "signin", "onboarding", "skeleton", "loading", "error", "kitchen", "review", "billing", "billing-issued", "setup", "dispatch", "customers", "customer-form", "schedule", "manual-proposal", "proposal", "source", "intake", "finalize", "whatsapp", "select", "empty-kitchen", "empty-review", "empty-customers", "empty-billing", "empty-setup", "empty-dispatch"];
const sizes = [[320, 720], [375, 812], [390, 844], [640, 900], [768, 1024], [820, 1180], [1024, 768], [1280, 900], [640, 360]];
const cases = sizes.flatMap(([width, height]) => scenarios.map((scenario) => ({ width, height, scenario })));
await writeFile(join(output, "matrix.html"), `<!doctype html><html><body><h1>Read-only responsive fixture matrix</h1><pre id="results">Running</pre><script>
const cases=${JSON.stringify(cases)}, reports=[];let index=0;let timer;
function next(){if(index===cases.length){document.getElementById('results').textContent=JSON.stringify(reports);document.title='Complete';return}const test=cases[index];const frame=document.createElement('iframe');frame.style.cssText='border:0;width:'+test.width+'px;height:'+test.height+'px';frame.src='fixture.html?scenario='+test.scenario;document.body.appendChild(frame);timer=setTimeout(()=>finish({scenario:test.scenario,width:test.width,height:test.height,error:'Fixture timed out'}),2500)}
function finish(report){clearTimeout(timer);reports.push(report);document.querySelector('iframe')?.remove();index++;next()}
addEventListener('message',(event)=>{if(event.source===document.querySelector('iframe')?.contentWindow&&event.data?.type==='responsive-result')finish(event.data.report)});next();
</script></body></html>`);
const dom = execFileSync(process.env.CHROME_BIN || "/usr/bin/google-chrome", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--allow-file-access-from-files", `--user-data-dir=${join(output, "profile")}`, "--window-size=1400,1200", "--virtual-time-budget=180000", "--dump-dom", pathToFileURL(join(output, "matrix.html")).href], { timeout: 180000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString();
await writeFile(join(output, "matrix-dom.html"), dom);
const raw = dom.match(/<pre id="results">([\s\S]*?)<\/pre>/)?.[1]?.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
if (!raw || raw === "Running") throw new Error(`Matrix did not finish. Inspect ${output}/matrix-dom.html`);
const reports = JSON.parse(raw);
const failed = reports.filter((row) => row.error || row.documentWidth > row.width + 1 || row.overflows?.length || row.smallTargets?.length || row.clippedDialogs?.length || row.renderErrors?.length);
await writeFile("docs/responsive-results.json", JSON.stringify({ renderer: "isolated Chrome with offline read-only fixtures and real app CSS", cases: reports.length, failed: failed.length, reports }, null, 2) + "\n");
console.log(`${reports.length} responsive cases; ${failed.length} failed. Temporary evidence: ${output}`);
for (const row of failed) console.log(JSON.stringify(row));
if (reports.length !== cases.length || failed.length) process.exitCode = 1;
