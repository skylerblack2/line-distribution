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
| Switch or add songs | Click the song title. New song is two steps: pick the group, then name the song and choose its audio. A group already in the library reuses its roster and photos |
| Start from a group file | In Songs, `Load group file…` takes a `.group.json` (or any song JSON) and previews the members and photos before you create the song. Importing or dropping a group file opens the same step |
| Save a group file | Settings → `Export group` writes `<group>.group.json`: names, colors, photos, AI voices, no song |
| Session log | Each song keeps a log of seeks (what triggered them and where they landed), plays and pauses (song time played against wall time), every press and how it ended (release, tap-off, handoff, pause, seek), undo/redo/delete/trim, mode and speed switches, audio clock stalls, the audio file's type and size, and the device. Export JSON includes it as `log`; group files leave it out |
| Load audio, photos, v1 exports | Drop files on the page. Photos are matched to members by file name (`ana.jpg` goes to Ana) |

Playback Mode replays the song with times accruing and the current singer glowing. With the linecover
studio running on port 8771, the `AI` chip and per-member AI voice pickers appear as in v1.

## Audio format

Use M4A (AAC) audio. On the iPhone, seeks inside variable-bitrate MP3s (what yt-dlp's best-quality MP3 writes) land
away from where the audio clock says, so every line recorded after a retake or skip is shifted. The error follows
the song's bitrate: early through sparse passages, late through dense ones, up to two seconds in testing. M4A files
carry an exact time index. `yt-dlp -f "bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a` copies YouTube's AAC
stream without re-encoding.

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
