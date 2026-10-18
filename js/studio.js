const STUDIO_URL = "http://127.0.0.1:8771";

// Client for the local linecover server: syncs the project, uploads audio, and plays the
// converted vocal stems in playback mode. Calls fail silently when the server is down.
export class Studio {
  constructor(host) {
    this.host = host;
    this.alive = false;
    this.status = null;
    this.models = null;
    this.stateTimer = null;
    this.pollTimer = null;
    this.stems = new StemPlayer(this);
  }

  syncState() {
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      if (!this.alive) return;
      const p = this.host.project();
      const lean = {
        song: p.song,
        members: p.members.map(m => ({ id: m.id, name: m.name, color: m.color })),
        segments: p.segments,
        voices: p.voices || {},
      };
      fetch(STUDIO_URL + "/state", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lean),
      }).catch(() => { this.alive = false; });
    }, 800);
  }

  uploadAudio(blob, name) {
    if (!this.alive) return;
    fetch(STUDIO_URL + "/audio/" + encodeURIComponent(name), { method: "POST", body: blob })
      .then(() => { this.syncState(); this.poll(); })
      .catch(() => { this.alive = false; });
  }

  fetchModels() {
    return fetch(STUDIO_URL + "/models").then(r => r.json()).then(list => {
      this.alive = true;
      this.models = list;
    }).catch(() => { this.models = null; });
  }

  castNames() {
    const p = this.host.project(), v = p.voices || {};
    return p.members.map(m => m.name).filter(n => v[n]);
  }

  takesReady() {
    if (!this.status || !this.status.takes) return false;
    const names = this.castNames(), voices = this.host.project().voices;
    return names.length > 0 && names.every(n =>
      (this.status.takes[n] || {}).state === "ready" && this.status.takes[n].model === voices[n]);
  }

  poll() {
    clearTimeout(this.pollTimer);
    const was = this.alive;
    fetch(STUDIO_URL + "/status").then(r => r.json()).then(st => {
      this.alive = true;
      this.status = st;
      if (!was) this.host.onConnect();
      if (st.song_hash && this.takesReady()) this.stems.maybeLoad(st);
      else if (st.song_hash && this.stems.hash && this.stems.hash !== st.song_hash) this.stems.invalidate();
    }).catch(() => { this.alive = false; this.status = null; })
      .finally(() => {
        this.host.onChange();
        this.pollTimer = setTimeout(() => this.poll(), this.alive ? 4000 : 60000);
      });
  }

  chipLabel() {
    if (!this.alive || !this.status || !this.host.project()) return null;
    const names = this.castNames();
    if (!names.length && !this.status.audio) return null;
    if (this.stems.loading) return "AI …";
    if (this.stems.ready) return this.host.aiVocals() ? "AI ✓" : "AI off";
    if (names.length === 0) return "AI –";
    const done = names.filter(n => (this.status.takes[n] || {}).state === "ready").length;
    return `AI ${done}/${names.length}`;
  }
}

// Plays instrumental + backing + one converted take per member, each take gated to that member's segments.
class StemPlayer {
  constructor(studio) {
    this.studio = studio;
    this.ctx = null;
    this.ready = false;
    this.loading = false;
    this.hash = null;
    this.signature = null;
    this.buffers = null;
    this.nodes = [];
    this.isPlaying = false;
    this.startCtx = 0;
    this.startOff = 0;
    this.base = 0;
    this.duration = 0;
  }

  active() {
    const h = this.studio.host;
    return this.ready && h.mode() === "playback" && h.aiVocals();
  }

  now() {
    if (!this.isPlaying) return this.base;
    return Math.min(this.duration, this.startOff + (this.ctx.currentTime - this.startCtx));
  }

  invalidate() {
    const h = this.studio.host;
    h.retarget(() => {
      this.ready = false;
      this.buffers = null;
      this.hash = null;
      this.signature = null;
    });
    h.onChange();
  }

  maybeLoad(st) {
    const names = this.studio.castNames();
    const sig = st.song_hash + "|" + names.map(n => n + ":" + st.takes[n].model).join(",");
    if (this.loading || this.signature === sig) return;
    this.load(st.song_hash, names, sig);
  }

  async load(hash, names, sig) {
    const h = this.studio.host;
    this.loading = true;
    h.onChange();
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const get = async which => {
        const r = await fetch(`${STUDIO_URL}/stems/${hash}/${which}`);
        if (!r.ok) throw new Error(which + " not ready");
        return this.ctx.decodeAudioData(await r.arrayBuffer());
      };
      const [instrumental, backing, lead] = await Promise.all(["instrumental", "backing", "lead"].map(get));
      const takes = {};
      for (const n of names) takes[n] = await get("take." + encodeURIComponent(n));
      h.retarget(() => {
        this.buffers = { instrumental, backing, lead, takes };
        this.duration = instrumental.duration;
        this.hash = hash;
        this.signature = sig;
        this.ready = true;
      });
      h.toast("AI vocals ready");
    } catch (e) {}
    this.loading = false;
    h.onChange();
  }

  envelope(gain, segs, fromT, when) {
    const F = 0.06, p = gain.gain;
    p.setValueAtTime(0, when);
    for (const s of segs) {
      if (s.end <= fromT) continue;
      const a = when + Math.max(0, s.start - fromT), b = when + (s.end - fromT);
      const up = Math.min(a + F, b);
      p.setValueAtTime(0, a);
      p.linearRampToValueAtTime(1, up);
      p.setValueAtTime(1, Math.max(up, b - F));
      p.linearRampToValueAtTime(0, b);
    }
  }

  play(fromT) {
    if (!this.ready) return;
    const h = this.studio.host, project = h.project(), index = h.index();
    if (this.ctx.state === "suspended") this.ctx.resume();
    fromT = Math.max(0, Math.min(fromT, this.duration - 0.01));
    const when = this.ctx.currentTime + 0.08;
    this.nodes = [];
    const mk = (buf, segs) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      src.connect(g);
      g.connect(this.ctx.destination);
      if (segs) this.envelope(g, segs, fromT, when);
      src.start(when, Math.min(fromT, Math.max(0, buf.duration - 0.01)));
      this.nodes.push(src, g);
    };
    mk(this.buffers.instrumental, null);
    if (this.buffers.backing) mk(this.buffers.backing, null);
    const idByName = {};
    for (const m of project.members) idByName[m.name] = m.id;
    for (const [name, buf] of Object.entries(this.buffers.takes)) {
      mk(buf, idByName[name] ? index.segs(idByName[name]) : []);
    }
    // Members without an AI voice keep the original lead vocal on their segments.
    const uncast = project.members.filter(m => !this.buffers.takes[m.name])
      .flatMap(m => index.segs(m.id)).sort((a, b) => a.start - b.start);
    if (uncast.length && this.buffers.lead) mk(this.buffers.lead, uncast);
    this.startCtx = when;
    this.startOff = fromT;
    this.isPlaying = true;
  }

  stop() {
    this.base = this.now();
    for (const n of this.nodes) { try { n.stop && n.stop(0); n.disconnect(); } catch (e) {} }
    this.nodes = [];
    this.isPlaying = false;
  }

  seek(t) {
    const was = this.isPlaying;
    if (was) this.stop();
    this.base = Math.max(0, Math.min(t, this.duration));
    if (was) this.play(this.base);
  }
}
