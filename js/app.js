import { buildTracks, snapTo, fmt, parseDur, normalizeImport } from "./timeline.js";
import { Clock } from "./clock.js";
import { db, readV1Audio } from "./db.js";

const $ = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 9);
const PALETTE = ["#6666e0", "#f4547c", "#f79422", "#66b466", "#bd7ee8", "#e05656", "#4bb8c9", "#c9a227"];
const RATES = [1, 0.75, 0.5];
const PREFS_KEY = "line-dist-v2-prefs";

const els = {
  songLabel: $("songLabel"), headline: $("headline"), list: $("list"),
  playBtn: $("playBtn"), timeLabel: $("timeLabel"), tl: $("tl"), tlCanvas: $("tlCanvas"), tlHead: $("tlHead"),
  modeToggle: $("modeToggle"), holdCircles: $("holdCircles"), undoBtn: $("undoBtn"),
  countBtn: $("countBtn"), rateBtn: $("rateBtn"), detailBtn: $("detailBtn"),
  distDlg: $("distDlg"), distBody: $("distBody"), setDlg: $("setDlg"), libDlg: $("libDlg"),
  toast: $("toast"), countOverlay: $("countOverlay"), segChip: $("segChip"),
  memberEditor: $("memberEditor"), audioName: $("audioName"), audioHint: $("audioHint"),
};

/* ================= prefs ================= */
const prefs = Object.assign(
  { currentId: null, countIn: false, detail: false, miniHeadline: false, snap: false, mode: "create", rate: 1 },
  readJSON(PREFS_KEY));
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; } }
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

/* ================= project + persistence ================= */
let project = null;
let saveTimer = 0;
function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}
function flushSave() {
  if (!saveTimer || !project) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  project.updatedAt = Date.now();
  db.putProject(project).catch(() => toast("Couldn't save (storage full?)"));
}
function makeProject({ song, members, segments }) {
  const now = Date.now();
  return {
    id: uid() + now.toString(36),
    song: { group: "", title: "Untitled", artist: "", duration: 180, audioName: "", ...song },
    members, segments: segments || [], hasAudio: false, createdAt: now, updatedAt: now,
  };
}
function defaultBody() {
  return {
    song: { group: "My Group", title: "Untitled", artist: "" },
    members: ["A", "B", "C", "D", "E"].map((n, i) => ({ id: uid(), name: "Member " + n, color: PALETTE[i], avatar: null })),
    segments: [],
  };
}

/* segment index is rebuilt lazily after an edit */
let tracks = new Map(), tracksDirty = true;
function getTracks() {
  if (tracksDirty) { tracks = buildTracks(project.members, project.segments); tracksDirty = false; }
  return tracks;
}
function segmentsChanged() {
  tracksDirty = true;
  saveProject();
  drawTimeline();
  renderSegTracks();
  updateUndoBtn();
  requestRender();
}

/* ================= undo / redo ================= */
let undoStack = [], redoStack = [];
function commit(op) { undoStack.push(op); if (undoStack.length > 300) undoStack.shift(); redoStack = []; }
function applyOp(op, reverse) {
  if ((op.type === "add") !== reverse) project.segments.push(...op.segs);
  else { const gone = new Set(op.segs); project.segments = project.segments.filter(s => !gone.has(s)); }
}
function describeOp(op) {
  if (op.segs.length !== 1) return `${op.segs.length} segments`;
  const s = op.segs[0], m = memberById(s.memberId);
  return `${m ? m.name : "?"} (${(s.end - s.start).toFixed(1)}s at ${fmt(s.start)})`;
}
function undo() {
  if (holds.size || pending.size) { holds.clear(); pending.clear(); toast("Discarded the open hold"); requestRender(); updateUndoBtn(); return; }
  const op = undoStack.pop();
  if (!op) return;
  applyOp(op, true); redoStack.push(op);
  toast("Undid " + describeOp(op));
  segmentsChanged();
}
function redo() {
  const op = redoStack.pop();
  if (!op) return;
  applyOp(op, false); undoStack.push(op);
  toast("Redid " + describeOp(op));
  segmentsChanged();
}

/* ================= clock + audio ================= */
const audio = $("audio");
const clock = new Clock(audio);
let onsets = null, peaks = null, audioURL = null, analysisToken = 0;

/* ================= holds ================= */
const holds = new Map();   // memberId -> start time
const pending = new Set(); // pressed during count-in; started when the song starts
const memberById = id => project.members.find(m => m.id === id);

function press(id, e) {
  if (prefs.mode === "playback") return false;
  if (countingIn) { pending.add(id); requestRender(); return true; }
  if (!clock.playing) { toast("Press play first, then hold a member"); return false; }
  if (!holds.has(id)) holds.set(id, clock.atEvent(e));
  updateUndoBtn();
  requestRender();
  return true;
}
function release(id, e) {
  if (pending.delete(id)) requestRender();
  if (holds.has(id)) endHold(id, clock.atEvent(e));
}
function endHold(id, at) {
  const start = holds.get(id);
  holds.delete(id);
  const end = Math.max(start, at);
  if (end - start > 0.05) {
    let s = start, e = end;
    if (prefs.snap) {
      s = snapTo(onsets, start); e = snapTo(onsets, end);
      if (e - s < 0.1) { s = start; e = end; } // snapping collapsed the segment: keep raw times
    }
    const seg = { memberId: id, start: s, end: e };
    project.segments.push(seg);
    commit({ type: "add", segs: [seg] });
    segmentsChanged();
  } else {
    updateUndoBtn();
    requestRender();
  }
}
function endAllHolds(at) {
  pending.clear();
  for (const id of [...holds.keys()]) endHold(id, at);
}

/* ================= transport ================= */
let countingIn = false, countTimer = 0, actx = null;
function beep(freq) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq;
    o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.25, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.15);
    o.start(); o.stop(actx.currentTime + 0.16);
  } catch (e) {}
}
function showCount(n) {
  els.countOverlay.innerHTML = "<span>" + n + "</span>";
  els.countOverlay.classList.add("show");
}
function startPlayback() {
  clock.start(() => {
    holds.clear(); pending.clear();
    afterTransport();
    toast("The browser blocked playback. Tap play");
  });
  const t0 = clock.now();
  for (const id of pending) holds.set(id, t0);
  pending.clear();
  afterTransport();
}
function startCountIn() {
  countingIn = true;
  let n = 3;
  showCount(n); beep(660);
  countTimer = setInterval(() => {
    if (--n > 0) { showCount(n); beep(660); return; }
    clearInterval(countTimer);
    countingIn = false;
    els.countOverlay.classList.remove("show");
    beep(990);
    startPlayback();
  }, 1000);
  afterTransport();
}
function cancelCountIn() {
  clearInterval(countTimer);
  countingIn = false;
  pending.clear();
  els.countOverlay.classList.remove("show");
  afterTransport();
}
function play() {
  if (clock.now() >= clock.duration - 0.05) clock.seek(0);
  if (prefs.countIn) startCountIn(); else startPlayback();
}
function pause() {
  if (countingIn) { cancelCountIn(); return; }
  endAllHolds(clock.now());
  clock.stop();
  afterTransport();
}
const togglePlay = () => (clock.playing || countingIn) ? pause() : play();
function seekTo(t) {
  endAllHolds(clock.now());
  clock.seek(t);
  requestRender();
}
function afterTransport() {
  els.playBtn.textContent = (clock.playing || countingIn) ? "❚❚" : "▶";
  updateUndoBtn();
  updateWakeLock();
  updateMediaSession();
  requestRender();
}
// pause events from outside the app
audio.addEventListener("pause", () => {
  if (!clock.playing) return;
  endAllHolds(audio.ended ? clock.duration : clock.now());
  clock.playing = false;
  afterTransport();
});

/* ================= render loop ================= */
let rafId = 0;
function requestRender() { if (!rafId) rafId = requestAnimationFrame(frame); }
function frame() {
  rafId = 0;
  if (!project) return;
  render();
  if (clock.playing || countingIn || holds.size || pending.size || flipping) requestRender();
}

const rowEls = new Map();  // memberId -> cached row parts + last written values
const holdEls = new Map(); // memberId -> {btn, active}
const vals = new Map(), fulls = new Map();
let barW = 0, trackFrac = 0.78, tlWidth = 0, lastOrderKey = "", lastTime = "", flipping = false;

function setText(el, s) { if (el._t !== s) { el._t = s; el.textContent = s; } }

function render() {
  const dur = clock.duration;
  let t = clock.now();
  if (!clock.hasAudio && clock.playing && t >= dur) {
    endAllHolds(dur); clock.stop(); clock.seek(dur); t = dur; afterTransport();
  }
  const timeStr = fmt(t) + " / " + fmt(dur);
  if (timeStr !== lastTime) { lastTime = timeStr; els.timeLabel.textContent = timeStr; }
  if (tlWidth) els.tlHead.style.transform = `translateX(${(t / dur * tlWidth).toFixed(1)}px)`;

  const tr = getTracks();
  const playback = prefs.mode === "playback";
  let max = 0, maxFull = 0;
  for (const m of project.members) {
    const track = tr.get(m.id);
    const live = !playback && holds.has(m.id) ? Math.max(0, t - holds.get(m.id)) : 0;
    const v = playback ? track.upTo(t) : track.total + live;
    const full = track.total + live;
    vals.set(m.id, v); fulls.set(m.id, full);
    if (v > max) max = v;
    if (full > maxFull) maxFull = full;
  }

  for (const m of project.members) {
    const r = rowEls.get(m.id);
    const v = vals.get(m.id);
    const f = max > 0 ? v / max : 0;
    if (r.f !== f || r.bw !== barW) {
      r.f = f; r.bw = barW;
      r.bar.style.transform = `scaleX(${f})`;
      r.label.style.transform = `translateX(${(f * barW * trackFrac).toFixed(1)}px)`;
    }
    const s = v.toFixed(1);
    if (r.s !== s) { r.s = s; r.label.textContent = s + "s"; r.total.textContent = s; }

    const holding = holds.has(m.id) || pending.has(m.id);
    const active = playback ? clock.playing && tr.get(m.id).activeAt(t) : holding;
    if (r.active !== active) { r.active = active; r.row.classList.toggle("active", active); }
    const hb = holdEls.get(m.id);
    const hActive = !playback && holding;
    if (hb.active !== hActive) { hb.active = hActive; hb.btn.classList.toggle("active", hActive); }

    if (prefs.detail) renderDetailRow(m, r, t, maxFull, playback);
  }
  maybeReorder();
}

function renderDetailRow(m, r, t, maxFull, playback) {
  const w = maxFull > 0 ? (fulls.get(m.id) / maxFull * trackFrac * 100).toFixed(2) + "%" : "0%";
  if (r.trackW !== w) { r.trackW = w; r.segtrack.style.width = w; }
  for (const sub of r.subs) {
    const frac = t <= sub.start ? 0 : t >= sub.end ? 1 : Math.round((t - sub.start) / (sub.end - sub.start) * 500) / 500;
    if (sub.frac !== frac) { sub.frac = frac; sub.fill.style.transform = `scaleX(${frac})`; }
  }
  if (!playback && holds.has(m.id)) {
    if (!r.live) {
      r.live = document.createElement("div");
      r.live.className = "subseg live";
      r.live.innerHTML = "<i></i>";
      r.segtrack.appendChild(r.live);
    }
    r.live.style.flex = Math.max(0.05, t - holds.get(m.id)) + " 1 0px";
  } else if (r.live) { r.live.remove(); r.live = null; }
}

const order = [];
function maybeReorder() {
  order.length = 0;
  order.push(...project.members);
  order.sort((a, b) => vals.get(b.id) - vals.get(a.id)); // stable: ties keep roster order
  const key = order.map(m => m.id).join(",");
  if (key === lastOrderKey) return;
  const first = !lastOrderKey;
  lastOrderKey = key;
  const before = new Map();
  if (!first) for (const m of order) before.set(m.id, rowEls.get(m.id).row.getBoundingClientRect().top);
  for (const m of order) els.list.appendChild(rowEls.get(m.id).row);
  if (first || document.hidden) return;
  const moved = [];
  for (const m of order) {
    const row = rowEls.get(m.id).row;
    const dy = before.get(m.id) - row.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) { row.style.transition = "none"; row.style.transform = `translateY(${dy}px)`; moved.push(row); }
  }
  if (!moved.length) return;
  flipping = true;
  requestAnimationFrame(() => {
    for (const row of moved) { row.style.transition = "transform .45s cubic-bezier(.22,1,.36,1)"; row.style.transform = ""; }
    setTimeout(() => { flipping = false; }, 460);
  });
}

/* ================= timeline ================= */
function drawTimeline() {
  const c = els.tlCanvas, w = els.tl.clientWidth, h = els.tl.clientHeight;
  if (!w || !project) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const dur = clock.duration;

  if (peaks) {
    ctx.fillStyle = "rgba(17,17,17,.12)";
    const n = peaks.length;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(x / w * n), i1 = Math.max(i0 + 1, Math.floor((x + 1) / w * n));
      let m = 0;
      for (let i = i0; i < i1 && i < n; i++) if (peaks[i] > m) m = peaks[i];
      const ph = Math.max(1, m * (h - 4));
      ctx.fillRect(x, (h - ph) / 2, 1, ph);
    }
  }

  const tr = getTracks(), n = project.members.length, pad = 3;
  const laneH = (h - pad * 2) / Math.max(1, n);
  project.members.forEach((m, i) => {
    const track = tr.get(m.id);
    ctx.fillStyle = m.color;
    const y = pad + i * laneH;
    for (let k = 0; k < track.length; k++) {
      const x0 = track.starts[k] / dur * w, x1 = track.ends[k] / dur * w;
      ctx.fillRect(x0, y + 0.5, Math.max(1.5, x1 - x0), Math.max(1, laneH - 1));
    }
  });
}
function scrub(e) {
  const r = els.tl.getBoundingClientRect();
  seekTo((e.clientX - r.left) / r.width * clock.duration);
}
els.tl.addEventListener("pointerdown", e => { try { els.tl.setPointerCapture(e.pointerId); } catch (err) {} scrub(e); });
els.tl.addEventListener("pointermove", e => { if (els.tl.hasPointerCapture(e.pointerId)) scrub(e); });

new ResizeObserver(() => {
  tlWidth = els.tl.clientWidth;
  drawTimeline();
  requestRender();
}).observe(els.tl);
const barRO = new ResizeObserver(entries => {
  barW = entries[0].contentRect.width;
  trackFrac = parseFloat(getComputedStyle(entries[0].target).getPropertyValue("--track")) || 0.78;
  requestRender();
});

/* ================= member UI ================= */
function paintAvatar(el, m) {
  el.style.backgroundColor = m.color;
  if (m.avatar) {
    const img = new Image();
    img.decoding = "async"; img.alt = ""; img.draggable = false; img.src = m.avatar;
    el.replaceChildren(img);
  } else {
    el.replaceChildren(document.createTextNode((m.name.trim()[0] || "?").toUpperCase()));
  }
}

function renderMembers() {
  els.list.replaceChildren();
  els.holdCircles.replaceChildren();
  rowEls.clear(); holdEls.clear();
  const n = project.members.length;
  els.holdCircles.style.setProperty("--cols", n <= 6 ? n : Math.ceil(n / 2));
  barRO.disconnect();
  lastOrderKey = "";

  project.members.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="main">
        <div class="pill"><div class="avatar"></div><div class="name"></div></div>
        <div class="barwrap"><div class="bar"></div><span class="barlabel">0.0s</span><div class="segtrack"></div></div>
      </div>
      <div class="total">0.0</div>`;
    const r = {
      row,
      bar: row.querySelector(".bar"), label: row.querySelector(".barlabel"),
      total: row.querySelector(".total"), segtrack: row.querySelector(".segtrack"),
      subs: [], live: null,
    };
    row.querySelector(".name").textContent = m.name;
    paintAvatar(row.querySelector(".avatar"), m);
    rowEls.set(m.id, r);
    els.list.appendChild(row);
    if (i === 0) barRO.observe(row.querySelector(".barwrap"));

    const btn = document.createElement("button");
    btn.className = "holdbtn";
    btn.title = m.name + (i < 9 ? ` (hold ${i + 1})` : "");
    btn.innerHTML = `<div class="face"></div>${i < 9 ? `<kbd>${i + 1}</kbd>` : ""}`;
    paintAvatar(btn.querySelector(".face"), m);
    btn.addEventListener("contextmenu", e => e.preventDefault());
    btn.addEventListener("pointerdown", e => {
      e.preventDefault();
      if (press(m.id, e)) try { btn.setPointerCapture(e.pointerId); } catch (err) {}
    });
    const up = e => release(m.id, e);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    els.holdCircles.appendChild(btn);
    holdEls.set(m.id, { btn, active: false });
  });
  renderSegTracks();
  requestRender();
}

/* ================= segment detail view ================= */
function renderSegTracks() {
  if (!prefs.detail || !project) return;
  const tr = getTracks();
  for (const m of project.members) {
    const r = rowEls.get(m.id), track = tr.get(m.id);
    if (!r) continue;
    r.segtrack.replaceChildren();
    r.subs = []; r.live = null; r.trackW = null;
    for (let k = 0; k < track.length; k++) {
      const s = track.starts[k], e = track.ends[k];
      const el = document.createElement("div");
      el.className = "subseg";
      el.style.flex = (e - s) + " 1 0px";
      el.innerHTML = "<i></i>";
      el.dataset.mid = m.id; el.dataset.start = s; el.dataset.end = e;
      r.segtrack.appendChild(el);
      r.subs.push({ el, fill: el.firstChild, start: s, end: e, frac: -1 });
    }
  }
  requestRender();
}
function toggleDetail() {
  prefs.detail = !prefs.detail;
  savePrefs();
  applyPrefsUI();
  if (prefs.detail) renderSegTracks(); else hideSegChip();
  toast(prefs.detail ? "Segments shown. Tap one to play from there" : "Segment view off");
}

let chipSeg = null, chipTimer = 0;
function showSegChip(el) {
  hideSegChip();
  const mid = el.dataset.mid, start = +el.dataset.start, end = +el.dataset.end, m = memberById(mid);
  chipSeg = { mid, start, end, el };
  el.classList.add("sel");
  els.segChip.querySelector("span").textContent = `${m ? m.name : "?"} · ${fmt(start)}–${fmt(end)} (${(end - start).toFixed(1)}s)`;
  els.segChip.classList.add("show");
  chipTimer = setTimeout(hideSegChip, 6000);
}
function hideSegChip() {
  clearTimeout(chipTimer);
  if (chipSeg) chipSeg.el.classList.remove("sel");
  chipSeg = null;
  els.segChip.classList.remove("show");
}
$("segDelBtn").addEventListener("click", () => {
  if (!chipSeg) return;
  const { mid, start, end } = chipSeg;
  // a merged block holds every raw press inside its span; remove them all
  const segs = project.segments.filter(s => s.memberId === mid && s.start >= start - 0.01 && s.end <= end + 0.01);
  hideSegChip();
  if (!segs.length) return;
  const op = { type: "remove", segs };
  applyOp(op, false); commit(op);
  toast("Deleted " + describeOp(op) + ". Z to undo");
  segmentsChanged();
});
els.list.addEventListener("click", e => {
  const el = e.target.closest(".subseg");
  if (!el || el.classList.contains("live")) return;
  seekTo(+el.dataset.start);
  if (!clock.playing && !countingIn) startPlayback();
  showSegChip(el);
});

/* ================= song header ================= */
function renderSongMeta() {
  const s = project.song;
  els.songLabel.innerHTML = "<b></b> <span></span>";
  els.songLabel.querySelector("b").textContent = s.title;
  els.songLabel.querySelector("span").textContent = s.artist ? "– " + s.artist : "";
  els.headline.innerHTML = "How Would <b></b><br>Sing <b></b>?";
  const bs = els.headline.querySelectorAll("b");
  bs[0].textContent = s.group || "Us";
  bs[1].textContent = s.title + (s.artist ? " by " + s.artist : "");
  document.title = `${s.title} · Line Distribution`;
  lastTime = "";
}
function renderAudioHint() { els.audioHint.hidden = clock.hasAudio; }
function updateUndoBtn() { els.undoBtn.disabled = !undoStack.length && !holds.size && !pending.size; }
function applyPrefsUI() {
  els.modeToggle.checked = prefs.mode === "playback";
  document.body.classList.toggle("playback", prefs.mode === "playback");
  document.body.classList.toggle("detail", !!prefs.detail);
  document.body.classList.toggle("mini-headline", !!prefs.miniHeadline);
  els.countBtn.classList.toggle("on", !!prefs.countIn);
  els.detailBtn.classList.toggle("on", !!prefs.detail);
  els.rateBtn.textContent = prefs.rate + "×";
  els.rateBtn.classList.toggle("on", prefs.rate !== 1);
}
function renderAll() {
  renderSongMeta();
  renderMembers();
  applyPrefsUI();
  renderAudioHint();
  updateUndoBtn();
  afterTransport();
  drawTimeline();
}

/* ================= controls ================= */
els.playBtn.addEventListener("click", togglePlay);
$("back3Btn").addEventListener("click", () => seekTo(clock.now() - 3));
els.undoBtn.addEventListener("click", undo);
els.detailBtn.addEventListener("click", toggleDetail);
els.countBtn.addEventListener("click", () => {
  prefs.countIn = !prefs.countIn; savePrefs(); applyPrefsUI();
  toast(prefs.countIn ? "Count-in on: 3 beats before play" : "Count-in off");
});
els.rateBtn.addEventListener("click", () => {
  prefs.rate = RATES[(RATES.indexOf(prefs.rate) + 1) % RATES.length] || 1;
  clock.setRate(prefs.rate); savePrefs(); applyPrefsUI();
  toast(prefs.rate === 1 ? "Normal speed" : `${prefs.rate}× speed. Timings still land in song time`);
});
els.modeToggle.addEventListener("change", () => {
  endAllHolds(clock.now());
  prefs.mode = els.modeToggle.checked ? "playback" : "create";
  savePrefs(); applyPrefsUI(); requestRender();
});
els.headline.title = "Tap to shrink the title";
els.headline.addEventListener("click", () => {
  prefs.miniHeadline = !prefs.miniHeadline; savePrefs(); applyPrefsUI();
});
els.songLabel.addEventListener("click", openLibrary);
$("libBtn").addEventListener("click", openLibrary);
$("audioHintBtn").addEventListener("click", () => $("audioFile").click());

const typing = el => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
const keyHolds = new Map(); // key code -> memberId
document.addEventListener("keydown", e => {
  if (typing(e.target) || document.querySelector("dialog[open]")) return;
  if (e.metaKey || e.ctrlKey) {
    if (e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    return;
  }
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (digit) {
    e.preventDefault();
    if (e.repeat || keyHolds.has(e.code)) return;
    const m = project.members[+digit[1] - 1];
    if (m && press(m.id, e)) keyHolds.set(e.code, m.id);
    return;
  }
  switch (e.code) {
    case "Space": if (!e.repeat) togglePlay(); break;
    case "ArrowLeft": seekTo(clock.now() - 3); break;
    case "ArrowRight": seekTo(clock.now() + 3); break;
    case "KeyZ": e.shiftKey ? redo() : undo(); break;
    case "KeyD": toggleDetail(); break;
    default: return;
  }
  e.preventDefault();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
});
document.addEventListener("keyup", e => {
  const id = keyHolds.get(e.code);
  if (id) { keyHolds.delete(e.code); release(id, e); }
});
window.addEventListener("blur", () => {
  for (const id of keyHolds.values()) release(id);
  keyHolds.clear();
});

/* ================= distribution ================= */
$("distBtn").addEventListener("click", () => { renderDistribution(); els.distDlg.showModal(); });
$("distClose").addEventListener("click", () => els.distDlg.close());
function distRows() {
  const tr = getTracks();
  const rows = project.members.map(m => ({ m, t: tr.get(m.id).total })).sort((a, b) => b.t - a.t);
  return { rows, sum: rows.reduce((a, r) => a + r.t, 0) };
}
$("distCopy").addEventListener("click", () => {
  const { rows, sum } = distRows();
  const s = project.song;
  const lines = [`${s.group} · ${s.title}${s.artist ? " (" + s.artist + ")" : ""}`,
    ...rows.map(r => `${r.m.name}: ${r.t.toFixed(1)}s (${sum ? (r.t / sum * 100).toFixed(1) : 0}%)`)];
  navigator.clipboard.writeText(lines.join("\n")).then(() => toast("Copied"), () => toast("Couldn't copy"));
});
function arcPath(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1} Z`;
}
function renderDistribution() {
  const { rows, sum } = distRows();
  els.distBody.replaceChildren();
  if (sum <= 0) {
    els.distBody.innerHTML = "<p>No timings yet. Play the song in create mode and hold a member's button during their part.</p>";
    return;
  }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 240 240");
  svg.style.width = "min(64vw, 260px)";
  let a = -Math.PI / 2;
  for (const r of rows) {
    if (r.t <= 0) continue;
    const sweep = r.t / sum * Math.PI * 2;
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", sweep >= Math.PI * 2 - 0.001
      ? "M 120 8 A 112 112 0 1 1 119.99 8 Z"
      : arcPath(120, 120, 112, a, a + Math.max(0.0001, sweep - 0.02)));
    p.setAttribute("fill", r.m.color);
    svg.appendChild(p);
    a += sweep;
  }
  const c = document.createElementNS(NS, "circle");
  c.setAttribute("cx", 120); c.setAttribute("cy", 120); c.setAttribute("r", 32);
  c.setAttribute("fill", "#cbe94b"); c.setAttribute("stroke", "#fff"); c.setAttribute("stroke-width", 4);
  svg.appendChild(c);

  const legend = document.createElement("div");
  legend.id = "legend";
  for (const r of rows) {
    const d = document.createElement("div");
    d.className = "leg";
    d.style.color = r.m.color;
    d.innerHTML = `<div class="lav"></div><div><div class="lname"></div><div class="lnums"><span>${r.t.toFixed(2)}s</span><span>${(r.t / sum * 100).toFixed(2)}%</span></div></div>`;
    paintAvatar(d.querySelector(".lav"), r.m);
    d.querySelector(".lname").textContent = r.m.name.toUpperCase();
    legend.appendChild(d);
  }
  els.distBody.append(svg, legend);
}

/* ================= library ================= */
async function openLibrary() {
  flushSave();
  const all = (await db.allProjects().catch(() => [])).sort((a, b) => b.updatedAt - a.updatedAt);
  const list = $("libList");
  list.replaceChildren();
  for (const p of all) {
    const row = document.createElement("div");
    row.className = "librow" + (p.id === project.id ? " cur" : "");
    row.innerHTML = `<div class="libavs"></div><div class="meta"><div class="t"></div><div class="s"></div></div><button class="del" title="Delete song">✕</button>`;
    const avs = row.querySelector(".libavs");
    for (const m of p.members.slice(0, 6)) { const a = document.createElement("div"); a.className = "libav"; paintAvatar(a, m); avs.appendChild(a); }
    row.querySelector(".t").textContent = p.song.title;
    const segCount = p.segments.length;
    row.querySelector(".s").textContent = [p.song.group, p.song.artist && "orig. " + p.song.artist,
      p.hasAudio ? "♪ audio" : "no audio", segCount ? segCount + (segCount === 1 ? " part" : " parts") : "not started"].filter(Boolean).join(" · ");
    row.addEventListener("click", e => {
      if (e.target.closest(".del")) return;
      els.libDlg.close();
      if (p.id !== project.id) openProject(p.id);
    });
    row.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`Delete "${p.song.title}" and its timings? This can't be undone.`)) return;
      await db.deleteProject(p.id);
      if (p.id === project.id) {
        saveTimer = 0;
        const rest = all.filter(x => x.id !== p.id);
        if (rest.length) await openProject(rest[0].id);
        else { const np = makeProject(defaultBody()); await db.putProject(np); await openProject(np); }
      }
      openLibrary();
    });
    list.appendChild(row);
  }

  // rosters: the most recent song of each group
  const sel = $("newRoster");
  sel.replaceChildren();
  const seen = new Set();
  for (const p of all) {
    const g = p.song.group || "(no group)";
    if (seen.has(g)) continue;
    seen.add(g);
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${g}: ${p.members.map(m => m.name).join(", ")}`;
    if (g === (project.song.group || "(no group)")) o.selected = true;
    sel.appendChild(o);
  }
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = "Blank (5 placeholder members)";
  sel.appendChild(blank);
  $("newTitle").value = ""; $("newArtist").value = "";
  if (!els.libDlg.open) els.libDlg.showModal();
}
$("libClose").addEventListener("click", () => els.libDlg.close());
$("libImport").addEventListener("click", () => $("importFile").click());
$("newCreate").addEventListener("click", async () => {
  const src = $("newRoster").value ? await db.getProject($("newRoster").value) : null;
  const body = src
    ? { song: { group: src.song.group }, members: structuredClone(src.members), segments: [] }
    : defaultBody();
  body.song.title = $("newTitle").value.trim() || "Untitled";
  body.song.artist = $("newArtist").value.trim();
  const p = makeProject(body);
  await db.putProject(p);
  els.libDlg.close();
  await openProject(p);
  toast(`Created "${p.song.title}". Now load its audio`);
});

/* ================= settings ================= */
$("gearBtn").addEventListener("click", () => { renderSettings(); els.setDlg.showModal(); });
$("setClose").addEventListener("click", () => els.setDlg.close());
function renderSettings() {
  const s = project.song;
  $("setGroup").value = s.group; $("setTitle").value = s.title; $("setArtist").value = s.artist;
  $("setDur").value = fmt(clock.duration);
  $("setDur").disabled = clock.hasAudio;
  els.audioName.textContent = clock.hasAudio ? s.audioName : (s.audioName ? s.audioName + " (not loaded on this device)" : "none, timer only");
  $("setSnap").checked = !!prefs.snap;
  renderMemberEditor();
}
$("setSnap").addEventListener("change", () => { prefs.snap = $("setSnap").checked; savePrefs(); });
for (const id of ["setGroup", "setTitle", "setArtist"]) {
  $(id).addEventListener("input", () => {
    project.song.group = $("setGroup").value;
    project.song.title = $("setTitle").value;
    project.song.artist = $("setArtist").value;
    renderSongMeta(); updateMediaSession(); saveProject();
  });
}
$("setDur").addEventListener("change", () => {
  const v = parseDur($("setDur").value);
  if (v && v > 0) { project.song.duration = v; clock.fallbackDuration = v; saveProject(); drawTimeline(); requestRender(); }
  $("setDur").value = fmt(clock.duration);
});

let avatarTarget = null;
function renderMemberEditor() {
  els.memberEditor.replaceChildren();
  project.members.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "mrow";
    const av = document.createElement("button");
    av.className = "avbtn"; av.title = "Set photo";
    paintAvatar(av, m);
    av.addEventListener("click", () => { avatarTarget = m.id; $("avatarFile").click(); });
    const name = document.createElement("input");
    name.type = "text"; name.value = m.name;
    name.addEventListener("input", () => { m.name = name.value; renderMembers(); drawTimeline(); saveProject(); });
    const color = document.createElement("input");
    color.type = "color"; color.value = m.color;
    color.addEventListener("input", () => { m.color = color.value; renderMembers(); drawTimeline(); saveProject(); });
    const up = document.createElement("button");
    up.className = "up"; up.textContent = "↑"; up.title = "Move up (changes its number key)"; up.disabled = i === 0;
    up.addEventListener("click", () => {
      [project.members[i - 1], project.members[i]] = [project.members[i], project.members[i - 1]];
      tracksDirty = true; renderMembers(); renderMemberEditor(); drawTimeline(); saveProject();
    });
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕"; del.title = "Remove member";
    del.addEventListener("click", () => {
      if (!confirm(`Remove ${m.name} and their timings?`)) return;
      project.members = project.members.filter(x => x.id !== m.id);
      project.segments = project.segments.filter(s => s.memberId !== m.id);
      undoStack = []; redoStack = [];
      tracksDirty = true; renderMembers(); renderMemberEditor(); segmentsChanged();
    });
    row.append(av, name, color, up, del);
    els.memberEditor.appendChild(row);
  });
}
$("addMemberBtn").addEventListener("click", () => {
  project.members.push({ id: uid(), name: "New member", color: PALETTE[project.members.length % PALETTE.length], avatar: null });
  tracksDirty = true; renderMembers(); renderMemberEditor(); drawTimeline(); saveProject();
});
$("avatarFile").addEventListener("change", () => {
  const file = $("avatarFile").files[0];
  $("avatarFile").value = "";
  if (!file || !avatarTarget) return;
  const img = new Image();
  img.onload = () => {
    const size = 192, canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const s = Math.min(img.width, img.height);
    canvas.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
    URL.revokeObjectURL(img.src);
    const m = memberById(avatarTarget);
    if (m) { m.avatar = canvas.toDataURL("image/jpeg", 0.85); renderMembers(); renderMemberEditor(); saveProject(); }
  };
  img.src = URL.createObjectURL(file);
});

$("clearBtn").addEventListener("click", () => {
  if (!project.segments.length || !confirm("Clear all recorded timings for this song? (Z undoes it)")) return;
  const op = { type: "remove", segs: [...project.segments] };
  applyOp(op, false); commit(op);
  toast("Timings cleared");
  segmentsChanged();
});
$("exportBtn").addEventListener("click", () => {
  const { song, members, segments } = project;
  const data = { version: 2, song, members, segments, mode: prefs.mode };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${song.group}-${song.title}.linedist.json`.replace(/[\s/\\]+/g, "-").toLowerCase();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ================= audio loading + analysis ================= */
function detachAudio() {
  analysisToken++;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = null;
  clock.hasAudio = false;
  onsets = peaks = null;
}
function loadMeta(url) {
  return new Promise((res, rej) => {
    const off = () => { audio.removeEventListener("loadedmetadata", ok); audio.removeEventListener("error", bad); };
    const ok = () => { off(); res(); };
    const bad = () => { off(); rej(new Error("not audio")); };
    audio.addEventListener("loadedmetadata", ok);
    audio.addEventListener("error", bad);
    audio.src = url;
  });
}
async function attachAudio(blob, name, { persist = false, rec = null } = {}) {
  const p = project;
  if (clock.playing || countingIn) pause();
  detachAudio();
  const stored = persist
    ? blob.arrayBuffer().then(data => db.putAudio(p.id, { name, type: blob.type || "audio/mpeg", data }))
    : null;
  if (stored) stored.catch(() => {});
  if (persist) toast("Loading " + name + "…");
  audioURL = URL.createObjectURL(blob);
  try { await loadMeta(audioURL); }
  catch (e) {
    if (stored) stored.then(() => db.deleteAudio(p.id)).catch(() => {});
    if (project === p) { detachAudio(); renderAudioHint(); }
    toast(`Couldn't play "${name}". Is it an audio file?`);
    return;
  }
  if (project !== p) return; // switched songs while loading
  clock.hasAudio = true;
  clock.setRate(prefs.rate);
  clock.seek(0);
  p.song.audioName = name;
  p.song.duration = clock.fallbackDuration = audio.duration;
  if (persist && (!p.song.title || p.song.title === "Untitled")) p.song.title = name.replace(/\.[^.]+$/, "");
  if (persist) p.hasAudio = true;
  saveProject();
  renderSongMeta(); renderAudioHint(); updateMediaSession();
  if (els.setDlg.open) renderSettings();
  if (rec && rec.onsets && rec.peaks) { onsets = rec.onsets; peaks = rec.peaks; }
  else analyze(blob, p.id, stored || Promise.resolve());
  drawTimeline(); requestRender();
  if (persist) {
    toast("Audio loaded: " + name);
    stored.catch(() => toast("Audio won't survive a refresh (storage full?)"));
  }
}

// decode once, analyze in a worker, cache the results next to the audio
let worker = null, jobId = 0;
const jobs = new Map();
function analyze(blob, pid, stored) {
  const token = analysisToken;
  blob.arrayBuffer()
    .then(buf => new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf))
    .then(ab => {
      if (token !== analysisToken) return null;
      const channels = [];
      for (let c = 0; c < ab.numberOfChannels; c++) channels.push(ab.getChannelData(c).slice());
      if (!worker) {
        worker = new Worker(new URL("./analysis-worker.js", import.meta.url));
        worker.onmessage = e => { const j = jobs.get(e.data.id); if (j) { jobs.delete(e.data.id); j(e.data); } };
      }
      const id = ++jobId;
      return new Promise(res => {
        jobs.set(id, res);
        worker.postMessage({ id, channels, sampleRate: ab.sampleRate }, channels.map(c => c.buffer));
      });
    })
    .then(r => {
      if (!r) return;
      stored.then(() => db.getAudio(pid))
        .then(rec => rec && db.putAudio(pid, { ...rec, onsets: r.onsets, peaks: r.peaks }))
        .catch(() => {});
      if (token !== analysisToken) return;
      onsets = r.onsets; peaks = r.peaks;
      drawTimeline();
    })
    .catch(() => {});
}

// iOS: remove the accept filter and validate the pick by loading it
if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
  $("audioFile").removeAttribute("accept");
}
$("loadAudioBtn").addEventListener("click", () => $("audioFile").click());
$("audioFile").addEventListener("change", () => {
  const f = $("audioFile").files[0];
  $("audioFile").value = "";
  if (f) attachAudio(f, f.name, { persist: true });
});

/* ================= import / drag-and-drop ================= */
async function importFiles(files) {
  let last = null, bad = 0;
  for (const f of files) {
    try {
      const p = makeProject(normalizeImport(JSON.parse(await f.text())));
      await db.putProject(p);
      last = p;
    } catch (e) { bad++; }
  }
  if (last) {
    if (els.libDlg.open) els.libDlg.close();
    await openProject(last);
    toast(files.length - bad > 1 ? `Imported ${files.length - bad} songs` : `Imported "${last.song.title}"`);
  }
  if (bad) toast(`Couldn't read ${bad} file${bad > 1 ? "s" : ""}`);
  return last;
}
$("importFile").addEventListener("change", () => {
  const files = [...$("importFile").files];
  $("importFile").value = "";
  if (files.length) importFiles(files);
});
const isAudio = f => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(f.name);
const isJSON = f => f.type === "application/json" || /\.json$/i.test(f.name);
let dragDepth = 0;
window.addEventListener("dragenter", e => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", async e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const files = [...e.dataTransfer.files];
  const json = files.filter(isJSON), aud = files.find(isAudio);
  if (json.length) await importFiles(json);
  if (aud) attachAudio(aud, aud.name, { persist: true });
});

/* ================= media session + wake lock ================= */
function updateMediaSession() {
  if (!("mediaSession" in navigator) || !project) return;
  try {
    const s = project.song;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title, artist: [s.group, s.artist && "orig. " + s.artist].filter(Boolean).join(" · "), album: "Line Distribution",
    });
    navigator.mediaSession.playbackState = clock.playing ? "playing" : "paused";
  } catch (e) {}
}
if ("mediaSession" in navigator) {
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) {} };
  set("play", () => { if (!clock.playing) play(); });
  set("pause", () => { if (clock.playing || countingIn) pause(); });
  set("seekbackward", () => seekTo(clock.now() - 3));
  set("seekforward", () => seekTo(clock.now() + 3));
}
let wakeLock = null;
async function updateWakeLock() {
  try {
    if (clock.playing && !wakeLock && navigator.wakeLock && !document.hidden) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!clock.playing && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushSave();
  else { requestRender(); updateWakeLock(); }
});
window.addEventListener("pagehide", flushSave);

/* ================= toast ================= */
let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

/* ================= open / boot ================= */
async function openProject(p) {
  if (typeof p === "string") p = await db.getProject(p);
  if (!p) return;
  flushSave();
  if (countingIn) cancelCountIn();
  holds.clear(); pending.clear(); keyHolds.clear();
  if (clock.playing) clock.stop();
  detachAudio();
  hideSegChip();
  project = p;
  prefs.currentId = p.id; savePrefs();
  undoStack = []; redoStack = [];
  tracksDirty = true;
  clock.fallbackDuration = p.song.duration || 180;
  clock.seek(0);
  renderAll();
  const rec = await db.getAudio(p.id).catch(() => null);
  if (rec && project === p) {
    const blob = rec.blob || new Blob([rec.data], { type: rec.type || "audio/mpeg" });
    await attachAudio(blob, rec.name, { rec });
  }
}

// first launch on an origin that ran v1: import its song and audio
async function migrateV1() {
  const old = readJSON("line-dist-v1");
  if (!old || !old.members || !old.song) return null;
  try {
    const p = makeProject(normalizeImport(old));
    const rec = await readV1Audio();
    if (rec && rec.blob && rec.name === p.song.audioName) {
      await db.putAudio(p.id, { name: rec.name, blob: rec.blob });
      p.hasAudio = true;
    }
    await db.putProject(p);
    return p;
  } catch (e) { return null; }
}

async function boot() {
  applyPrefsUI();
  clock.setRate(prefs.rate);
  let all = [];
  try { all = await db.allProjects(); } catch (e) { toast("Storage unavailable: changes won't be saved"); }
  if (!all.length) { const m = await migrateV1(); if (m) all = [m]; }
  let p = all.find(x => x.id === prefs.currentId) || all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!p) { p = makeProject(defaultBody()); db.putProject(p).catch(() => {}); }
  await openProject(p);
}
boot();

// service worker, except on localhost
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// debugging / automation hook
window.lineDist = { get project() { return project; }, clock, openProject, importFiles, attachAudio, db };
