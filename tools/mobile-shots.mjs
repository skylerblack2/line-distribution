// Screenshots the app on phone profiles (WebKit for iPhones, Chromium for Android) and audits layout.
// Usage: ROSTER=<file.linedist.json> MP3=<file.mp3> npm run shots   (app served at BASE, default 127.0.0.1:8470)
// Output: shots/<device>/*.png, shots/report.json, shots/sheet.png

import { webkit, chromium, devices } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:8470/";
const FIXTURES = process.env.FIXTURES || resolve("fixtures");
const ROSTER = process.env.ROSTER || join(FIXTURES, "roster.linedist.json");
const MP3 = process.env.MP3 || join(FIXTURES, "song.mp3");
const OUT = resolve("shots");
// "@WxH" overrides the profile's viewport (visible area under the browser toolbars)
const DEVICES = (process.env.DEVICES || "iPhone 16 Pro@402x620,iPhone 16 Pro@402x681,iPhone 16 Pro@402x780")
  .split(",").map(s => s.trim());

const sleep = ms => new Promise(r => setTimeout(r, ms));

// layout audit, run in the page
const AUDIT = () => {
  const vw = innerWidth, vh = innerHeight, issues = [];
  if (document.documentElement.scrollWidth > vw + 1) issues.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${vw}px)`);
  for (const el of document.querySelectorAll("header *, #bottom *, dialog[open] *, .row *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).visibility === "hidden") continue;
    if (r.right > vw + 1 || r.left < -1) issues.push(`off-screen x: ${el.tagName.toLowerCase()}#${el.id}.${el.className} [${Math.round(r.left)}..${Math.round(r.right)}]`);
  }
  for (const el of document.querySelectorAll("button, .holdbtn, input, select")) {
    const r = el.getBoundingClientRect();
    if (!r.width || el.closest("dialog:not([open])") || el.hidden) continue;
    if (r.width < 32 || r.height < 32) issues.push(`small tap target ${Math.round(r.width)}x${Math.round(r.height)}: ${el.id || el.className || el.textContent.trim().slice(0, 12)}`);
  }
  const bottom = document.getElementById("bottom").getBoundingClientRect();
  const rows = [...document.querySelectorAll(".row")];
  const lastRow = rows[rows.length - 1].getBoundingClientRect();
  const header = document.querySelector("header").getBoundingClientRect();
  const f = document.activeElement;
  if (document.querySelector("dialog[open]") && f && /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName)) issues.push(`dialog opened with keyboard focus in #${f.id}`);
  return {
    vw, vh, issues: [...new Set(issues)].slice(0, 25),
    headerH: Math.round(header.height), bottomBarTop: Math.round(bottom.top), bottomBarH: Math.round(bottom.height),
    docH: document.documentElement.scrollHeight,
    rowsVisibleWithoutScroll: rows.filter(r => r.getBoundingClientRect().bottom <= bottom.top).length,
    lastRowBottom: Math.round(lastRow.bottom),
  };
};

async function run(name) {
  const [base, size] = name.split("@");
  if (!devices[base]) { console.error("unknown device", name); return null; }
  const d = { ...devices[base] };
  if (size) { const [w, h] = size.split("x").map(Number); d.viewport = { width: w, height: h }; }
  const browser = await (d.defaultBrowserType === "webkit" ? webkit : chromium).launch();
  const ctx = await browser.newContext({ ...d });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  const dir = join(OUT, name.replace(/[^\w]+/g, "-"));
  mkdirSync(dir, { recursive: true });
  const shot = async n => { await sleep(350); await page.screenshot({ path: join(dir, n + ".png") }); };
  const audits = {};

  await page.goto(BASE);
  await page.waitForFunction(() => window.lineDist && window.lineDist.project);
  await page.setInputFiles("#importFile", ROSTER);
  await page.waitForFunction(() => lineDist.project.segments.length > 0);
  const animalId = await page.evaluate(() => lineDist.project.id);

  // new song from the roster
  await page.tap("#libBtn");
  await page.fill("#newTitle", "Sample Song");
  await page.tap("#newCreate");
  await page.waitForFunction(() => lineDist.project.song.title === "Sample Song");
  await shot("01-new-song-no-audio");
  await page.setInputFiles("#audioFile", MP3);
  await page.waitForFunction(() => lineDist.clock.hasAudio, null, { timeout: 30000 });
  await page.evaluate(() => { document.getElementById("audio").muted = true; });
  await sleep(1500); // let the waveform arrive
  await shot("02-main");
  audits.main = await page.evaluate(AUDIT);
  await page.reload();
  await page.waitForFunction(() => window.lineDist && lineDist.project && lineDist.clock.hasAudio, null, { timeout: 15000 })
    .then(() => { audits.audioSurvivesReload = true; }, () => { audits.audioSurvivesReload = false; });
  await page.evaluate(() => { document.getElementById("audio").muted = true; });

  // mid-hold: play, hold member 2 via pointer events on its button
  await page.tap("#playBtn");
  await sleep(600);
  await page.evaluate(() => {
    const b = document.querySelectorAll(".holdbtn")[1], r = b.getBoundingClientRect();
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, isPrimary: true, pointerType: "touch", clientX: r.x + 5, clientY: r.y + 5 }));
  });
  await sleep(1200);
  await shot("03-holding");
  await page.evaluate(() => {
    const b = document.querySelectorAll(".holdbtn")[1];
    b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, isPrimary: true, pointerType: "touch" }));
  });
  await page.tap("#playBtn");

  // a song with segments
  await page.evaluate(id => lineDist.openProject(id), animalId);
  await sleep(400);
  await shot("04-filled");
  audits.filled = await page.evaluate(AUDIT);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot("05-filled-scrolled");
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.tap("#detailBtn");
  await shot("06-segments");
  await page.tap("#detailBtn");
  await page.tap(".switch");
  await page.evaluate(() => lineDist.clock.seek(75));
  await shot("07-playback-75s");
  await page.tap(".switch");

  for (const [btn, n] of [["#distBtn", "08-distribution"], ["#libBtn", "09-library"], ["#gearBtn", "10-settings"]]) {
    await page.tap(btn);
    await shot(n);
    audits[n] = await page.evaluate(AUDIT);
    if (n === "10-settings") {
      await page.evaluate(() => { const d = document.getElementById("setDlg"); d.scrollTop = d.scrollHeight; });
      await shot("11-settings-bottom");
    }
    await page.keyboard.press("Escape");
    await sleep(150);
  }

  await browser.close();
  return { device: name, browser: d.defaultBrowserType, viewport: d.viewport, dpr: d.deviceScaleFactor, errors, audits, dir };
}

mkdirSync(OUT, { recursive: true });
const results = [];
for (const name of DEVICES) {
  process.stdout.write(name + " … ");
  try { const r = await run(name); if (r) results.push(r); console.log("ok"); }
  catch (e) { console.log("FAILED: " + e.message.split("\n")[0]); results.push({ device: name, failed: e.message }); }
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(results, null, 2));

// contact sheet: one row per screen, one column per device
const screens = ["01-new-song-no-audio", "02-main", "03-holding", "04-filled", "05-filled-scrolled", "06-segments", "07-playback-75s", "08-distribution", "09-library", "10-settings", "11-settings-bottom"];
const ok = results.filter(r => r.dir);
const cell = (r, s) => existsSync(join(r.dir, s + ".png")) ? `<img src="file://${join(r.dir, s + ".png")}">` : "";
const html = `<!doctype html><meta charset=utf-8><style>
body{font:13px -apple-system,sans-serif;margin:12px;background:#ccc}
table{border-collapse:separate;border-spacing:10px} td{vertical-align:top}
img{width:${process.env.SHEET_W || 230}px;border:1px solid #888;display:block} th{text-align:left}
</style><table><tr><th></th>${ok.map(r => `<th>${r.device}<br>${r.viewport.width}×${r.viewport.height} ${r.browser}</th>`).join("")}</tr>
${(process.env.SCREENS ? process.env.SCREENS.split(",") : screens).map(s => `<tr><th>${s}</th>${ok.map(r => `<td>${cell(r, s)}</td>`).join("")}</tr>`).join("\n")}</table>`;
writeFileSync(join(OUT, "sheet.html"), html);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1800, height: 1000 } });
await p.goto("file://" + join(OUT, "sheet.html"));
await p.screenshot({ path: join(OUT, "sheet.png"), fullPage: true });
await b.close();
console.log("wrote shots/sheet.png and shots/report.json");
