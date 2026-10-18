// usage: node tools/sheet.mjs <screens,...> [imgWidth] [out.png] [deviceFilter]
// re-render the contact sheet for a subset of screens without re-running devices
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const OUT = resolve("shots"), r = JSON.parse(readFileSync(join(OUT, "report.json"))).filter(x => x.dir);
const screens = process.argv[2].split(","), w = +(process.argv[3] || 230), out = process.argv[4] || "sub.png";
const devs = process.argv[5] ? r.filter(x => process.argv[5].split(",").some(n => x.device.includes(n))) : r;
const html = `<!doctype html><style>body{font:12px sans-serif;margin:8px;background:#bbb}table{border-spacing:8px}img{width:${w}px;border:1px solid #666;display:block}th{text-align:left;vertical-align:top}</style><table><tr><th></th>${devs.map(d => `<th>${d.device}</th>`).join("")}</tr>${screens.map(s => `<tr><th>${s}</th>${devs.map(d => `<td>${existsSync(join(d.dir, s + ".png")) ? `<img src="file://${join(d.dir, s + ".png")}">` : ""}</td>`).join("")}</tr>`).join("")}</table>`;
// one device: one row of screens
const one = devs.length === 1 ? `<!doctype html><style>body{font:13px sans-serif;margin:8px;background:#bbb}td{vertical-align:top;padding:4px}img{width:${w}px;border:1px solid #666;display:block}</style><table><tr>${screens.map(s => `<td>${s}<br>${existsSync(join(devs[0].dir, s + ".png")) ? `<img src="file://${join(devs[0].dir, s + ".png")}">` : ""}</td>`).join("")}</tr></table>` : null;
writeFileSync(join(OUT, "sub.html"), one || html);
const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 400, height: 400 } });
await p.goto("file://" + join(OUT, "sub.html"));
await p.screenshot({ path: join(OUT, out), fullPage: true }); await b.close();
