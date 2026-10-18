# Line Distribution 2

Rewrite of the line-distribution app ("How Would X Sing Y?"). Hold a member while they sing; the app
records the segments, ranks members by time, and plays the result back.

## Run

Double-click `start-line-distribution.bat`. It serves the app on http://localhost:8796 and opens it.

Served this way, songs are files on disk:

```
library/<song-id>/project.linedist.json   song, members (photos inline), segments, AI voices
library/<song-id>/<audio file>
```

`project.linedist.json` uses the v1 export format, so linecover reads it as is. Deleting a song in
the app moves its folder to `library/_trash/`.

Hosted as static files (GitHub Pages, phone), there is no server, so songs are kept in the browser's
IndexedDB and the app works offline through `sw.js`.

## Use

| Action | How |
|---|---|
| Record a line | Hold a member's circle, or hold keys `1`-`9`. Holding while paused starts playback from that spot. |
| Record without holding | Tap a circle (under a quarter second) to latch that member. Tap another circle to hand off at that instant. Tap the lit circle to stop. Holding a second circle while one is latched records both. |
| Retake | `↩` in the phone dock removes the last segment and rewinds to 1.5s before it |
| Play / pause | `Space` |
| Seek | Click or drag the waveform, `←` `→` (3s), `Shift+←` `→` (1s) |
| Zoom the timeline | Mouse wheel over it; `Shift`+wheel pans; double-click the waveform resets |
| Fix a segment | Drag either edge in its lane. Click it to select and replay; `Delete` removes it |
| Undo / redo | `Ctrl+Z`, `Ctrl+Shift+Z` or `Ctrl+Y` |
| Slow down | `1×` button cycles 1× / 0.75× / 0.5× |
| Switch or add songs | Click the song title. A new song for an existing group copies that group's roster and photos |
| Load audio, photos, v1 exports | Drop files on the page. Photos are matched to members by file name (`ana.jpg` goes to Ana) |

Playback Mode replays the song with times accruing and the current singer glowing. With the linecover
studio running on port 8771, the `AI` chip and per-member AI voice pickers appear as in v1.

## Phone

At 560px wide or less the page becomes one non-scrolling screen sized for an iPhone in portrait:
timeline on top, one row per member, and a dock at the bottom with back 3s, play, retake, and a
3×2 grid of member photos to tap. On the timeline, a tap on a segment selects it and a tap elsewhere
seeks. Edge trimming, lane zoom, and undo history buttons stay desktop only; redo is in the header.

Headphone and lock screen controls play, pause, and skip 3s. The screen stays awake during playback
where the browser allows it, which requires HTTPS.

`server.py` listens on 127.0.0.1 only, so a phone cannot open it as shipped.

## Files

- `server.py`: static files plus the `/api/projects` library API (stdlib only)
- `js/main.js`: UI, holds, history, dialogs
- `js/segments.js`: segment merging and the per-member index used every frame
- `js/player.js`: song clock over the audio element, a timer, or the AI stems
- `js/timeline.js`: waveform and lanes canvas, zoom, trimming
- `js/store.js`: library backends (server files or IndexedDB)
- `js/studio.js`: linecover client and stem playback
