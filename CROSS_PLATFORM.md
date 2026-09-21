# CrispCast — Cross-Platform Compatibility

An honest, per-OS assessment of CrispCast's core features: high-resolution
screen video capture, system-audio (loopback) capture, an isolated clean
microphone track, and the ffmpeg-based "clean voice → MP4" remux/cleanup step.

This app captures via Electron's `desktopCapturer` + a custom source picker and
`session.setDisplayMediaRequestHandler(...)` with `audio: 'loopback'`, then
processes the result with the bundled `ffmpeg-static` binary (voice denoise +
loudnorm filter chain) and probes with `ffprobe-static`.

TL;DR of the hard parts:

| Feature | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Screen video capture | Works (TCC permission) | Works | X11 works; **Wayland needs PipeWire portal** |
| System-audio loopback | Works (ScreenCaptureKit, macOS 13+) — but see the custom-picker caveat | **Works — officially supported** (WASAPI loopback) | **Not reliable / effectively unsupported** — needs a monitor-source workaround |
| Isolated microphone track | Works | Works | Works |
| ffmpeg clean/remux step | Works | Works | Works |

---

## Does system-audio loopback work on Windows and Linux?

**Windows: Yes.** `audio: 'loopback'` (and `'loopbackWithMute'`) is the one
platform Electron's own docs list as officially supported for loopback system
audio — it is backed by the Windows WASAPI loopback path. No dedicated OS
permission prompt is required for the loopback audio itself; the user still
confirms the screen-share source through the picker. This is the most reliable
system-audio target of the three.

**Linux: No (not reliably).** Electron/Chromium does not wire a system-audio
loopback backend on Linux the way it does on Windows/macOS. A `getDisplayMedia`
request with `audio: 'loopback'` typically resolves with **no audio track**
(or is silently ignored), so `captureSystemAudio` cannot be trusted on Linux.
The practical workaround is to expose the PulseAudio/PipeWire **monitor source**
of the output device as a normal input via `navigator.mediaDevices
.enumerateDevices()` and capture that with `getUserMedia` instead — that is a
different code path than the loopback flow this app uses today. Treat Linux
system audio as **best-effort, verify on target**.

---

## macOS

**Status: Fully supported (primary platform).**

- **Screen video:** Requires the **Screen Recording** permission, granted at
  runtime through TCC (System Settings → Privacy & Security → Screen Recording)
  the first time the app calls `desktopCapturer` / `getDisplayMedia`. There is
  no entitlement for this; it is a user-granted permission. The prompt string
  comes from `NSScreenCaptureUsageDescription` (set via `mac.extendInfo`).
- **System-audio loopback:** Backed by **ScreenCaptureKit** on **macOS 13
  (Ventura) and newer**. `audio: 'loopback'` captures real system output audio.
  On macOS 12 and earlier ScreenCaptureKit loopback is unavailable.
- **Microphone:** Gated by TCC; prompt string is `NSMicrophoneUsageDescription`.
- **Hardened runtime / signing:** The build enables `hardenedRuntime` with
  `build/entitlements.mac.plist`. `disable-library-validation` is required so
  the bundled, separately-signed `ffmpeg` binary can be spawned under hardened
  runtime. For distribution outside your own machines the DMG/zip must be
  **code-signed and notarized** (not configured here — `dmg.sign` is false and
  no signing identity is wired up). Unsigned builds will be Gatekeeper-blocked
  on other Macs. **Verify on target: signing + notarization.**
- **Custom-picker caveat:** This app selects a source with its own
  `desktopCapturer.getSources()` picker (`useSystemPicker` is not enabled).
  There is a known Electron issue where, with a custom picker, a `'loopback'`
  audio request is accepted but the native capture session is not always wired
  up, yielding a silent system-audio track. If system audio comes back empty on
  macOS, switching to the native system picker (`useSystemPicker: true`) is the
  known fix. **Verify on target.**

## Windows

**Status: Supported.**

- **Screen video:** `desktopCapturer` / `getDisplayMedia` works without a
  special OS permission prompt (Windows has no TCC-style screen-capture gate for
  desktop apps).
- **System-audio loopback:** **Works** via WASAPI loopback — the officially
  supported platform for `audio: 'loopback'`. See the Q&A section above.
- **Microphone:** Works. Windows 10/11 has a per-app Microphone privacy toggle
  (Settings → Privacy → Microphone); if it is off the mic track will be silent.
- **Installer:** NSIS (`x64`), icon `assets/icon.ico`. Not code-signed here, so
  SmartScreen will warn on first run until you add an Authenticode certificate.
  **Verify on target: signing.**

## Linux

**Status: Weakest platform — partial, with real caveats.**

- **Screen video (X11):** `desktopCapturer.getSources()` /
  `getDisplayMedia` work on X11 sessions.
- **Screen video (Wayland):** Chromium/Electron cannot enumerate windows/screens
  directly under Wayland for security reasons; capture goes through the
  **`xdg-desktop-portal` + PipeWire** screen-cast portal. This means:
  - The PipeWire portal (and a matching backend, e.g. `xdg-desktop-portal-gnome`
    / `-kde` / `-wlr`) must be installed and running.
  - `getSources()` typically returns a **single** PipeWire source, and the user
    picks the actual window/screen in the **compositor's own portal dialog**,
    not in the app's picker — so this app's custom source list is largely
    bypassed on Wayland.
  - If the compositor refuses enumeration the source list can come back empty.
  - Electron may need `--enable-features=WebRTCPipeWireCapturer` (older builds)
    and/or `--ozone-platform-hint=auto` depending on version/distro.
  **Verify on target (per compositor).**
- **System-audio loopback:** **Not reliable / effectively unsupported** — see
  the Q&A section. Requires the PulseAudio/PipeWire monitor-source workaround,
  which is a different capture path than the current loopback flow.
- **Microphone:** Works via PulseAudio/PipeWire.
- **Packaging:** AppImage + deb (`x64`), icon `assets/icon.png`, category
  `AudioVideo`.

**Bottom line for Linux: Wayland screen capture + system-audio loopback is the
weakest combination.** X11 + microphone is solid; system audio needs the
monitor-source workaround and Wayland screen capture depends on a working
PipeWire portal.

---

## ffmpeg / ffprobe cross-platform notes

The clean-voice denoise/loudnorm filter chain and the MP4 remux run through
`ffmpeg-static`, and probing runs through `ffprobe-static`. Both ship binaries
for **macOS, Windows and Linux**, so the processing step itself is fully
cross-platform. Two packaging details matter:

1. **`ffmpeg-static` only downloads the binary for the host it installs on.**
   Its `postinstall` (`install.js`) fetches a single binary for the current
   `platform`/`arch` (or `npm_config_platform` / `npm_config_arch`), and the
   binary is **not** committed to the package's `files` list. Therefore a build
   made on macOS will only contain the macOS ffmpeg. To produce working Windows
   or Linux installers you must obtain the target's ffmpeg binary — either build
   on that OS/CI runner, or re-fetch with the target env vars before packaging
   (`npm_config_platform` / `npm_config_arch`, or `FFMPEG_BINARIES_URL` /
   `FFMPEG_BIN`). `electron-builder` does **not** cross-download this for you.
   *(`ffprobe-static` is different — it ships all
   `bin/<platform>/<arch>/ffprobe` binaries in the published package, so it is
   genuinely cross-platform out of the box.)*

2. **The binaries must be unpacked from the asar archive.** Both packages
   resolve their binary path from `__dirname` (ffmpeg-static returns
   `.../node_modules/ffmpeg-static/ffmpeg`; ffprobe-static returns
   `.../node_modules/ffprobe-static/bin/<platform>/<arch>/ffprobe`). Inside a
   packed `app.asar` that path points into the virtual archive, and a child
   process **cannot execute a file from inside asar**. The build config lists
   both packages under **`asarUnpack`**, which places them in
   `app.asar.unpacked/...` on disk so they are real, executable files at
   runtime.

   > **Runtime code caveat (verify on target):** `require('ffmpeg-static')`
   > still returns a string containing `app.asar`, even though the file lives in
   > `app.asar.unpacked`. Packaged apps normally rewrite it with
   > `ffmpegPath.replace('app.asar', 'app.asar.unpacked')` before spawning. The
   > current `main.js` spawns the raw path from `require('ffmpeg-static')` and
   > does **not** apply this replacement, so in a packaged build ffmpeg may fail
   > to launch (`ENOENT` / spawn error) even though `asarUnpack` placed the file
   > correctly. This app-code change is outside this packaging task's scope but
   > must be handled for packaged builds to run. The same applies to the
   > `ffprobe-static` path if/when it is spawned.

---

## Assumptions to verify on real target machines

- **ffmpeg binary per target OS** — a mac-built package ships only the mac
  ffmpeg; get the right binary onto Windows/Linux builds (build on that OS/CI).
- **asar → asar.unpacked path rewrite in `main.js`** — required for the bundled
  ffmpeg to spawn from a packaged build (see caveat above).
- **macOS signing + notarization** — not configured; required for distribution
  to other Macs.
- **Windows Authenticode signing** — not configured; SmartScreen will warn.
- **macOS custom-picker loopback** — confirm system audio is non-silent; if not,
  try `useSystemPicker: true`.
- **Linux Wayland** — confirm a working `xdg-desktop-portal` + PipeWire backend;
  screen picking happens in the compositor dialog.
- **Linux system audio** — expect to need the PulseAudio/PipeWire monitor-source
  workaround; the current loopback path will not deliver audio.
- **App icons** — `assets/icon.icns`, `assets/icon.ico`, `assets/icon.png` are
  owned by another agent; confirm they exist before `dist`.
