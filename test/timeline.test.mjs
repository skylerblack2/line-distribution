import { test } from "node:test";
import assert from "node:assert/strict";
import { MemberTrack, buildTracks, snapTo, normalizeImport } from "../js/timeline.js";

// reference implementation: v1's merge-then-sum
function v1UpTo(segs, t) {
  const list = [...segs].sort((a, b) => a.start - b.start), out = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out.reduce((a, s) => a + Math.max(0, Math.min(s.end, t) - s.start), 0);
}

test("overlapping and touching presses merge", () => {
  const tr = new MemberTrack([{ start: 5, end: 7 }, { start: 1, end: 3 }, { start: 2, end: 4 }, { start: 7, end: 8 }]);
  assert.deepEqual([...tr.starts], [1, 5]);
  assert.deepEqual([...tr.ends], [4, 8]);
  assert.equal(tr.total, 6);
});

test("upTo and activeAt match v1 on random data", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let run = 0; run < 50; run++) {
    const segs = Array.from({ length: 40 }, () => { const s = rnd() * 180; return { start: s, end: s + rnd() * 6 + 0.05 }; });
    const tr = new MemberTrack(segs);
    for (let k = 0; k < 200; k++) {
      const t = rnd() * 190;
      assert.ok(Math.abs(tr.upTo(t) - v1UpTo(segs, t)) < 1e-9);
      assert.equal(tr.activeAt(t), segs.some(s => s.start <= t && t < s.end));
    }
  }
});

test("empty track", () => {
  const tr = new MemberTrack([]);
  assert.equal(tr.upTo(50), 0);
  assert.equal(tr.activeAt(1), false);
  assert.equal(tr.total, 0);
});

test("buildTracks ignores segments for unknown members", () => {
  const m = buildTracks([{ id: "a" }], [{ memberId: "a", start: 0, end: 1 }, { memberId: "zz", start: 0, end: 5 }]);
  assert.equal(m.get("a").total, 1);
  assert.equal(m.size, 1);
});

test("snapTo stays within 150ms", () => {
  const on = [1, 2, 3];
  assert.equal(snapTo(on, 2.1), 2);
  assert.equal(snapTo(on, 2.4), 2.4);
  assert.equal(snapTo(null, 2.1), 2.1);
  assert.equal(snapTo(on, 0.9), 1);
});

test("normalizeImport accepts a v1 file and drops bad segments", () => {
  const p = normalizeImport({
    song: { group: "G", title: "X", duration: 100 },
    members: [{ id: "a", name: "A", color: "#000" }],
    segments: [{ memberId: "a", start: 1, end: 2 }, { memberId: "b", start: 1, end: 2 }, { memberId: "a", start: 3, end: 3 }],
    mode: "playback",
  });
  assert.equal(p.segments.length, 1);
  assert.equal(p.song.artist, "");
  assert.throws(() => normalizeImport({ song: {} }));
});
