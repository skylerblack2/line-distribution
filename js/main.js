import { SegIndex, addSegment, removeSegment, resizeSegment, normalize } from "./segments.js";
import { openStore, peaksCache, slug } from "./store.js";
import { Player } from "./player.js";
import { Timeline, computePeaks } from "./timeline.js";
import { Studio } from "./studio.js";

const $ = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 9);
const PALETTE = ["#6666e0", "#f4547c", "#f79422", "#66b466", "#bd7ee8", "#e05656", "#4bb8c9", "#c9a227", "#8a6d5a"];
const RATES = [1, 0.75, 0.5];
const PLAY_ICON = '<svg viewBox="0 0 20 20"><path d="M6 3.5v13l11-6.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 20 20"><rect x="4" y="3" width="4.5" height="14" rx="1"/><rect x="11.5" y="3" width="4.5" height="14" rx="1"/></svg>';

const prefs = Object.assign(
  { mode: "create", countIn: false, lanes: true, miniHeadline: false, rate: 1, aiVocals: true, current: null },
  JSON.parse(localStorage.getItem("ld2.prefs") || "{}"));
const savePrefs = () => localStorage.setItem("ld2.prefs", JSON.stringify(prefs));

let store = null;
let project = null;
let projectId = null;
let loadToken = 0;
const index = new SegIndex();
const holds = new Map();
const pendingHolds = new Set();
const presses = new Map();
const TAP_MS = 250;
let latched = null;
let playRefused = false;
let undoStack = [], redoStack = [];
let selected = null;
let trimBase = null;

const els = {
  list: $("list"), holdCircles: $("holdCircles"), timeLabel: $("timeLabel"), playBtn: $("playBtn"),
  toast: $("toast"), segChip: $("segChip"), countOverlay: $("countOverlay"),
  setDlg: $("setDlg"), distDlg: $("distDlg"), libDlg: $("libDlg"), aiChip: $("aiChip"),
  dockPlay: $("dockPlay"), dockTime: $("dockTime"), nowStrip: $("nowStrip"),
};

/* ================= helpers ================= */
function fmt(t) {
  t = Math.max(0, Math.floor(t));
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
}
function fmtFine(t) {
  const s = Math.max(0, t);
  return Math.floor(s / 60) + ":" + (s % 60).toFixed(1).padStart(4, "0");
}
function parseDur(str) {
  str = String(str).trim();
  if (/^\d+:\d{1,2}$/.test(str)) { const [m, s] = str.split(":").map(Number); return m * 60 + s; }
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
}
function styleAvatar(el, m) {
  if (m.avatar) { el.style.backgroundImage = `url(${m.avatar})`; el.style.backgroundColor = ""; el.textContent = ""; }
  else { el.style.backgroundImage = ""; el.style.backgroundColor = m.color; el.textContent = (m.name[0] || "?").toUpperCase(); }
}
const memberById = id => project.members.find(m => m.id === id);
const typing = e => {
  const t = e.target;
  if (!t || !t.closest || t.closest("dialog:not([open])")) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
};
const dialogOpen = () => els.setDlg.open || els.distDlg.open || els.libDlg.open;

/* ================= player + studio + timeline ================= */
const player = new Player($("audio"), {
  onState: () => {
    els.playBtn.innerHTML = els.dockPlay.innerHTML = player.playing || countingIn ? PAUSE_ICON : PLAY_ICON;
    syncWakeLock();
    requestRender();
  },
  onEnded: at => endAllHolds(at === undefined ? player.duration : at),
});

const studio = new Studio({
  project: () => project,
  index: () => index,
  mode: () => prefs.mode,
  aiVocals: () => prefs.aiVocals,
  toast,
  retarget: fn => player.retarget(fn),
  onChange: updateAiChip,
  onConnect: () => {
    if (currentAudio) studio.uploadAudio(currentAudio.blob, currentAudio.name);
    else studio.syncState();
  },
});
player.alt = studio.stems;

const timeline = new Timeline($("timeline"), {
  members: () => (project ? project.members : []),
  index: () => index,
  holds: () => holds,
  selected: () => selected,
  duration: () => player.duration,
  styleAvatar,
  requestRender,
  seek: t => seekTo(t),
  select,
  pickSegment: seg => {
    select(seg);
    seekTo(seg.start);
    if (!player.playing && !countingIn) startPlayback();
  },
  trimStart: seg => { trimBase = project.segments; select(seg); },
  trim: (seg, start, end) => {
    const r = resizeSegment(project.segments, seg, start, end, player.duration);
    project.segments = r.segments;
    selected = r.seg;
    segsChanged(false);
    return r.seg;
  },
  trimEnd: () => {
    if (trimBase && trimBase !== project.segments) { pushUndo(trimBase); save(); }
    trimBase = null;
  },
});

/* ================= persistence ================= */
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
  studio.syncState();
}
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!project) return;
  store.save(projectId, project).catch(() => toast("Couldn't save"));
}
addEventListener("pagehide", () => { if (saveTimer) flushSave(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (saveTimer) flushSave(); }
  else timeline.repaint();
  syncWakeLock();
});

function blankProject(song, members) {
  return {
    song: Object.assign({ group: "", title: "", artist: "", duration: 180, audioName: "" }, song),
    members: members || ["A", "B", "C", "D", "E"].map((n, i) => ({ id: uid(), name: "Member " + n, color: PALETTE[i], avatar: null })),
    segments: [],
    voices: {},
  };
}
function sanitize(data) {
  const p = blankProject(data.song, (data.members || []).map((m, i) => ({
    id: m.id || uid(), name: String(m.name || ""), color: m.color || PALETTE[i % PALETTE.length], avatar: m.avatar || null,
  })));
  const ids = new Set(p.members.map(m => m.id));
  p.segments = normalize((data.segments || []).filter(s => ids.has(s.memberId) && s.end > s.start));
  p.voices = data.voices || {};
  p.song.duration = +p.song.duration || 180;
  return p;
}
async function uniqueId(base) {
  const taken = new Set((await store.list()).map(p => p.id));
  base = slug(base) || "song";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

let currentAudio = null;
async function openProject(id) {
  if (project && saveTimer) flushSave();
  const data = await store.load(id);
  if (!data) return false;
  const token = ++loadToken;
  pauseAll();
  player.clearAudio();
  currentAudio = null;
  project = sanitize(data);
  projectId = id;
  prefs.current = id;
  savePrefs();
  history.replaceState(null, "", "#" + id);
  undoStack = [];
  redoStack = [];
  selected = null;
  player.manualDuration = project.song.duration;
  timeline.setPeaks(null);
  renderAll();
  if (!project.song.audioName) return true;
  const blob = await store.getAudio(id).catch(() => null);
  if (blob && token === loadToken) await attachAudio(blob, project.song.audioName || "audio", false);
  return true;
}
async function createProject(song, members, extra) {
  const p = Object.assign(blankProject(song, members), extra);
  const id = await uniqueId(`${p.song.group}-${p.song.title}`);
  await store.save(id, p);
  await openProject(id);
}

async function attachAudio(blob, name, persist) {
  const token = loadToken;
  pauseAll();
  try { await player.setAudio(blob); }
  catch (e) { toast(`Couldn't play "${name}"`); renderSongMeta(); return; }
  if (token !== loadToken) return;
  currentAudio = { blob, name };
  project.song.audioName = name;
  project.song.duration = player.duration;
  seekTo(0);
  renderSongMeta();
  timeline.resetView();
  if (els.setDlg.open) renderSettings();
  if (persist) {
    save();
    store.putAudio(projectId, name, blob).catch(() => toast("Audio won't survive a refresh"));
    toast("Audio loaded: " + name);
  }
  studio.uploadAudio(blob, name);
  const key = `rms:${name}:${blob.size}`;
  let peaks = await peaksCache.get(key);
  if (!peaks) {
    try { peaks = await computePeaks(blob); peaksCache.set(key, peaks); } catch (e) { peaks = null; }
  }
  if (token === loadToken) timeline.setPeaks(peaks);
}

/* ================= segments + history ================= */
function segsChanged(persist = true) {
  index.rebuild(project.members, project.segments);
  if (selected && !project.segments.includes(selected)) selected = null;
  renderSegChip();
  updateHistoryBtns();
  timeline.invalidate();
  if (persist) save();
}
function pushUndo(prev) {
  undoStack.push(prev);
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  updateHistoryBtns();
}
function commit(next) {
  if (next === project.segments) return;
  pushUndo(project.segments);
  project.segments = next;
  segsChanged();
}
function describeChange(a, b) {
  const gone = a.find(s => !b.includes(s)), came = b.find(s => !a.includes(s));
  const s = came || gone;
  if (!s) return "";
  const m = memberById(s.memberId);
  return `${m ? m.name : "?"} at ${fmt(s.start)}`;
}
function undo() {
  if (holds.size) endAllHolds();
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  redoStack.push(project.segments);
  toast("Undid " + describeChange(project.segments, prev));
  project.segments = prev;
  segsChanged();
}
function redo() {
  if (!redoStack.length) return;
  const next = redoStack.pop();
  undoStack.push(project.segments);
  toast("Redid " + describeChange(project.segments, next));
  project.segments = next;
  segsChanged();
}
// Undoes the last change and, if that removed a segment, replays from just before it.
function retake() {
  endAllHolds();
  if (!undoStack.length) return;
  const before = project.segments;
  undo();
  const removed = before.find(s => !project.segments.includes(s));
  if (removed) seekTo(Math.max(0, removed.start - 1.5));
}
function updateHistoryBtns() {
  $("undoBtn").disabled = $("retakeBtn").disabled = !undoStack.length && !holds.size;
  $("redoBtn").disabled = !redoStack.length;
}

function select(seg) {
  if (selected === seg) return;
  selected = seg;
  renderSegChip();
  timeline.invalidate();
}
function renderSegChip() {
  els.segChip.classList.toggle("show", !!selected);
  if (!selected) return;
  const m = memberById(selected.memberId);
  els.segChip.querySelector("span").textContent =
    `${m ? m.name : "?"} · ${fmtFine(selected.start)}–${fmtFine(selected.end)} (${(selected.end - selected.start).toFixed(1)}s)`;
}
function deleteSelected() {
  if (!selected) return;
  const m = memberById(selected.memberId);
  toast(`Deleted ${m ? m.name : ""} ${fmt(selected.start)}–${fmt(selected.end)}`);
  commit(removeSegment(project.segments, selected));
}
$("segDelBtn").addEventListener("click", deleteSelected);

/* ================= holds ================= */
function startHold(id, timeStamp) {
  if (prefs.mode === "playback" || holds.has(id) || pendingHolds.has(id)) return;
  if (!player.playing) {
    pendingHolds.add(id);
    if (!countingIn) play();
  } else holds.set(id, player.at(timeStamp));
  updateHistoryBtns();
  timeline.invalidate();
}
function endHold(id, at) {
  pendingHolds.delete(id);
  if (latched === id) latched = null;
  if (!holds.has(id)) { requestRender(); return; }
  const start = holds.get(id);
  holds.delete(id);
  commit(addSegment(project.segments, id, start, at));
  updateHistoryBtns();
  timeline.invalidate();
}
// A short tap latches a member until another tap; a longer press records only while held.
function padDown(id, e) {
  if (prefs.mode === "playback") return;
  if (latched === id) {
    endHold(id, player.at(e.timeStamp));
    presses.set(e.pointerId, { id, done: true });
    return;
  }
  presses.set(e.pointerId, { id, down: e.timeStamp, prev: latched });
  startHold(id, e.timeStamp);
}
function padUp(e, cancelled) {
  const p = presses.get(e.pointerId);
  presses.delete(e.pointerId);
  if (!p || p.done) return;
  const tap = !cancelled && e.timeStamp - p.down < TAP_MS;
  if (!tap) endHold(p.id, player.at(e.timeStamp));
  else {
    if (p.prev && p.prev !== p.id && latched === p.prev) {
      endHold(p.prev, holds.has(p.id) ? holds.get(p.id) : player.now());
    }
    latched = p.id;
  }
  if ((tap || playRefused) && !player.playing && !countingIn) play();
  requestRender();
}
function endAllHolds(at = player.now()) {
  pendingHolds.clear();
  latched = null;
  for (const id of [...holds.keys()]) endHold(id, at);
}

/* ================= transport ================= */
let countingIn = false, countTimer = null, beepCtx = null;
function beep(freq) {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (beepCtx.state === "suspended") beepCtx.resume();
    const o = beepCtx.createOscillator(), g = beepCtx.createGain();
    o.frequency.value = freq;
    o.connect(g);
    g.connect(beepCtx.destination);
    g.gain.setValueAtTime(0.25, beepCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, beepCtx.currentTime + 0.15);
    o.start();
    o.stop(beepCtx.currentTime + 0.16);
  } catch (e) {}
}
function showCount(n) {
  els.countOverlay.innerHTML = "<span>" + n + "</span>";
  els.countOverlay.classList.add("show");
}
let startingPlayback = false;
async function startPlayback() {
  if (startingPlayback) return;
  startingPlayback = true;
  const ok = await player.play();
  startingPlayback = false;
  playRefused = !ok;
  if (!ok) return;
  const t0 = player.now();
  for (const id of pendingHolds) holds.set(id, t0);
  pendingHolds.clear();
  updateHistoryBtns();
  timeline.invalidate();
}
function startCountIn() {
  countingIn = true;
  player.onState();
  let n = 3;
  showCount(n);
  beep(660);
  countTimer = setInterval(() => {
    n--;
    if (n > 0) { showCount(n); beep(660); return; }
    clearInterval(countTimer);
    countingIn = false;
    els.countOverlay.classList.remove("show");
    beep(990);
    startPlayback();
  }, 1000);
}
function cancelCountIn() {
  clearInterval(countTimer);
  countingIn = false;
  pendingHolds.clear();
  els.countOverlay.classList.remove("show");
  player.onState();
}
function play() {
  if (prefs.countIn && prefs.mode === "create") startCountIn();
  else startPlayback();
}
function pauseAll() {
  if (countingIn) { cancelCountIn(); return; }
  endAllHolds();
  if (player.playing) player.pause();
}
function togglePlay() { player.playing || countingIn ? pauseAll() : play(); }
function seekTo(t) {
  endAllHolds();
  player.seek(t);
  requestRender();
}

els.playBtn.addEventListener("click", togglePlay);
els.dockPlay.addEventListener("click", togglePlay);
$("retakeBtn").addEventListener("click", retake);
$("back3Btn").addEventListener("click", () => seekTo(player.now() - 3));
$("undoBtn").addEventListener("click", undo);
$("redoBtn").addEventListener("click", redo);
$("countBtn").addEventListener("click", () => {
  prefs.countIn = !prefs.countIn;
  savePrefs();
  applyPrefs();
});
$("rateBtn").addEventListener("click", () => {
  prefs.rate = RATES[(RATES.indexOf(prefs.rate) + 1) % RATES.length];
  savePrefs();
  applyPrefs();
});
$("lanesBtn").addEventListener("click", () => {
  prefs.lanes = !prefs.lanes;
  if (!prefs.lanes) select(null);
  savePrefs();
  applyPrefs();
});
$("modeToggle").addEventListener("change", () => {
  endAllHolds();
  if (countingIn) cancelCountIn();
  player.retarget(() => { prefs.mode = $("modeToggle").checked ? "playback" : "create"; }, prefs.mode === "create");
  savePrefs();
  applyPrefs();
});
els.aiChip.addEventListener("click", () => {
  if (!studio.stems.ready) { toast("AI vocals not ready yet"); return; }
  player.retarget(() => { prefs.aiVocals = !prefs.aiVocals; });
  savePrefs();
  updateAiChip();
  toast(prefs.aiVocals ? "Playback uses AI vocals" : "Playback uses original audio");
});
$("headline").addEventListener("click", () => {
  prefs.miniHeadline = !prefs.miniHeadline;
  savePrefs();
  applyPrefs();
});

function applyPrefs() {
  $("modeToggle").checked = prefs.mode === "playback";
  document.body.classList.toggle("playback", prefs.mode === "playback");
  document.body.classList.toggle("mini-headline", prefs.miniHeadline);
  $("countBtn").classList.toggle("on", prefs.countIn);
  $("lanesBtn").classList.toggle("on", prefs.lanes);
  $("rateBtn").textContent = prefs.rate + "×";
  $("rateBtn").classList.toggle("on", prefs.rate !== 1);
  player.setRate(prefs.rate);
  timeline.setLanes(prefs.lanes);
  updateAiChip();
  if (project) measure();
  requestRender();
}
function updateAiChip() {
  const label = studio.chipLabel();
  els.aiChip.hidden = !label;
  if (!label) return;
  els.aiChip.textContent = label;
  els.aiChip.classList.toggle("on", label === "AI ✓");
}

/* ================= phone integration ================= */
let wakeLock = null;
async function syncWakeLock() {
  if (!("wakeLock" in navigator)) return;
  const want = (player.playing || countingIn) && !document.hidden;
  if (want && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (e) {}
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
function updateMediaSession() {
  if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: project.song.title, artist: project.song.group,
    artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
  });
}
if ("mediaSession" in navigator) {
  const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {} };
  on("play", () => { if (!player.playing && !countingIn) play(); });
  on("pause", () => pauseAll());
  on("seekbackward", () => seekTo(player.now() - 3));
  on("seekforward", () => seekTo(player.now() + 3));
}
document.addEventListener("gesturestart", e => e.preventDefault());

/* ================= keyboard ================= */
const keyHolds = new Map();
function keyMember(e) {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  return m && project ? project.members[+m[1] - 1] : null;
}
document.addEventListener("keydown", e => {
  if (typing(e) || dialogOpen() || !project) return;
  const mod = e.ctrlKey || e.metaKey;
  const km = keyMember(e);
  if (km && !mod && !e.altKey) {
    e.preventDefault();
    if (!e.repeat && !keyHolds.has(e.code)) { keyHolds.set(e.code, km.id); startHold(km.id, e.timeStamp); }
    return;
  }
  if (e.code === "Space") {
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (!e.repeat) togglePlay();
  } else if (mod && e.code === "KeyZ") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.code === "KeyY") { e.preventDefault(); redo(); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); seekTo(player.now() - (e.shiftKey ? 1 : 3)); }
  else if (e.code === "ArrowRight") { e.preventDefault(); seekTo(player.now() + (e.shiftKey ? 1 : 3)); }
  else if ((e.code === "Delete" || e.code === "Backspace") && selected) { e.preventDefault(); deleteSelected(); }
  else if (e.code === "Escape") select(null);
});
document.addEventListener("keyup", e => {
  const id = keyHolds.get(e.code);
  if (!id) return;
  keyHolds.delete(e.code);
  endHold(id, player.at(e.timeStamp));
});
addEventListener("blur", () => {
  for (const id of keyHolds.values()) endHold(id, player.now());
  keyHolds.clear();
});

/* ================= member rows ================= */
const rows = new Map();
const holdBtns = new Map();
let rowH = 110, trackW = 0;

function renderMembers() {
  els.list.textContent = "";
  els.holdCircles.textContent = "";
  els.list.classList.remove("ready");
  rows.clear();
  holdBtns.clear();
  project.members.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div>
        <div class="pill"><div class="avatar"></div><div class="name"></div></div>
        <div class="bartrack"><div class="barclip"><div class="bar"></div></div><span class="barlabel">0.0s</span></div>
      </div>
      <div class="total">0.0</div>`;
    const r = {
      row, bar: row.querySelector(".bar"), label: row.querySelector(".barlabel"), total: row.querySelector(".total"),
      frac: -1, text: "", active: false, rank: -1,
    };
    row.style.setProperty("--mc", m.color);
    row.querySelector(".name").textContent = m.name;
    styleAvatar(row.querySelector(".avatar"), m);
    rows.set(m.id, r);
    els.list.appendChild(row);

    const wrap = document.createElement("div");
    wrap.className = "holdwrap";
    wrap.style.setProperty("--mc", m.color);
    const btn = document.createElement("button");
    btn.className = "holdbtn";
    btn.title = m.name;
    const face = document.createElement("span");
    face.className = "face";
    styleAvatar(face, m);
    btn.appendChild(face);
    btn.addEventListener("contextmenu", e => e.preventDefault());
    btn.addEventListener("pointerdown", e => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      padDown(m.id, e);
    });
    btn.addEventListener("pointerup", e => padUp(e, false));
    btn.addEventListener("pointercancel", e => padUp(e, true));
    wrap.appendChild(btn);
    if (i < 9) { const k = document.createElement("kbd"); k.textContent = i + 1; wrap.appendChild(k); }
    els.holdCircles.appendChild(wrap);
    holdBtns.set(m.id, { btn, active: false });
  });
  measure();
}
// Sizes rows to fit the window height on wide screens, then caches the geometry render() needs.
function measure() {
  const root = document.documentElement.style, n = project.members.length;
  const phone = innerWidth <= 560;
  if (phone !== timeline.compact) timeline.setCompact(phone);
  els.holdCircles.style.setProperty("--cols", n <= 4 ? n : Math.ceil(n / 2));
  if (phone && n) {
    const per = Math.max(30, Math.min(92, els.list.clientHeight / n));
    root.setProperty("--rowh", per + "px");
    root.setProperty("--av", Math.max(22, Math.min(60, per - 10)) + "px");
  } else if (n) {
    const per = Math.max(78, Math.min(110, (innerHeight - els.list.offsetTop - 98) / n));
    const av = Math.max(36, Math.min(56, per - 54));
    root.setProperty("--rowh", per + "px");
    root.setProperty("--av", av + "px");
    root.setProperty("--barleft", av + 14 + "px");
  } else for (const v of ["--rowh", "--av", "--barleft"]) root.removeProperty(v);
  rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rowh")) || 110;
  els.list.style.height = phone ? "" : n * rowH + "px";
  const track = els.list.querySelector(".bartrack");
  trackW = track ? track.clientWidth : 0;
  for (const r of rows.values()) { r.frac = -1; r.rank = -1; }
  requestRender();
}
new ResizeObserver(() => { if (project) measure(); }).observe(els.list);
addEventListener("resize", () => { if (project) measure(); });

/* ================= render loop ================= */
let rafId = 0, lastTime = "", lastNow = "";
const order = [];
function requestRender() { if (!rafId) rafId = requestAnimationFrame(frame); }
function frame() {
  rafId = 0;
  if (!project) return;
  render();
  if (player.playing || countingIn || holds.size) requestRender();
}
function render() {
  player.poll();
  const t = player.now();
  const label = fmt(t) + " / " + fmt(player.duration);
  if (label !== lastTime) els.timeLabel.textContent = els.dockTime.textContent = lastTime = label;

  const playback = prefs.mode === "playback";
  let max = 0;
  order.length = 0;
  for (const m of project.members) {
    let v;
    if (playback) v = index.upTo(m.id, t);
    else v = index.total(m.id) + (holds.has(m.id) ? Math.max(0, t - holds.get(m.id)) : 0);
    if (v > max) max = v;
    order.push({ m, v });
  }
  for (const o of order) {
    const r = rows.get(o.m.id);
    const frac = max > 0 ? Math.round(o.v / max * 2000) / 2000 : 0;
    if (frac !== r.frac) {
      r.frac = frac;
      r.bar.style.transform = `translateX(${(frac - 1) * 100}%)`;
      r.label.style.transform = `translateX(${frac * trackW + (frac ? 8 : 0)}px)`;
    }
    const text = o.v.toFixed(1);
    if (text !== r.text) { r.text = text; r.label.textContent = text + "s"; r.total.textContent = text; }
    const held = holds.has(o.m.id) || pendingHolds.has(o.m.id);
    const active = playback ? player.playing && index.activeAt(o.m.id, t) : held;
    if (active !== r.active) { r.active = active; r.row.classList.toggle("active", active); }
    const hb = holdBtns.get(o.m.id);
    if (hb.active !== (held && !playback)) { hb.active = held && !playback; hb.btn.classList.toggle("active", hb.active); }
  }
  const live = project.members.filter(m => holds.has(m.id) || pendingHolds.has(m.id));
  let now = live.map(m => m.name).join(" + ");
  if (live.length === 1 && holds.has(live[0].id)) now += " " + Math.max(0, t - holds.get(live[0].id)).toFixed(1) + "s";
  const nowColor = live.length === 1 ? live[0].color : "";
  if (now !== lastNow) {
    els.nowStrip.textContent = lastNow = now;
    els.nowStrip.style.color = nowColor;
  }
  order.sort((a, b) => b.v - a.v);
  order.forEach((o, rank) => {
    const r = rows.get(o.m.id);
    if (r.rank !== rank) { r.rank = rank; r.row.style.transform = `translateY(${rank * rowH}px)`; }
  });
  if (!els.list.classList.contains("ready")) requestAnimationFrame(() => els.list.classList.add("ready"));
  timeline.frame(t, player.playing);
}

/* ================= header ================= */
function renderSongMeta() {
  const s = project.song;
  $("songTitle").textContent = s.title;
  $("songArtist").textContent = s.artist ? " – " + s.artist : "";
  $("headline").innerHTML = "How Would <b></b> <br>Sing <b></b>?";
  const bs = $("headline").querySelectorAll("b");
  bs[0].textContent = s.group;
  bs[1].textContent = s.title + (s.artist ? " by " + s.artist : "");
  document.title = `${s.group} · ${s.title}`;
  updateMediaSession();
  lastTime = "";
  requestRender();
}
function renderAll() {
  index.rebuild(project.members, project.segments);
  renderSongMeta();
  renderMembers();
  renderSegChip();
  updateHistoryBtns();
  timeline.resetView();
  timeline.layout();
  player.onState();
}

/* ================= distribution ================= */
$("distBtn").addEventListener("click", () => { renderDistribution(); els.distDlg.showModal(); });
$("distClose").addEventListener("click", () => els.distDlg.close());
function arcPath(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1} Z`;
}
function renderDistribution() {
  const body = $("distBody");
  const data = project.members.map(m => ({ m, t: index.total(m.id) })).sort((a, b) => b.t - a.t);
  const sum = data.reduce((a, r) => a + r.t, 0);
  body.textContent = "";
  if (sum <= 0) { body.textContent = "No timings recorded yet."; return; }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 240 240");
  svg.style.width = "min(64vw, 260px)";
  let a = -Math.PI / 2;
  for (const r of data) {
    if (r.t <= 0) continue;
    const sweep = r.t / sum * Math.PI * 2;
    const p = document.createElementNS(NS, sweep > Math.PI * 1.999 ? "circle" : "path");
    if (p.tagName === "circle") { p.setAttribute("cx", 120); p.setAttribute("cy", 120); p.setAttribute("r", 112); }
    else p.setAttribute("d", arcPath(120, 120, 112, a, a + Math.max(0.0001, sweep - 0.02)));
    p.setAttribute("fill", r.m.color);
    svg.appendChild(p);
    a += sweep;
  }
  const c = document.createElementNS(NS, "circle");
  c.setAttribute("cx", 120); c.setAttribute("cy", 120); c.setAttribute("r", 32);
  c.setAttribute("fill", "#fff");
  svg.appendChild(c);
  const legend = document.createElement("div");
  legend.id = "legend";
  for (const r of data) {
    const d = document.createElement("div");
    d.className = "leg";
    d.style.color = r.m.color;
    d.innerHTML = `<div class="lname"></div><div class="lnums"><span>${r.t.toFixed(2)}s</span><span>${(r.t / sum * 100).toFixed(2)}%</span></div>`;
    d.querySelector(".lname").textContent = r.m.name.toUpperCase();
    legend.appendChild(d);
  }
  body.append(svg, legend);
}

/* ================= settings ================= */
$("gearBtn").addEventListener("click", () => {
  renderSettings();
  els.setDlg.showModal();
  studio.fetchModels().then(() => { if (els.setDlg.open) renderMemberEditor(); });
});
$("setClose").addEventListener("click", () => els.setDlg.close());

function renderSettings() {
  const s = project.song;
  $("setGroup").value = s.group;
  $("setTitle").value = s.title;
  $("setArtist").value = s.artist;
  $("setDur").value = fmt(player.duration);
  $("setDur").disabled = player.hasAudio;
  $("audioName").textContent = player.hasAudio ? s.audioName : "";
  renderMemberEditor();
}
for (const id of ["setGroup", "setTitle", "setArtist"]) {
  $(id).addEventListener("input", () => {
    project.song.group = $("setGroup").value;
    project.song.title = $("setTitle").value;
    project.song.artist = $("setArtist").value;
    renderSongMeta();
    save();
  });
}
$("setDur").addEventListener("change", () => {
  const v = parseDur($("setDur").value);
  if (v && v > 0) {
    project.song.duration = player.manualDuration = v;
    timeline.resetView();
    renderSongMeta();
    save();
  }
  $("setDur").value = fmt(player.duration);
});

function membersChanged() {
  index.rebuild(project.members, project.segments);
  renderMembers();
  timeline.layout();
  save();
}
function renderMemberEditor() {
  const box = $("memberEditor");
  box.textContent = "";
  for (const m of project.members) {
    const row = document.createElement("div");
    row.className = "mrow";
    const av = document.createElement("button");
    av.className = "avbtn";
    av.title = "Set photo";
    styleAvatar(av, m);
    av.addEventListener("click", () => { avatarTarget = m.id; $("avatarFile").click(); });
    const name = document.createElement("input");
    name.type = "text";
    name.value = m.name;
    name.addEventListener("input", () => {
      if (project.voices[m.name]) { project.voices[name.value] = project.voices[m.name]; delete project.voices[m.name]; }
      m.name = name.value;
      membersChanged();
      if (!m.avatar) styleAvatar(av, m);
    });
    const color = document.createElement("input");
    color.type = "color";
    color.value = m.color;
    color.addEventListener("input", () => { m.color = color.value; membersChanged(); if (!m.avatar) styleAvatar(av, m); });
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Remove member";
    del.addEventListener("click", () => {
      if (!confirm(`Remove ${m.name} and their timings?`)) return;
      endAllHolds();
      project.members = project.members.filter(x => x !== m);
      delete project.voices[m.name];
      const next = project.segments.filter(s => s.memberId !== m.id);
      if (next.length !== project.segments.length) { undoStack = []; redoStack = []; project.segments = next; }
      membersChanged();
      segsChanged();
      renderMemberEditor();
    });
    row.append(av, name, color, del);
    box.appendChild(row);

    if (studio.models && studio.models.length) {
      const vrow = document.createElement("div");
      vrow.className = "vrow";
      const sel = document.createElement("select");
      sel.appendChild(new Option("Original voice", ""));
      for (const mod of studio.models) sel.appendChild(new Option(mod.name, mod.pth));
      sel.value = project.voices[m.name] || "";
      sel.addEventListener("change", () => {
        if (sel.value) project.voices[m.name] = sel.value;
        else delete project.voices[m.name];
        studio.stems.invalidate();
        save();
      });
      vrow.append("AI voice", sel);
      box.appendChild(vrow);
    }
  }
}
$("addMemberBtn").addEventListener("click", () => {
  project.members.push({ id: uid(), name: "New member", color: PALETTE[project.members.length % PALETTE.length], avatar: null });
  membersChanged();
  renderMemberEditor();
});

/* photos are stored in the project as 256px JPEG data URLs */
let avatarTarget = null;
function photoToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 256, canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const s = Math.min(img.width, img.height);
      canvas.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
async function setPhoto(member, file) {
  member.avatar = await photoToDataUrl(file);
  membersChanged();
  if (els.setDlg.open) renderMemberEditor();
}
$("avatarFile").addEventListener("change", () => {
  const file = $("avatarFile").files[0];
  $("avatarFile").value = "";
  const m = memberById(avatarTarget);
  if (file && m) setPhoto(m, file).catch(() => toast("Couldn't read that image"));
});

if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
  $("audioFile").removeAttribute("accept");
}
$("loadAudioBtn").addEventListener("click", () => $("audioFile").click());
$("audioFile").addEventListener("change", () => {
  const file = $("audioFile").files[0];
  $("audioFile").value = "";
  if (file) attachAudio(file, file.name, true);
});

$("clearBtn").addEventListener("click", () => {
  if (!project.segments.length || !confirm("Clear all recorded timings for this song?")) return;
  commit([]);
  toast("Timings cleared");
});
$("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (slug(`${project.song.group}-${project.song.title}`) || "song") + ".linedist.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ================= library ================= */
let libRows = [];
async function renderLibrary() {
  libRows = await store.list();
  const box = $("libList");
  box.textContent = "";
  for (const p of libRows) {
    const row = document.createElement("div");
    row.className = "librow" + (p.id === projectId ? " current" : "");
    const text = document.createElement("div");
    text.className = "libtext";
    const b = document.createElement("b");
    b.textContent = p.group;
    text.append(b, " · " + p.title + (p.artist ? " – " + p.artist : ""));
    const meta = document.createElement("small");
    meta.textContent = `${p.members} members`;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete song";
    del.addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm(`Delete ${p.group} · ${p.title}?`)) return;
      await store.remove(p.id);
      if (p.id === projectId) {
        project = null;
        const rest = (await store.list())[0];
        if (rest) await openProject(rest.id);
        else await createProject({ group: "Group", title: "Song" });
      }
      renderLibrary();
    });
    row.append(text, meta, del);
    row.addEventListener("click", async () => {
      els.libDlg.close();
      if (p.id !== projectId) await openProject(p.id);
    });
    box.appendChild(row);
  }
  const groups = [...new Set(libRows.map(p => p.group))];
  $("groupList").textContent = "";
  for (const g of groups) $("groupList").appendChild(new Option(g));
}
$("libBtn").addEventListener("click", async () => {
  if (saveTimer) flushSave();
  await renderLibrary();
  $("newGroup").value = project.song.group;
  $("newTitle").value = "";
  $("newArtist").value = "";
  els.libDlg.showModal();
  $("newTitle").focus();
});
$("libClose").addEventListener("click", () => els.libDlg.close());
$("newForm").addEventListener("submit", async e => {
  e.preventDefault();
  const group = $("newGroup").value.trim(), title = $("newTitle").value.trim();
  const same = g => g.trim().toLowerCase() === group.toLowerCase();
  let roster = same(project.song.group) ? project : null;
  if (!roster) {
    const hit = libRows.find(p => same(p.group));
    if (hit) roster = await store.load(hit.id);
  }
  els.libDlg.close();
  await createProject(
    { group, title, artist: $("newArtist").value.trim() },
    roster ? roster.members.map(m => ({ ...m, id: uid() })) : undefined,
    roster ? { voices: { ...roster.voices } } : undefined);
  toast(roster ? `${group} roster copied` : "Song created");
});
async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.members || !data.song) throw new Error("bad file");
    els.libDlg.close();
    const p = sanitize(data);
    await createProject(p.song, p.members, { segments: p.segments, voices: p.voices });
    toast("Imported " + project.song.title);
  } catch (e) { toast("Couldn't read that file"); }
}
$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", () => {
  const file = $("importFile").files[0];
  $("importFile").value = "";
  if (file) importJson(file);
});

/* ================= drag and drop ================= */
let dragDepth = 0;
addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; document.body.classList.add("dropping"); });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dropping"); } });
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", async e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dropping");
  const files = [...e.dataTransfer.files];
  const images = files.filter(f => f.type.startsWith("image/"));
  const audio = files.find(f => f.type.startsWith("audio/") || /\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i.test(f.name));
  const json = files.find(f => /\.json$/i.test(f.name));
  if (json) return importJson(json);
  if (audio) attachAudio(audio, audio.name, true);
  let matched = 0;
  const words = text => text.toLowerCase().match(/[^\W\d_]+/gu) || [];
  for (const f of images) {
    const inFile = new Set(words(f.name));
    const m = project.members.find(x => words(x.name).length && words(x.name).every(w => inFile.has(w)));
    if (m) { await setPhoto(m, f).catch(() => {}); matched++; }
  }
  if (images.length) toast(matched ? `${matched} photo${matched > 1 ? "s" : ""} set` : "No member name in those file names");
});

/* ================= boot ================= */
// v1 stored one song in localStorage and its audio in a separate database.
function readV1Audio() {
  return new Promise(res => {
    let rq;
    try { rq = indexedDB.open("line-dist-audio", 1); } catch (e) { return res(null); }
    rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
    rq.onerror = () => res(null);
    rq.onsuccess = () => {
      try {
        const g = rq.result.transaction("kv").objectStore("kv").get("current");
        g.onsuccess = () => res(g.result || null);
        g.onerror = () => res(null);
      } catch (e) { res(null); }
    };
  });
}
// first launch on an origin that ran v1: import its song and audio
async function migrateV1() {
  let old = null;
  try { old = JSON.parse(localStorage.getItem("line-dist-v1")); } catch (e) {}
  if (!old || !old.song || !Array.isArray(old.members)) return null;
  try {
    const p = sanitize(old);
    const id = await uniqueId(`${p.song.group}-${p.song.title}`);
    const rec = await readV1Audio();
    if (rec && rec.blob && rec.name === p.song.audioName) await store.putAudio(id, rec.name, rec.blob);
    else p.song.audioName = "";
    await store.save(id, p);
    return id;
  } catch (e) { return null; }
}

async function boot() {
  store = await openStore();
  applyPrefs();
  let list = await store.list();
  if (!list.length && store.kind === "browser" && await migrateV1()) list = await store.list();
  const has = x => list.some(p => p.id === x);
  const linked = decodeURIComponent(location.hash.slice(1));
  const id = has(linked) ? linked : has(prefs.current) ? prefs.current : list[0] && list[0].id;
  if (!id || !(await openProject(id))) await createProject({ group: "Group", title: "Song" });
  addEventListener("hashchange", () => {
    const next = decodeURIComponent(location.hash.slice(1));
    if (next && next !== projectId) openProject(next);
  });
  studio.poll();
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !local) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  if (store.kind === "browser" && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
boot();
