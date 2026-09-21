# Releasing CrispCast

Prebuilt installers for macOS, Windows, and Linux are produced automatically by
GitHub Actions and published to the repository's
[Releases page](https://github.com/codewithowais/CrispCast/releases).

## Cutting a release

1. Bump the version in `package.json` (e.g. `0.1.0` → `0.1.1`). This value becomes
   the release tag/version electron-builder uses.
2. Commit the change:
   ```bash
   git add package.json
   git commit -m "Release v0.1.1"
   ```
3. Create a matching tag (must start with `v`):
   ```bash
   git tag v0.1.1
   ```
4. Push the commit and the tag:
   ```bash
   git push origin main
   git push origin v0.1.1
   ```

Pushing the `v*` tag triggers the **Release** workflow
(`.github/workflows/release.yml`). It runs a build matrix across
`macos-latest`, `windows-latest`, and `ubuntu-latest`; each runner builds only
its own OS targets and publishes them to a single GitHub Release for that tag:

- **macOS** — `.dmg` and `.zip` (arm64 + x64)
- **Windows** — NSIS `.exe` installer (x64)
- **Linux** — `.AppImage` and `.deb` (x64)

You can also run the workflow manually from the **Actions** tab
(**workflow_dispatch**) without pushing a tag.

## How the build works

- **CI uses Node 20.** electron-builder 26 requires Node ≥ 20, so the workflow
  pins `node-version: 20`.
- **`ffmpeg-static` / `ffprobe-static` download the correct per-OS binary during
  `npm install`** on each runner. That is why the matrix build works: every OS
  runner fetches its own native ffmpeg/ffprobe binaries at install time, and they
  are bundled via the `asarUnpack` entries in `package.json`.
- Publishing uses electron-builder's GitHub provider with `--publish always`. The
  workflow passes the automatically provided `GITHUB_TOKEN` as `GH_TOKEN` — **no
  extra secrets are required.**

## Builds are UNSIGNED

These installers are **not code-signed or notarized**. macOS builds skip signing
via `CSC_IDENTITY_AUTO_DISCOVERY: false`, and there is no Windows Authenticode
certificate. Users will see OS security warnings and must bypass them manually.

### macOS (Gatekeeper)

Because the app is unsigned/unnotarized, macOS will say the app is damaged or
from an unidentified developer. To open it:

1. Drag **CrispCast** to Applications from the `.dmg`.
2. Right-click (or Control-click) the app and choose **Open**.
3. In the dialog, click **Open** again.

If macOS still blocks it, go to **System Settings → Privacy & Security**, scroll
to the security notice about CrispCast, and click **Open Anyway**.

### Windows (SmartScreen)

Windows Defender SmartScreen may show a "Windows protected your PC" prompt for
the unsigned NSIS installer. Click **More info**, then **Run anyway**.

### Linux

Make the AppImage executable before running it
(`chmod +x CrispCast-*.AppImage`), or install the `.deb` with your package
manager. No signing warning applies.

## Repo setup (one-time)

- Ensure **GitHub Actions is enabled** for the repository
  (Settings → Actions → General).
- No additional secrets are needed: the workflow authenticates to the Releases
  API with the built-in `GITHUB_TOKEN`, granted `contents: write` permission in
  the workflow.
