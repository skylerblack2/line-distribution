// Song clock: the <audio> element when a file is loaded, otherwise a manual
// timer. Interpolates between audio.currentTime updates and can back-date a
// press to the input event's timestamp.

export class Clock {
  constructor(audio) {
    this.audio = audio;
    this.hasAudio = false;
    this.playing = false;
    this.rate = 1;
    this.fallbackDuration = 180;
    this._base = 0; this._wall = 0;          // manual timer
    this._lastAt = -1; this._lastWall = 0;   // audio interpolation
  }

  get duration() {
    return this.hasAudio && this.audio.duration ? this.audio.duration : this.fallbackDuration;
  }

  now() {
    if (this.hasAudio) {
      const at = this.audio.currentTime;
      if (!this.playing) return at;
      const w = performance.now();
      if (at !== this._lastAt) { this._lastAt = at; this._lastWall = w; return at; }
      return Math.min(this.duration, at + Math.min(0.1, (w - this._lastWall) / 1000 * this.rate));
    }
    if (!this.playing) return this._base;
    return Math.min(this.duration, this._base + (performance.now() - this._wall) / 1000 * this.rate);
  }

  // song time at an input event's timestamp
  atEvent(e) {
    const t = this.now();
    const lag = e && e.timeStamp ? (performance.now() - e.timeStamp) / 1000 : 0;
    return lag > 0 && lag < 0.25 ? Math.max(0, t - lag * this.rate) : t;
  }

  // onBlocked runs if play() rejects
  start(onBlocked) {
    if (this.hasAudio) {
      this._lastAt = -1;
      const p = this.audio.play();
      if (p && p.catch) p.catch(err => {
        if (err && err.name === "AbortError") return; // superseded by a pause/seek
        this.playing = false;
        if (onBlocked) onBlocked(err);
      });
    } else {
      this._wall = performance.now();
    }
    this.playing = true;
  }

  stop() {
    if (this.hasAudio) this.audio.pause();
    else this._base = this.now();
    this.playing = false;
  }

  seek(t) {
    t = Math.max(0, Math.min(this.duration, t));
    if (this.hasAudio) { this.audio.currentTime = t; this._lastAt = -1; }
    else { this._base = t; this._wall = performance.now(); }
  }

  setRate(r) {
    if (!this.hasAudio) { this._base = this.now(); this._wall = performance.now(); }
    this.rate = r;
    this.audio.playbackRate = r;
    this.audio.defaultPlaybackRate = r;
  }
}
