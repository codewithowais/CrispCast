const { app, BrowserWindow, ipcMain, desktopCapturer, session, systemPreferences, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// In a packaged build the binary is unpacked from the asar archive (see
// asarUnpack in package.json); rewrite the path so it stays executable.
// In dev the path contains no 'app.asar', so this is a no-op.
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

// Voice-cleanup filter chain (fully offline, no model file needed):
//  highpass  – drop low rumble / room hum
//  afftdn    – spectral (FFT) noise reduction: fans, hiss, AC
//  anlmdn    – gentle non-local-means denoise for residual broadband noise
//  loudnorm  – EBU R128 loudness normalization so the voice sits at a clean level
const VOICE_FILTER =
  'highpass=f=80,afftdn=nr=18:nf=-28,anlmdn=s=0.0005,loudnorm=I=-16:TP=-1.5:LRA=11';

const SELFTEST = process.argv.includes('--selftest');

// Set the app name early (affects the macOS menu bar and dock label in dev).
app.setName('CrispCast');

let mainWindow;

// The source the renderer picked, read by the display-media request handler below.
let selectedSourceId = null;
// Whether to also capture system (computer) audio via ScreenCaptureKit loopback.
let captureSystemAudio = true;

// User-chosen output folder, persisted in userData/settings.json. Falls back to
// the OS "Videos" folder (Movies on macOS, Videos on Windows/Linux) — resolved
// per-platform by Electron, so no hardcoded, mac-only path.
let recordingsDir = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultRecordingsDir() {
  let base;
  try {
    base = app.getPath('videos');
  } catch (_) {
    base = app.getPath('home');
  }
  return path.join(base, 'CrispCast');
}

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    if (s && typeof s.recordingsDir === 'string') recordingsDir = s.recordingsDir;
  } catch (_) {}
  if (!recordingsDir) recordingsDir = defaultRecordingsDir();
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({ recordingsDir }, null, 2));
  } catch (_) {}
}

function ensureRecordingsDir() {
  if (!recordingsDir) recordingsDir = defaultRecordingsDir();
  try {
    fs.mkdirSync(recordingsDir, { recursive: true });
  } catch (_) {
    // If the saved folder is gone/unwritable, fall back to the default.
    recordingsDir = defaultRecordingsDir();
    fs.mkdirSync(recordingsDir, { recursive: true });
  }
  return recordingsDir;
}

function createWindow() {
  // On Windows/Linux the window/taskbar icon comes from this file; on macOS the
  // dock icon comes from the packaged .icns, so a missing file here is harmless.
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const winIcon = fs.existsSync(iconPng) ? iconPng : undefined;

  mainWindow = new BrowserWindow({
    width: 860,
    height: 740,
    minWidth: 380,
    minHeight: 480,
    title: 'CrispCast',
    icon: winIcon,
    backgroundColor: '#0e0f13',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep capturing at full frame rate even if the window is in the background.
      backgroundThrottling: false
    }
  });

  // Grant screen capture + (optionally) system-audio loopback when the renderer
  // calls navigator.mediaDevices.getDisplayMedia(). On macOS this is backed by
  // ScreenCaptureKit, so `audio: 'loopback'` captures real system audio.
  //
  // We render our own in-app source grid on every platform and honor the source
  // the user picks (useSystemPicker: false). Windows/Linux list all windows this
  // way; macOS 14+ restricts enumeration to the screen + windows on the current
  // desktop (an OS privacy rule), so the UI tells macOS users to focus a window
  // and Refresh to capture others. On macOS this path also captures system-audio
  // loopback (verified).
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources) => {
          const source =
            sources.find((s) => s.id === selectedSourceId) || sources[0];
          callback({
            video: source,
            audio: captureSystemAudio ? 'loopback' : undefined
          });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );

  mainWindow.loadFile(SELFTEST ? 'selftest.html' : 'index.html');
}

app.whenReady().then(() => {
  loadSettings();
  // In development the macOS dock shows Electron's default icon; set ours
  // explicitly. (A packaged build uses the .icns from the bundle instead.)
  if (process.platform === 'darwin' && app.dock) {
    const iconPng = path.join(__dirname, 'assets', 'icon.png');
    try {
      if (fs.existsSync(iconPng)) app.dock.setIcon(iconPng);
    } catch (_) {}
  }
  // Show "CrispCast" in the macOS menu bar + About panel (in a packaged build
  // the app bundle already provides this; this covers the `npm start` dev run).
  app.setAboutPanelOptions({
    applicationName: 'CrispCast',
    applicationVersion: app.getVersion(),
    credits: 'Crisp screen, clean voice.'
  });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'CrispCast',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ]));
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC ----

// Return available screens + windows with thumbnails for the picker UI.
ipcMain.handle('list-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    // Higher-res thumbnails so the preview snapshot looks crisp, not upscaled.
    thumbnailSize: { width: 1280, height: 800 },
    fetchWindowIcons: true
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen') ? 'screen' : 'window',
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null
  }));
});

// Renderer tells us which source + whether to grab system audio, right before
// it calls getDisplayMedia (the handler above reads these).
ipcMain.handle('set-capture-config', (_e, { sourceId, systemAudio }) => {
  selectedSourceId = sourceId;
  captureSystemAudio = !!systemAudio;
  return true;
});

// Report screen-recording / microphone permission status. Only macOS gates
// these at the OS level; on Windows/Linux there's no TCC-style prompt.
ipcMain.handle('get-permissions', () => {
  if (process.platform !== 'darwin') {
    return { screen: 'granted', microphone: 'granted', platform: process.platform };
  }
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    platform: 'darwin'
  };
});

ipcMain.handle('ask-microphone', async () => {
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch {
    return false;
  }
});

// Save a recorded blob (sent as an ArrayBuffer) to the recordings folder.
ipcMain.handle('save-recording', async (_e, { fileName, buffer }) => {
  const dir = ensureRecordingsDir();
  const filePath = path.join(dir, fileName);
  await fs.promises.writeFile(filePath, Buffer.from(buffer));
  return filePath;
});

ipcMain.handle('open-recordings-folder', async () => {
  const dir = ensureRecordingsDir();
  await shell.openPath(dir);
  return dir;
});

// Return the current save folder (creating it lazily is deferred to save time).
ipcMain.handle('get-recordings-dir', () => {
  if (!recordingsDir) recordingsDir = defaultRecordingsDir();
  return recordingsDir;
});

// Let the user pick a new save folder via the native dialog; persist it.
ipcMain.handle('choose-recordings-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where recordings are saved',
    defaultPath: recordingsDir || defaultRecordingsDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return recordingsDir;
  recordingsDir = res.filePaths[0];
  saveSettings();
  return recordingsDir;
});

ipcMain.handle('reveal-file', async (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

// macOS has no programmatic prompt for screen-recording access; open the pane.
ipcMain.handle('open-screen-settings', async () => {
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  );
});

// ---- Clean voice + remux into a final MP4 ----
// Denoises the isolated mic track, mixes it back with the screen recording's
// system audio (if any), and re-encodes to H.264/AAC MP4.
function parseTimeToSeconds(str) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(str);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

// Shared ffmpeg runner: spawns ffmpeg, streams a 0–100% progress via
// 'remux-progress', and resolves with the output path + size.
function runFfmpeg(event, args, outPath, durationSec) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    // MediaRecorder WebM has no duration header, so seed from the known length.
    let totalDur = durationSec && durationSec > 0 ? durationSec : 0;
    let stderr = '';

    ff.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (!totalDur) {
        const dm = /Duration:\s*(\d+:\d+:\d+\.\d+)/.exec(s);
        if (dm) totalDur = parseTimeToSeconds(dm[1]);
      }
      const tm = /time=(\d+:\d+:\d+\.\d+)/.exec(s);
      if (tm && totalDur > 0) {
        const pct = Math.min(99, Math.round((parseTimeToSeconds(tm[1]) / totalDur) * 100));
        event.sender.send('remux-progress', pct);
      }
    });

    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        event.sender.send('remux-progress', 100);
        resolve({ path: outPath, size: fs.statSync(outPath).size });
      } else {
        reject(new Error('ffmpeg failed (code ' + code + ').\n' + stderr.slice(-600)));
      }
    });
  });
}

ipcMain.handle('clean-and-remux', (event, { videoPath, voicePath, hasSystemAudio, durationSec }) => {
  if (!fs.existsSync(videoPath) || !fs.existsSync(voicePath)) {
    return Promise.reject(new Error('Source files not found.'));
  }
  const outPath = videoPath.replace(/\.webm$/i, '') + '-clean.mp4';
  const filter = hasSystemAudio
    ? `[1:a]${VOICE_FILTER}[vc];[0:a][vc]amix=inputs=2:duration=longest:normalize=0[aout]`
    : `[1:a]${VOICE_FILTER}[aout]`;
  const args = [
    '-y', '-i', videoPath, '-i', voicePath,
    '-filter_complex', filter,
    '-map', '0:v:0', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '256k',
    outPath
  ];
  return runFfmpeg(event, args, outPath, durationSec);
});

// Compress any produced file into a smaller, shareable MP4.
// levels: 'balanced' → cap at 1080p, CRF 30; 'small' → cap at 720p, CRF 32.
ipcMain.handle('compress-video', (event, { inputPath, level, durationSec }) => {
  if (!fs.existsSync(inputPath)) {
    return Promise.reject(new Error('File not found: ' + inputPath));
  }
  const originalSize = fs.statSync(inputPath).size;
  const cap = level === 'small' ? 720 : 1080;
  const crf = level === 'small' ? '32' : '30';
  const audioKbps = level === 'small' ? '96k' : '128k';
  const base = inputPath.replace(/\.(webm|mp4|mov|mkv)$/i, '');
  const outPath = `${base}-compressed-${cap}p.mp4`;
  const args = [
    '-y', '-i', inputPath,
    // Downscale only if taller than the cap (never upscale); keep width even.
    '-vf', `scale=-2:min(${cap}\\,ih)`,
    '-c:v', 'libx264', '-crf', crf, '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', audioKbps,
    outPath
  ];
  return runFfmpeg(event, args, outPath, durationSec).then((r) => ({
    ...r,
    originalSize
  }));
});

// ---- Self-test: write recorded files + a JSON report, then quit ----
ipcMain.handle('selftest-done', async (_e, report) => {
  const dir = ensureRecordingsDir();
  fs.writeFileSync(
    path.join(dir, 'selftest-report.json'),
    JSON.stringify(report, null, 2)
  );
  setTimeout(() => app.quit(), 300);
  return true;
});
