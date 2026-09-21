# Contributing to CrispCast

Thanks for your interest in improving CrispCast! Bug reports, ideas, and pull
requests are all welcome.

## Getting set up

You'll need [Node.js](https://nodejs.org) (electron-builder prefers **Node ≥ 20**
for packaging) and npm.

```bash
git clone https://github.com/codewithowais/CrispCast.git
cd CrispCast
npm install   # also fetches the host platform's ffmpeg-static binary
npm start     # launches the app via electron .
```

On macOS you'll be prompted for **Screen Recording** and **Microphone**
permissions on first run — grant them, then fully quit and relaunch. See
[CROSS_PLATFORM.md](CROSS_PLATFORM.md) for the per-OS details.

## Project layout

| Path | What it is |
|------|------------|
| `main.js` | Electron main process — window setup, source picking, save paths, and the ffmpeg "clean voice → MP4" pipeline |
| `preload.js` | Secure bridge exposing a small API to the renderer |
| `renderer.js` | UI logic — capture, recording state, quality settings |
| `index.html` | App markup |
| `styles.css` | App styling |
| `assets/` | Icons and images |
| `build/` | Packaging resources (entitlements, etc.) |
| `selftest.js` / `selftest.html` | Headless capture + clean-voice self-test |

## Running the self-test

CrispCast ships a self-test that exercises a real capture and the ffmpeg
clean/merge step end to end:

```bash
electron . --selftest
```

Run this after changes to the capture or ffmpeg pipeline to confirm nothing
regressed.

## Coding style

There's no build step or linter to fight — just **match the style already in the
file** you're editing (2-space indentation, semicolons, existing naming). Keep
changes focused and easy to review.

## Reporting issues

Open an issue at
[github.com/codewithowais/CrispCast/issues](https://github.com/codewithowais/CrispCast/issues).
For capture or audio problems, please include:

- Your OS and version, and whether you're on X11 or Wayland (Linux)
- Electron version (`npx electron --version`)
- What you expected vs. what happened, and any console output

## Pull requests

1. Fork the repo and create a branch (`git checkout -b my-fix`).
2. Make your change and test it (`npm start`, plus `electron . --selftest` for
   capture/ffmpeg changes).
3. Keep the diff scoped to one thing and write a clear commit message.
4. Open a PR describing the change and how you verified it.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
