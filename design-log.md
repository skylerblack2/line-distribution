# Design log: Line Distribution

## 2026-10-30 12:24 EDT · Group first, then song

**Story.** Starting a distribution is two ingredients: a group (names, photos, colors) and a song (title, audio).
The Songs dialog should read in that order, so Tyler can start from nothing: load a group file, see the six
faces, then name the song, pick the mp3, and press Create once. What he should take away: "pick the group,
then the song" is the whole setup, and a group file is a reusable thing he keeps in iCloud next to the mp3s.

**What changes in the Songs dialog.**
- The New song form gets two labeled steps, "1. Group" and "2. Song", as small section headings. Two
  headings, because the steps are the story; a wizard with separate screens was rejected as too much
  ceremony for a form that fits on one phone screen.
- Step 1 keeps the Group text field (typing a known group still reuses its roster from the library) and adds
  a "Load group file…" button under it. The button takes a group file or any song JSON and uses only its
  members, so his existing PV6 song files also work as group files.
- Under that, a roster preview: one small circle photo plus first name per member. This is the confirmation
  that the right people are loaded before he commits. Rejected: a text list of names, because photos are the
  part that was tedious to set up and the part worth seeing. When no roster matches, the preview says the
  song starts with five placeholder members he can edit in Settings.
- When a group file is loaded, a "Use library roster" button appears so he can drop it and go back to name
  matching. The loaded roster sticks even if he edits the group name, so renaming a group is possible.
- Step 2 keeps Song title and Artist and adds "Choose audio…" with the picked file name beside it, so Create
  makes the song and attaches the mp3 in one press. Audio stays optional.
- The old "Import JSON" button becomes "Import song JSON" to separate it from the group button. Importing or
  dropping a group-only file anywhere in the app opens this dialog with that group loaded, instead of the old
  "Couldn't read that file".

**Settings.** An "Export group" button next to Export JSON saves the current members as a group file
(`<group>.group.json`), so any group set up by hand becomes reusable.

**Group file shape.** `{ "kind": "linedist-group", "group", "members": [{ name, color, avatar }], "voices" }`.
No song, no segments, no member ids (each new song gets fresh ids, as roster copies already do).

## 2026-10-30 12:26 EDT · Phone fit for the group step

**What changed.** At iPhone width (402px) the "Use library roster" button ran off the right edge of the
dialog, because the button row borrowed the field layout (an empty 82px label column, no wrapping). The
buttons now sit in their own row that wraps, indented to line up with the inputs on desktop and flush left
on phones. The roster preview drops its desktop indent on phones too, so five faces fit per line instead
of four and the six PV6 members take two short lines.

**Why this form.** Kept both buttons visible rather than hiding "Use library roster" behind a menu: it only
appears after a file is loaded, and it is the one way back. Rejected shortening the label to "Clear",
because "clear" reads like it would empty the group. The story is unchanged.
