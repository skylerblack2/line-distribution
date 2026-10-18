// Segment math: raw presses merged into sorted, non-overlapping intervals with prefix sums.

export class MemberTrack {
  constructor(segs) {
    const sorted = segs.map(s => [s.start, s.end]).sort((a, b) => a[0] - b[0]);
    const starts = [], ends = [];
    for (const [s, e] of sorted) {
      const n = ends.length;
      if (n && s <= ends[n - 1]) { if (e > ends[n - 1]) ends[n - 1] = e; }
      else { starts.push(s); ends.push(e); }
    }
    this.starts = Float64Array.from(starts);
    this.ends = Float64Array.from(ends);
    this.cum = new Float64Array(starts.length + 1);
    for (let i = 0; i < starts.length; i++) this.cum[i + 1] = this.cum[i] + ends[i] - starts[i];
    this.total = this.cum[starts.length];
  }
  get length() { return this.starts.length; }
  // index of the last interval starting at or before t, or -1
  indexAt(t) {
    let lo = 0, hi = this.starts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  // seconds sung up to time t
  upTo(t) {
    const i = this.indexAt(t);
    if (i < 0) return 0;
    return this.cum[i] + Math.min(this.ends[i], t) - this.starts[i];
  }
  activeAt(t) {
    const i = this.indexAt(t);
    return i >= 0 && t < this.ends[i];
  }
}

export function buildTracks(members, segments) {
  const by = new Map(members.map(m => [m.id, []]));
  for (const s of segments) { const a = by.get(s.memberId); if (a) a.push(s); }
  const out = new Map();
  for (const [id, segs] of by) out.set(id, new MemberTrack(segs));
  return out;
}

// Nearest onset within maxDist seconds, else t unchanged. onsets must be sorted.
export function snapTo(onsets, t, maxDist = 0.15) {
  if (!onsets || !onsets.length) return t;
  let lo = 0, hi = onsets.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (onsets[mid] < t) lo = mid + 1; else hi = mid; }
  let best = onsets[lo];
  if (lo > 0 && Math.abs(onsets[lo - 1] - t) < Math.abs(best - t)) best = onsets[lo - 1];
  return Math.abs(best - t) <= maxDist ? best : t;
}

export function fmt(t) {
  t = Math.max(0, Math.floor(t));
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
}

export function parseDur(str) {
  str = String(str).trim();
  if (/^\d+:\d{1,2}$/.test(str)) { const [m, s] = str.split(":").map(Number); return m * 60 + s; }
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

// Accepts v1 and v2 .linedist.json shapes; returns a clean project body or throws.
export function normalizeImport(data) {
  if (!data || !Array.isArray(data.members) || !data.song) throw new Error("not a line distribution file");
  const members = data.members
    .filter(m => m && m.id)
    .map(m => ({ id: String(m.id), name: String(m.name || "?"), color: m.color || "#888888", avatar: m.avatar || null }));
  const ids = new Set(members.map(m => m.id));
  const segments = (data.segments || [])
    .filter(s => s && ids.has(s.memberId) && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map(s => ({ memberId: s.memberId, start: s.start, end: s.end }));
  const song = {
    group: String(data.song.group || ""),
    title: String(data.song.title || "Untitled"),
    artist: String(data.song.artist || ""),
    duration: Number(data.song.duration) > 0 ? Number(data.song.duration) : 180,
    audioName: String(data.song.audioName || ""),
  };
  return { song, members, segments };
}
