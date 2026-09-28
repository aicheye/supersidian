# Supersidian

A personal tool built for one tablet, one laptop and one vault. It is public to read, not supported for other setups, and has no license.

Handwritten Supernote notebooks in an Obsidian vault, synced over the USB cable or over Tailscale without it. Pages land in the lecture note for the day they were written, strokes show in Obsidian as you write them, and Claude Code transcribes each page, fills in topics and links related lectures. A dashboard in `Home.md` tracks classes and deadlines.

Two plugins work together:

- `src/` is the Obsidian plugin (desktop, Linux).
- `tablet/` is a Supernote plugin (React Native, `sn-plugin-lib`) for Chauvet firmware with plugin support (tested on the Nomad with `Chauvet.E103.2609111001.2505_beta`).

## What it does

**Sync.** Every second the Obsidian plugin lists `/sdcard/Note/<term>/<course>/<Notebook>.note` on the tablet through the adb server, copies any notebook whose mtime or size changed, and runs `render.py` on it. Since saves append to the file, only the bytes after the last copy are pulled (with a 64 KB overlap compared to confirm the old copy is a prefix). Only pages whose layer data changed are re-rendered. When adb has no tablet, it uses the notebooks the tablet sent over HTTPS (below), then the desktop's MTP mount.

**Sync without the cable.** The tablet plugin sends to the laptop over HTTPS through Tailscale, so nothing on the tablet listens (its adb has no authentication, see Known limits). `tailscale serve` on the laptop passes `https://<laptop>.<tailnet>.ts.net:8443` to a server the Obsidian plugin runs on `127.0.0.1:47300` (`src/push.ts`). After each save the tablet asks how many bytes of the notebook the laptop has and sends the rest, starting 64 KB early so the laptop can confirm its copy is a prefix (409 asks for the whole file). It reads the file again 1, 2.5 and 5 s later and sends anything new, since `saveCurrentNote()` can return before the file is fully written. Live messages go in batches, one request in flight at a time, to a second port (10000). `tailscale serve` speaks HTTP/2, so requests to one port share one TCP connection, and live messages sent during a 0.4 to 2 MB upload arrived up to 1.1 s late. A request stuck for 5 s (live) or 30 s (upload) is cancelled at the next pen sample; checks run on events because the plugin host pauses JS timers while its screen is closed. A WebSocket was tried and does not work in the plugin host: connections are accepted but never report open. Every request carries a token that the laptop writes to `/sdcard/Note/.supersidian.json` over USB, together with the address. While the cable is in, the laptop answers `{"usb": true}` and the tablet stops sending for 10 s at a time. Only notebooks the tablet saves or closes while the plugin runs are sent.

**Vault layout.** Device folder `2a/cs241e` maps to vault folder `2A/CS241E` (ignoring case). Every tablet notebook is a section folder in its course:

- `<COURSE>.md`: the course page. Its "Sections" list (between `<!-- supersidian:sections -->` markers) links each section's index with its number of notes.
- `<Section>/<PREFIX>-<YYYY-MM-DD>.md`: one note per day (`LEC-` for Lectures, `TUT-` for Tutorials, `LAB-` for Labs, the notebook name otherwise, e.g. `Psets-2025-09-10.md`). Each page is embedded in the note for the day it was created, inside a `<!-- supersidian:begin -->` / `<!-- supersidian:end -->` block under `## Notes`. A day with pages and no note gets one.
- `<Section>/<Section>.md`: the section's index, generated: every dated note by month with its first topics. Section folders without a notebook (tutorials without handwriting) get one too.
- `assets/notes/<Notebook>/<YYYYMMDD-HHMMSS>.png`: one image per page, named from the creation time in the page ID (`P<YYYYMMDDHHMMSS>…`, device local time). Pages created in the same second also get the microseconds. `styles.css` hides `assets` folders in the file explorer.
- `<TERM>/<TERM>.md`: the term's course list.

**Your text is kept.** Text typed under a page image inside the block stays with that page across syncs. Text under a deleted page moves to the end of the block.

**Rendering.** Pages render at full page size as ink only (no template), with darkness as opacity. `styles.css` draws each image as a mask over `--text-normal`, so ink follows the theme. Blank pages are not embedded.

**Live ink.** The tablet plugin writes pen positions (while a stroke is drawn) and each finished stroke's outline to the Android log with `console.log`, in 900-character chunks: `SSD1 <id> <index> <count> <pen|ink|erase> <JSON>`. The Obsidian plugin streams `logcat` through the adb server and draws the strokes over the page's image in the note: a line while the pen moves, the exact outline once it lifts. The strokes sit on a layer fixed over the window that follows the image as the note scrolls, so the editor is never modified. When a newer image loads, strokes that arrived before the tablet's save are removed from the layer, since the image has them. A blank page that gets live ink is embedded until the next sync. Strokes for a page that has not synced yet are replayed after the sync that adds it. The plugin host cannot make plain `http://` requests, which is why the log is used over USB; without the cable the same messages go over HTTPS, and the laptop drops a message whose id it already handled. A live line's width is the pen's width setting × 0.0098 page pixels. The tablet sends a stroke's first points before the message naming its page, so points wait up to 1 s for it; otherwise the start of the first stroke after a page turn was drawn on the old page.

**Erasing.** The tablet's eraser removes every stroke its path touches and every stroke inside the loop it draws. Neither the motion events nor `getPenInfo` tell the eraser from the pen or lasso, but an eraser motion's pen-up event arrives about 150 ms after the lift with no elements, and the tablet sends an `erase` message then. `render.py` decodes each re-rendered page's visible strokes from the `.note` file (`page_strokes`: TOTALPATH records, less eraser motions, lasso loops and strokes an eraser record touches or encloses). While an eraser motion is drawn, Obsidian covers every stroke of the page image within 6 px of it (plus half the stroke width) with the stroke's own shape in the background color and hides live strokes it reaches; when it lifts, strokes inside the loop go too. The re-rendered image replaces the covers once the save arrives. After an eraser motion the next motion is drawn as an eraser, after a lasso as a dashed line, since the tool usually stays selected; a motion that turns out to be ink is redrawn as ink and its covers are undone. Lasso loops reach the plugin as strokes with pen type 4 and are not drawn.

**Saving on the tablet.** Each `saveCurrentNote()` appends to the `.note` file, so the tablet plugin saves only when needed: on a page change (checked after every tap), once the first stroke on a new page is drawn (a save does not write a page with no strokes yet), and after an erase. The note app records an erase about 50 ms after the pen lifts and declines a save while it is processing a stroke, so the erase save runs 100 ms after the erase is detected (0.8 s after the lift if the pen-up event was missed), and once more 1.2 s later once the pen has been up 0.5 s (a save with nothing new writes nothing). The tablet also saves when a notebook is closed, and compacts the file on its own later.

**Transcripts.** Pages unchanged for 60 s, in notes that are not open, are sent to `claude -p` (the user's Claude Code login, no API key) 5 per call, 3 calls at a time. Each page gets a collapsed transcript callout, its topics fill an empty `## Topics` section, and its concepts become `#concept/…` tags: every concept that another note also has is a tag, so each tag links at least two notes, and concepts only one note has are listed as text. Notes sharing two or more concepts link to each other under "Related".

**School.** `Deadlines.md` holds one task per deliverable (`- [ ] **YYYY-MM-DD** — title ^dl-id`). `Home.md` gets today's classes, this week's deadlines, upcoming exams, the latest lecture per course and open follow-up questions; checking a task there checks it in `Deadlines.md`. Every 15 minutes Claude Code reads Gmail (search and read only) for new deliverables and due date changes, and every 10 minutes it mirrors deadlines to Google Calendar.

## Setup

1. Tablet: enable Settings → Security & Privacy → Sideloading (this exposes adb over USB) and accept the USB debugging prompt from the computer.
2. Host adb server, started at login (the Obsidian Flatpak cannot reach USB devices, but it can reach the server on 127.0.0.1:5037):

       mkdir -p ~/.config/systemd/user
       cp contrib/adb-server.service ~/.config/systemd/user/
       systemctl --user enable --now adb-server.service

3. If Obsidian is the Flatpak: `flatpak override --user --filesystem=xdg-run/gvfs md.obsidian.Obsidian` (MTP fallback only).
4. Renderer and plugin:

       uv venv .venv && uv pip install --python .venv/bin/python supernotelib
       npm install && npm run build

   Symlink `main.js`, `manifest.json`, `styles.css` and `render.py` into `<vault>/.obsidian/plugins/supersidian/`, enable the plugin, and set its Python interpreter to `.venv/bin/python`.
5. Tablet plugin: `cd tablet && npm install && ./buildPlugin.sh`, copy `build/outputs/SupersidianTablet.snplg` to the tablet's `MyStyle` folder (`adb push … /sdcard/MyStyle/`), install it from Settings → Apps → Plugins, open its screen from the NOTE toolbar and allow access ("Always allow").
6. Sync without the cable (optional): with Tailscale on both devices, run `sudo tailscale set --operator=$USER` once and `tailscale serve --bg --https=8443 http://127.0.0.1:47300`, and `tailscale serve --bg --https=10000 http://127.0.0.1:47300`, then enter `https://<laptop>.<tailnet>.ts.net:8443` under "Sync address without the cable" and `https://<laptop>.<tailnet>.ts.net:10000` under "Live ink address" in the plugin settings. The tablet gets the address and token the next time the cable is in.

## Development

- `npm test` runs the unit tests in `test/`.
- `node dist/cli.js VAULT_DIR STATE_JSON PYTHON render.py [NOTE_ROOT]` runs one sync without Obsidian.
- Obsidian started with `--remote-debugging-port=9222` can be inspected and scripted over the Chrome DevTools protocol, which is how the plugin was debugged.

## Known limits

- The tablet firmware has `ro.adb.secure=0`: adb accepts any computer without a key. Keep adb on USB only.
- A new page shows in Obsidian about 2 s after the first stroke on it, not when it is created.
- The tablet does not report the active tool. The first eraser motion after using the pen draws as a line until about 150 ms after the lift, and the first stroke after erasing draws as an eraser until then.
- Without the cable, only notebooks the tablet saves or closes while the plugin runs are sent. Each upload reads the whole notebook on the tablet (about 1 s for 49 MB) until the tablet compacts the file.
- Submission status is not detected; deadlines are checked off by hand.
