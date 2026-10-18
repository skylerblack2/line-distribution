const MIN_LEN = 0.05;

// Returns a new segment list with [start, end] added for the member, merged with any of that member's overlapping segments.
export function addSegment(segments, memberId, start, end) {
  if (end - start < MIN_LEN) return segments;
  const out = [];
  for (const s of segments) {
    if (s.memberId === memberId && s.start <= end && s.end >= start) {
      start = Math.min(start, s.start);
      end = Math.max(end, s.end);
    } else out.push(s);
  }
  out.push({ memberId, start, end });
  return out.sort((a, b) => a.start - b.start);
}

export function removeSegment(segments, seg) {
  return segments.filter(s => s !== seg);
}

// Returns a new list with seg's edges moved, clamped between its same-member neighbours.
export function resizeSegment(segments, seg, start, end, duration) {
  let lo = 0, hi = duration;
  for (const s of segments) {
    if (s === seg || s.memberId !== seg.memberId) continue;
    if (s.end <= seg.start) lo = Math.max(lo, s.end);
    if (s.start >= seg.end) hi = Math.min(hi, s.start);
  }
  start = Math.max(lo, Math.min(start, seg.end - MIN_LEN));
  end = Math.min(hi, Math.max(end, seg.start + MIN_LEN));
  const next = { memberId: seg.memberId, start, end };
  return { segments: segments.map(s => (s === seg ? next : s)), seg: next };
}

// Merges overlapping presses per member, for data from the v1 app.
export function normalize(segments) {
  let out = [];
  for (const s of segments) out = addSegment(out, s.memberId, +s.start, +s.end);
  return out;
}

// Per-member sorted segments with running totals, rebuilt only when segments change.
export class SegIndex {
  constructor() { this.by = new Map(); }

  rebuild(members, segments) {
    this.by.clear();
    for (const m of members) this.by.set(m.id, { segs: [], cum: [0], total: 0 });
    for (const s of segments) {
      const e = this.by.get(s.memberId);
      if (!e) continue;
      e.segs.push(s);
      e.total += s.end - s.start;
      e.cum.push(e.total);
    }
  }

  segs(id) { const e = this.by.get(id); return e ? e.segs : []; }
  total(id) { const e = this.by.get(id); return e ? e.total : 0; }

  // Index of the last segment starting at or before t, or -1.
  find(e, t) {
    let lo = 0, hi = e.segs.length - 1, hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (e.segs[mid].start <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return hit;
  }

  upTo(id, t) {
    const e = this.by.get(id);
    if (!e) return 0;
    const i = this.find(e, t);
    if (i < 0) return 0;
    const s = e.segs[i];
    return e.cum[i] + Math.min(s.end, t) - s.start;
  }

  activeAt(id, t) {
    const e = this.by.get(id);
    if (!e) return false;
    const i = this.find(e, t);
    return i >= 0 && t < e.segs[i].end;
  }
}
