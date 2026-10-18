const MIN_SPAN = 4;
const ROOMY = { wave: 44, lane: 14, gap: 4, top: 8 };
const COMPACT = { wave: 36, lane: 9, gap: 3, top: 6 };

// Waveform plus one lane of segments per member, drawn on a canvas. The playhead and the
// unplayed tint are separate elements moved with transforms.
export class Timeline {
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.canvas = root.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.wrap = root.querySelector(".tl-wrap");
    this.playhead = root.querySelector(".tl-playhead");
    this.unplayed = root.querySelector(".tl-unplayed");
    this.heads = root.querySelector(".tl-heads");
    this.wave = document.createElement("canvas");
    this.peaks = null;
    this.lanes = true;
    this.compact = false;
    this.m = ROOMY;
    this.v0 = 0;
    this.v1 = 1;
    this.w = 0;
    this.stale = true;
    this.waveStale = true;
    this.drag = null;
    this.lastX = -1;
    this.coarse = matchMedia("(pointer:coarse)").matches;

    new ResizeObserver(() => this.resize()).observe(this.wrap);
    const c = this.canvas;
    c.addEventListener("pointerdown", e => this.down(e));
    c.addEventListener("pointermove", e => this.move(e));
    c.addEventListener("pointerup", e => this.up(e));
    c.addEventListener("pointercancel", e => this.up(e));
    c.addEventListener("wheel", e => this.wheel(e), { passive: false });
    c.addEventListener("dblclick", e => { if (this.y(e) < this.m.wave) this.resetView(); });
    c.addEventListener("contextrestored", () => this.repaint());
  }

  get height() {
    const n = this.lanes ? this.host.members().length : 0;
    return this.m.wave + (n ? this.m.top + n * (this.m.lane + this.m.gap) : 0);
  }

  setPeaks(peaks) { this.peaks = peaks; this.waveStale = true; this.invalidate(); }
  setLanes(on) { this.lanes = on; this.layout(); }
  setCompact(on) { this.compact = on; this.m = on ? COMPACT : ROOMY; this.layout(); }
  resetView() { this.v0 = 0; this.v1 = Math.max(1, this.host.duration()); this.waveStale = true; this.invalidate(); }
  invalidate() { this.stale = true; this.host.requestRender(); }
  repaint() { this.waveStale = true; this.invalidate(); }

  // Rebuilds the lane avatars and resizes the canvas to fit the member count.
  layout() {
    this.heads.textContent = "";
    this.heads.hidden = !this.lanes || this.compact;
    this.root.style.setProperty("--wave-h", this.m.wave + "px");
    this.root.style.setProperty("--lane-top", this.m.wave + this.m.top + "px");
    if (!this.heads.hidden) {
      for (const m of this.host.members()) {
        const d = document.createElement("div");
        this.host.styleAvatar(d, m);
        this.heads.appendChild(d);
      }
    }
    this.wrap.style.height = this.height + "px";
    this.resize();
  }

  resize() {
    const w = this.wrap.clientWidth;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    this.w = w;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.wave.width = this.canvas.width;
    this.wave.height = Math.round(this.m.wave * dpr);
    this.waveStale = true;
    this.lastX = -1;
    this.invalidate();
  }

  x(t) { return (t - this.v0) / (this.v1 - this.v0) * this.w; }
  time(px) { return this.v0 + px / this.w * (this.v1 - this.v0); }
  px(e) { return e.clientX - this.canvas.getBoundingClientRect().left; }
  y(e) { return e.clientY - this.canvas.getBoundingClientRect().top; }
  laneY(i) { return this.m.wave + this.m.top + i * (this.m.lane + this.m.gap); }

  drawWave() {
    const g = this.wave.getContext("2d");
    const W = this.wave.width, H = this.wave.height, mid = H / 2;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#111";
    const p = this.peaks, dur = this.host.duration();
    if (!p || !dur) { g.fillRect(0, mid - 1, W, 2); return; }
    const perSec = p.length / dur, span = this.v1 - this.v0;
    for (let col = 0; col < W; col += 2) {
      const a = Math.floor((this.v0 + col / W * span) * perSec);
      const b = Math.max(a + 1, Math.floor((this.v0 + (col + 2) / W * span) * perSec));
      let max = 0;
      for (let i = Math.max(0, a); i < b && i < p.length; i++) if (p[i] > max) max = p[i];
      const h = Math.max(1, max / 255 * (H - 4));
      g.fillRect(col, mid - h / 2, 1.2, h);
    }
  }

  draw(t) {
    const g = this.ctx, dpr = window.devicePixelRatio || 1;
    if (this.waveStale) { this.drawWave(); this.waveStale = false; }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.wave, 0, 0);
    if (!this.lanes) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const members = this.host.members(), index = this.host.index(), holds = this.host.holds();
    const sel = this.host.selected();
    members.forEach((m, i) => {
      const y = this.laneY(i);
      g.fillStyle = "rgba(17,17,17,.07)";
      this.bar(g, 0, y, this.w, this.m.lane);
      g.fillStyle = m.color;
      for (const s of index.segs(m.id)) {
        if (s.end < this.v0 || s.start > this.v1) continue;
        const x0 = this.x(s.start), x1 = this.x(s.end);
        this.bar(g, x0, y, Math.max(2, x1 - x0), this.m.lane);
        if (s === sel) {
          g.strokeStyle = "#111";
          g.lineWidth = 2;
          g.stroke();
        }
      }
      if (holds.has(m.id)) {
        const x0 = this.x(holds.get(m.id));
        g.fillStyle = "#ff8c1a";
        this.bar(g, x0, y, Math.max(2, this.x(t) - x0), this.m.lane);
      }
    });
  }

  bar(g, x, y, w, h) {
    const r = Math.min(4, w / 2);
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fill();
  }

  // Called every rendered frame with the current song time.
  frame(t, playing) {
    if (!this.w) return;
    const span = this.v1 - this.v0, dur = this.host.duration();
    if (playing && !this.drag && span < dur - 0.01 && (t > this.v0 + span * 0.92 || t < this.v0)) {
      this.v0 = Math.max(0, Math.min(dur - span, t - span * 0.08));
      this.v1 = this.v0 + span;
      this.waveStale = this.stale = true;
    }
    const x = Math.round(this.x(t) * 2) / 2;
    const moved = x !== this.lastX;
    if (this.stale || (moved && this.host.holds().size)) { this.draw(t); this.stale = false; }
    if (!moved) return;
    this.lastX = x;
    const cx = Math.max(0, Math.min(this.w, x));
    this.playhead.style.transform = `translateX(${cx}px)`;
    this.playhead.style.opacity = x < 0 || x > this.w ? 0 : 1;
    this.unplayed.style.transform = `scaleX(${1 - cx / this.w})`;
  }

  // Finds what is under the pointer: {seg, edge} where edge is "start", "end" or null.
  hit(e) {
    const y = this.y(e), px = this.px(e);
    if (!this.lanes || y < this.m.wave + this.m.top - 2) return null;
    const i = Math.floor((y - this.m.wave - this.m.top + this.m.gap / 2) / (this.m.lane + this.m.gap));
    if (this.coarse) return this.hitTouch(px, Math.max(0, Math.min(this.host.members().length - 1, i)));
    const m = this.host.members()[i];
    if (!m) return null;
    const grip = 5;
    let best = null;
    for (const s of this.host.index().segs(m.id)) {
      const x0 = this.x(s.start), x1 = this.x(s.end);
      if (px < x0 - grip || px > x1 + grip) continue;
      const wide = x1 - x0 > grip * 2.5;
      let edge = null;
      if (Math.abs(px - x0) <= grip && (wide || px < x0)) edge = "start";
      else if (Math.abs(px - x1) <= grip && (wide || px > x1)) edge = "end";
      if (!edge && (px < x0 || px > x1)) continue;
      best = { seg: s, edge };
      if (!edge) break;
    }
    return best;
  }

  // Touch version of hit(): whole segments only, searching outward from the touched lane.
  hitTouch(px, lane) {
    const members = this.host.members(), index = this.host.index();
    for (const off of [0, -1, 1, -2, 2]) {
      const m = members[lane + off];
      if (!m) continue;
      const seg = index.segs(m.id).find(s => px >= this.x(s.start) - 8 && px <= this.x(s.end) + 8);
      if (seg) return { seg, edge: null };
    }
    return null;
  }

  down(e) {
    if (e.button) return;
    this.canvas.setPointerCapture(e.pointerId);
    const h = this.hit(e);
    if (h && h.edge) {
      this.drag = { kind: "trim", seg: h.seg, edge: h.edge };
      this.host.trimStart(h.seg);
    } else if (h) {
      this.host.pickSegment(h.seg);
    } else {
      this.drag = { kind: "scrub" };
      this.host.select(null);
      this.host.seek(this.time(this.px(e)));
    }
  }

  move(e) {
    const d = this.drag;
    if (!d) {
      const h = this.hit(e);
      this.canvas.style.cursor = h ? (h.edge ? "ew-resize" : "pointer") : "";
      return;
    }
    const t = Math.max(0, Math.min(this.host.duration(), this.time(this.px(e))));
    if (d.kind === "scrub") this.host.seek(t);
    else d.seg = this.host.trim(d.seg, d.edge === "start" ? t : d.seg.start, d.edge === "end" ? t : d.seg.end);
  }

  up() {
    if (this.drag && this.drag.kind === "trim") this.host.trimEnd();
    this.drag = null;
  }

  // Wheel zooms around the cursor; shift+wheel or a sideways wheel pans.
  wheel(e) {
    const dur = this.host.duration();
    e.preventDefault();
    let span = this.v1 - this.v0;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dt = (e.deltaX || e.deltaY) / this.w * span;
      this.v0 = Math.max(0, Math.min(dur - span, this.v0 + dt));
    } else {
      const anchor = this.time(this.px(e));
      const next = Math.max(Math.min(MIN_SPAN, dur), Math.min(dur, span * Math.exp(e.deltaY * 0.0015)));
      this.v0 = Math.max(0, Math.min(dur - next, anchor - (anchor - this.v0) * next / span));
      span = next;
    }
    this.v1 = this.v0 + span;
    this.waveStale = true;
    this.lastX = -1;
    this.invalidate();
  }
}

// Reduces decoded audio to one loudness byte per bucket (about 50 per second).
export async function computePeaks(blob) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 2, 44100);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const n = Math.min(16000, Math.max(200, Math.ceil(buf.duration * 50)));
  const peaks = new Uint8Array(n);
  const step = buf.length / n;
  const power = new Float32Array(n);
  for (let ch = 0; ch < Math.min(2, buf.numberOfChannels); ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const end = Math.min(data.length, Math.floor((i + 1) * step));
      let sum = 0;
      for (let j = Math.floor(i * step); j < end; j += 4) sum += data[j] * data[j];
      power[i] += sum;
    }
  }
  let top = 0;
  for (let i = 0; i < n; i++) if (power[i] > top) top = power[i];
  // RMS raised to 1.6
  for (let i = 0; i < n; i++) peaks[i] = Math.round(Math.pow(Math.sqrt(power[i] / (top || 1)), 1.6) * 255);
  return peaks;
}
