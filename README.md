# Line Distribution v2

A rewrite of v1 (the earlier commits in this repo). It's the same idea and look: play a song, hold a member's
button while they sing, and watch the totals race. It's still a static, offline-capable PWA with no build step.

Run locally: `npm start` (serves on http://127.0.0.1:8470). Tests: `npm test`.

Phone check: `npm run shots` (with the server running) drives the app in WebKit, the engine Chrome on
iPhone uses. The profile is iPhone 17 portrait (402 wide) at 620, 681, and 780 tall, which covers
Chrome with both toolbars, typical, and toolbars collapsed. It writes screenshots to `shots/`, plus
`shots/report.json` with layout issues (sideways scroll, off-screen elements, small tap targets,
the keyboard popping up when a dialog opens). `node tools/sheet.mjs 02-main,10-settings 260 out.png 681`
lays chosen screens side by side. One-time setup: `npm i && npx playwright install webkit chromium`.

## What changed from v1

Faster
- Segment math is precomputed per member (merged intervals and prefix sums), so each frame does a few binary
  searches instead of filtering and sorting every segment three times per member.
- The screen only redraws while something is moving (playing, holding, count-in). v1 ran a loop forever,
  plus a 300ms timer.
- Bars and labels move with GPU transforms, and text is only rewritten when it changes.
- Audio analysis (snap points and waveform) runs in a Web Worker and is cached, so reopening a song
  doesn't decode the mp3 again.
- Songs live in IndexedDB. A press saves the segment list only; v1 re-serialized every photo into
  localStorage on every press.

More accurate
- Press and release times come from when your finger or key actually went down, not from when the
  handler got around to running.
- Between Safari's coarse `currentTime` updates, the clock interpolates.

New
- Song library: keeps every song with its audio. Tap the song title or the list icon to open it.
- New songs reuse a group's roster (photos included).
- Timeline: the seek bar shows the waveform plus one colored lane per member. Tap or drag it to seek.
- Keyboard: Space plays and pauses, hold 1 to 9 for members, ←/→ jump 3s, Z undoes, Shift+Z redoes,
  D shows segments.
- Undo and redo for presses, segment deletes, and "clear all".
- Speed button (1×, 0.75×, 0.5×). Timings still land in song time.
- Drag an mp3 or a `.linedist.json` onto the window.
- "Copy as text" in the distribution view.
- Lock-screen play and pause controls. The screen stays awake while playing.
- The audio is saved the moment you pick it, so a deferred load in a background tab can't lose it.

iPhone portrait layout (the only phone target)
- All six members, the header, and the hold buttons fit on one screen with no scrolling, even with
  both of Chrome's toolbars showing.
- Member rows are one line each (name, bar, total). The six hold buttons share a single row, and ↺3s
  sits next to play.
- No double-tap zoom on buttons, and no text selection or callout while holding. Dialogs open
  without popping up the keyboard.
- Audio is stored as raw bytes rather than a Blob, which iOS WebKit handles more reliably.

Compatible: it imports v1 `.linedist.json` files, and its exports keep the same shape. On the same origin
(GitHub Pages), first launch carries v1's current song and audio over.

## Files
- `index.html`, `style.css`: page and look
- `js/app.js`: UI, transport, holds, library, settings
- `js/timeline.js`: pure segment math (unit-tested)
- `js/clock.js`: audio or manual clock
- `js/db.js`: IndexedDB storage
- `js/analysis-worker.js`: onset detection and waveform envelope
- `sw.js`: offline cache (registered on https only, so local edits show on reload)

`.linedist.json` files are gitignored because they embed member photos. `fixtures/` holds the local roster and mp3 that `npm run shots` uses.
