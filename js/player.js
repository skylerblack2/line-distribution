// Song clock with three sources: the <audio> element, a plain timer when no audio is loaded,
// and an optional alternate engine (AI vocal stems) that takes over while alt.active() is true.
export class Player {
  constructor(audio, { onState, onEnded }) {
    this.audio = audio;
    this.onState = onState;
    this.onEnded = onEnded;
    this.alt = null;
    this.hasAudio = false;
    this.playing = false;
    this.starting = false;
    this.playToken = 0;
    this.rate = 1;
    this.manualDuration = 180;
    this.baseT = 0;
    this.wall = 0;
    this.url = null;
    audio.addEventListener("ended", () => this.finish());
    // pause and play events from outside the app
    audio.addEventListener("pause", () => {
      if (!this.playing || this.useAlt || audio.ended) return;
      this.playing = false;
      this.onEnded(this.now());
      this.onState();
    });
    audio.addEventListener("play", () => {
      if (this.playing || this.starting || this.useAlt || !this.hasAudio) return;
      this.playing = true;
      this.onState();
    });
  }

  get useAlt() { return !!(this.alt && this.alt.active()); }

  get duration() {
    if (this.useAlt && this.alt.duration) return this.alt.duration;
    return this.hasAudio && this.audio.duration ? this.audio.duration : this.manualDuration;
  }

  now() {
    if (this.useAlt) return this.alt.now();
    if (this.hasAudio) return this.audio.currentTime;
    if (!this.playing) return this.baseT;
    return Math.min(this.duration, this.baseT + (performance.now() - this.wall) / 1000 * this.rate);
  }

  // Song time at the moment an input event fired.
  at(timeStamp) {
    const t = this.now();
    if (!this.playing || !timeStamp) return t;
    const lag = Math.min(250, Math.max(0, performance.now() - timeStamp));
    return Math.max(0, t - lag / 1000 * (this.useAlt ? 1 : this.rate));
  }

  // Resolves true once playback has started, false if the browser refused or a pause came first.
  async play() {
    if (this.now() >= this.duration - 0.01) this.seek(0);
    const token = ++this.playToken;
    if (this.useAlt) { if (this.hasAudio) this.audio.pause(); this.alt.play(this.alt.now()); }
    else if (this.hasAudio) {
      this.starting = true;
      try { await this.audio.play(); } catch (e) { return false; } finally { this.starting = false; }
      if (token !== this.playToken) return false;
    } else this.wall = performance.now();
    this.playing = true;
    this.onState();
    return true;
  }

  pause() {
    const t = this.now();
    this.playToken++;
    this.playing = false;
    if (this.alt && this.alt.isPlaying) this.alt.stop();
    if (this.hasAudio && !this.audio.paused) this.audio.pause();
    if (!this.hasAudio) this.baseT = t;
    this.onState();
  }

  seek(t) {
    t = Math.max(0, Math.min(this.duration, t));
    if (this.useAlt) this.alt.seek(t);
    if (this.hasAudio) this.audio.currentTime = t;
    this.baseT = t;
    this.wall = performance.now();
  }

  finish() {
    if (!this.playing) return;
    this.baseT = this.duration;
    this.playing = false;
    this.onEnded();
    this.onState();
  }

  // Ends timer and stem playback when they reach the end of the song.
  poll() {
    if (this.playing && (this.useAlt || !this.hasAudio) && this.now() >= this.duration - 0.005) {
      if (this.alt && this.alt.isPlaying) this.alt.stop();
      this.finish();
    }
  }

  setRate(rate) {
    const t = this.now();
    this.baseT = t;
    this.wall = performance.now();
    this.rate = rate;
    this.audio.playbackRate = rate;
  }

  // Runs mutate() (which may change the active source) while keeping position and play state.
  retarget(mutate, resume = true) {
    const was = this.playing;
    const t = this.now();
    if (was) this.pause();
    mutate();
    if (this.alt) this.alt.base = t;
    this.seek(t);
    if (was && resume) this.play();
  }

  setAudio(blob) {
    return new Promise((resolve, reject) => {
      const a = this.audio;
      const url = URL.createObjectURL(blob);
      const done = ok => {
        a.removeEventListener("loadedmetadata", onMeta);
        a.removeEventListener("error", onErr);
        if (ok) {
          if (this.url) URL.revokeObjectURL(this.url);
          this.url = url;
          this.hasAudio = true;
          a.playbackRate = this.rate;
          resolve();
        } else {
          URL.revokeObjectURL(url);
          this.clearAudio();
          reject(new Error("not playable"));
        }
      };
      const onMeta = () => done(true);
      const onErr = () => done(false);
      a.addEventListener("loadedmetadata", onMeta);
      a.addEventListener("error", onErr);
      a.src = url;
    });
  }

  clearAudio() {
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.hasAudio = false;
    this.baseT = 0;
  }
}
