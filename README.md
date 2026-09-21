# CrispCast

*Crisp screen, clean voice.*

A cross-platform desktop app (Electron) that records your **screen in high resolution** while capturing **system audio + your microphone** — with the mic saved as a **separate, raw voice track**, plus a one-click step to denoise the voice and export a merged MP4.

## Why a desktop app (not a web app)
On macOS, browsers can't reliably capture **system/computer audio**. This app uses Electron 34+, which is backed by Apple's **ScreenCaptureKit**, so `audio: 'loopback'` captures real system audio natively — something the browser route can't do on a Mac.

## Platforms
Works on **macOS** (fully), **Windows** (fully — system-audio loopback is WASAPI-backed), and **Linux** (screen + mic; system-audio loopback is unreliable — X11 preferred over Wayland). See [CROSS_PLATFORM.md](CROSS_PLATFORM.md) for the detailed per-OS breakdown.

## What you get per recording
Recordings save to a folder you choose (default: **`Movies/CrispCast`** on macOS, **`Videos/CrispCast`** on Windows/Linux). Change it any time via the **Save to → Change…** bar in the app.

| File | Contents |
|------|----------|
| `recording-<timestamp>.webm` | Screen video (native resolution) + system audio |
| `recording-<timestamp>-voice.webm` | Your microphone, **raw** — no noise suppression, gain, or echo cancellation |
| `recording-<timestamp>-clean.mp4` | *(after clicking "Clean voice → MP4")* Final H.264/AAC video with the denoised voice mixed back in |

Keeping the voice on its own track is deliberate: it's the easiest thing to run through noise removal, then remux back onto the video.

## Clean voice & merge (built in)
After a recording finishes, click **"Clean voice → MP4"**. The app (using a bundled `ffmpeg-static` binary — no install needed) runs an offline denoise chain on your raw mic track and mixes it back with the system audio, exporting a single MP4:

```
highpass=f=80,afftdn,anlmdn,loudnorm   # remove rumble, hiss, AC noise; normalize loudness
```

- No cloud, no model download — fully offline.
- Output is **H.264 MP4** that plays everywhere (QuickTime, iMovie, web).
- The original raw `.webm` files are kept, so you can always re-clean with different settings.

To tune how aggressive the cleanup is, edit `VOICE_FILTER` in [`main.js`](main.js).

## Setup
```bash
npm install
npm start
```

### Building installers
```bash
npm run pack    # unpacked app for the current OS (quick test)
npm run dist    # full installers (.dmg/.zip, .exe, .AppImage/.deb)
```
Notes: `electron-builder` prefers Node ≥20 (this repo was scaffolded on Node 16 — upgrade before building). `ffmpeg-static` only downloads the *host* platform's binary, so build each OS on that OS (or a CI matrix). Details in [CROSS_PLATFORM.md](CROSS_PLATFORM.md).

### First run (macOS) — grant Screen Recording permission
macOS blocks screen capture until you allow it:
1. In the app, click **Open Screen Recording settings** (or: System Settings → Privacy & Security → Screen Recording).
2. Enable **Electron** (dev) / **CrispCast** (packaged).
3. **Fully quit and relaunch** the app.

On **Windows/Linux** there's no such permission gate.

The app also asks for **Microphone** permission on first launch.

## Quality settings
- **Video quality**: High (~10 Mbps) / Ultra (~24 Mbps) / Max (~40 Mbps). Capture is always at the source's native resolution; bitrate controls sharpness.
- **Frame rate**: 30 or 60 fps.
- **Audio**: system audio at 192 kbps Opus; mic at 256 kbps Opus (transparent for voice).

## Verified on
macOS 26 (Tahoe), Apple Silicon, Electron 34.5.8 — a self-test captured 3024×1964 @ 30fps with a working system-audio loopback track + separate mic track, then produced a clean H.264/AAC MP4.

## Roadmap ideas
- Optional RNNoise (`arnndn`) model for even stronger voice denoise
- Countdown timer, pause/resume, region selection
- Webcam overlay (picture-in-picture)
