// ---------- state ----------
let selectedSourceId = null;
let screenStream = null;
let micStream = null;
let videoRecorder = null;
let voiceRecorder = null;
let videoChunks = [];
let voiceChunks = [];
let timerInterval = null;
let startTime = 0;
let recordedSystemAudio = false;
let lastVideoPath = null;
let lastVoicePath = null;
let lastDurationSec = 0;
let allSources = [];
let idlePreviewTimer = null;
let isRecording = false;
let progressCb = null; // routed target for ffmpeg 'remux-progress' events
let isMac = false;

const QUALITY_BITRATE = {
  high: 10_000_000,
  ultra: 24_000_000,
  max: 40_000_000
};

// ---------- elements ----------
const el = (id) => document.getElementById(id);
const sourcesEl = el('sources');
const micSelect = el('micSelect');
const startBtn = el('startBtn');
const stopBtn = el('stopBtn');
const statusEl = el('status');
const resultsEl = el('results');
const timerEl = el('timer');
const dotEl = document.querySelector('.dot');

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + kind;
}

// ---------- permissions ----------
async function refreshPermissions() {
  const p = await window.recorder.getPermissions();
  isMac = p.platform === 'darwin';
  const permsEl = el('perms');
  const chip = (label, state) =>
    `<span class="chip ${state === 'granted' ? 'ok' : 'bad'}" data-perm="${label}">${label}: ${state}</span>`;
  permsEl.innerHTML =
    chip('screen', p.screen) + chip('microphone', p.microphone);

  permsEl.querySelectorAll('.chip.bad').forEach((c) => {
    c.addEventListener('click', async () => {
      if (c.dataset.perm === 'microphone') {
        await window.recorder.askMicrophone();
        await loadMics();
        refreshPermissions();
      } else {
        setStatus(
          'Grant Screen Recording to this app in System Settings → Privacy & Security → Screen Recording, then reopen the app.',
          'err'
        );
      }
    });
  });
}

// ---------- sources ----------
async function loadSources() {
  // macOS: the OS forbids listing windows in-app, so use Apple's native picker
  // (enabled via feature flags in main.js). It lists every window across ALL
  // desktops. Selection happens in that picker when the user presses Start.
  if (isMac) {
    sourcesEl.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'picker-note';
    box.style.gridColumn = '1 / -1';
    const h = document.createElement('div');
    h.className = 'picker-note-title';
    h.textContent = 'Press ● Start recording, then choose your source';
    const p = document.createElement('div');
    p.className = 'hint';
    p.innerHTML =
      "macOS opens its own recorder picker listing <strong>every window across all " +
      "your desktops</strong>, plus <strong>Entire Screen</strong> — pick one there and " +
      "recording begins.<br><br>" +
      "Apple requires this: for privacy, apps can’t list your windows in their own " +
      "UI, so the full list lives in that system picker.";
    box.append(h, p);
    sourcesEl.appendChild(box);
    const emptyEl = el('previewEmpty');
    if (emptyEl) emptyEl.querySelector('span').textContent =
      'Your recording preview appears here once you start';
    return;
  }
  sourcesEl.innerHTML = '<p class="hint">Loading sources…</p>';
  let sources;
  try {
    sources = await window.recorder.listSources();
  } catch (err) {
    sources = [];
  }
  if (!sources || sources.length === 0) {
    sourcesEl.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'hint';
    box.style.gridColumn = '1 / -1';
    box.innerHTML =
      '<strong style="color:var(--accent)">Screen Recording permission needed.</strong><br>' +
      'Enable <em>Electron</em> (or Clean Screen Recorder) under Screen&nbsp;Recording, then fully quit and relaunch the app.';
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.style.marginTop = '10px';
    btn.textContent = 'Open Screen Recording settings';
    btn.addEventListener('click', () => window.recorder.openScreenSettings());
    box.appendChild(document.createElement('br'));
    box.appendChild(btn);
    sourcesEl.appendChild(box);
    setStatus('Grant Screen Recording permission, then relaunch.', 'err');
    return;
  }
  allSources = sources;
  sourcesEl.innerHTML = '';
  sources.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'source';
    div.dataset.id = s.id;

    const thumb = document.createElement('img');
    thumb.src = s.thumbnail; // data: URL from main process
    thumb.alt = '';

    const label = document.createElement('div');
    label.className = 'label';
    if (s.appIcon) {
      const icon = document.createElement('img');
      icon.src = s.appIcon;
      icon.alt = '';
      label.appendChild(icon);
    }
    const nameSpan = document.createElement('span');
    nameSpan.textContent = s.name; // OS-supplied text — never inject as HTML
    label.appendChild(nameSpan);

    const kindWrap = document.createElement('div');
    kindWrap.className = 'label';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = s.kind;
    kindWrap.appendChild(kind);

    div.append(thumb, label, kindWrap);
    div.addEventListener('click', () => selectSource(s.id, div));
    sourcesEl.appendChild(div);
  });
  // Auto-select first screen by default.
  const firstScreen = sources.find((s) => s.kind === 'screen');
  if (firstScreen) {
    const node = sourcesEl.querySelector(`[data-id="${CSS.escape(firstScreen.id)}"]`);
    selectSource(firstScreen.id, node);
  }

  // macOS only exposes the screen + windows on the current desktop (an OS
  // privacy limit). Tell users how to capture a window that isn't listed.
  if (isMac) {
    const tip = el('sourcesTip');
    if (tip) {
      tip.textContent =
        'macOS lists Entire Screen plus windows on your current desktop. ' +
        'To record another window, click it to bring it to the front, then press Refresh.';
      tip.style.display = 'block';
    }
  }
}

function selectSource(id, node) {
  selectedSourceId = id;
  document.querySelectorAll('.source').forEach((n) => n.classList.remove('selected'));
  if (node) node.classList.add('selected');
  showIdlePreview();
  startIdlePreviewLoop();
}

// ---------- idle preview (snapshot of the selected source, before recording) ----------
function showIdlePreview() {
  if (isRecording) return;
  const s = allSources.find((x) => x.id === selectedSourceId);
  const img = el('previewImg');
  const wrap = document.querySelector('.preview-wrap');
  if (s && s.thumbnail) {
    img.src = s.thumbnail;
    img.classList.add('show');
    wrap.classList.add('has-thumb');
  } else {
    img.classList.remove('show');
    wrap.classList.remove('has-thumb');
  }
}

// Periodically refresh the snapshot so the preview tracks the screen — without
// opening a capture stream (so macOS shows no "recording" indicator while idle).
function startIdlePreviewLoop() {
  if (isMac) return; // macOS uses the system picker; no in-app thumbnails
  stopIdlePreviewLoop();
  idlePreviewTimer = setInterval(async () => {
    if (isRecording || !selectedSourceId || !document.hasFocus()) return;
    try {
      allSources = await window.recorder.listSources();
      showIdlePreview();
    } catch (_) {}
  }, 1000);
}
function stopIdlePreviewLoop() {
  if (idlePreviewTimer) {
    clearInterval(idlePreviewTimer);
    idlePreviewTimer = null;
  }
}

// ---------- mics ----------
async function loadMics() {
  try {
    // Prime permission so device labels are populated.
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (_) {}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === 'audioinput');
  micSelect.innerHTML = '';
  mics.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = m.deviceId;
    opt.textContent = m.label || `Microphone ${i + 1}`;
    micSelect.appendChild(opt);
  });
}

// ---------- recording ----------
function pickVideoMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || 'video/webm';
}

async function startRecording() {
  // On macOS the native picker chooses the source at capture time; on
  // Windows/Linux we require a pick from the in-app grid.
  if (!isMac && !selectedSourceId) {
    setStatus('Pick a screen or window to record first.', 'err');
    return;
  }
  resultsEl.innerHTML = '';
  const wantSystemAudio = el('systemAudio').checked;
  const wantMic = el('micEnabled').checked;
  const fps = parseInt(el('fps').value, 10);
  const videoBitrate = QUALITY_BITRATE[el('quality').value];

  try {
    await window.recorder.setCaptureConfig({
      sourceId: selectedSourceId,
      systemAudio: wantSystemAudio
    });

    // Screen video (+ system audio loopback, granted by the main process).
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      audio: wantSystemAudio,
      video: { frameRate: { ideal: fps, max: fps } }
    });

    isRecording = true;
    stopIdlePreviewLoop();
    const pv = el('preview');
    pv.srcObject = screenStream;
    // Autoplay can silently no-op in Electron; force play and reveal the video.
    pv.play().catch(() => {});
    document.querySelector('.preview-wrap').classList.add('live');
    recordedSystemAudio = screenStream.getAudioTracks().length > 0;

    // Microphone — RAW: disable browser DSP so the voice track is untouched.
    micStream = null;
    if (wantMic) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micSelect.value ? { exact: micSelect.value } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
    }

    // Recorder 1: screen video + system audio → the main video file.
    const videoTracks = [
      ...screenStream.getVideoTracks(),
      ...screenStream.getAudioTracks()
    ];
    const videoStream = new MediaStream(videoTracks);
    const mime = pickVideoMime();
    videoChunks = [];
    videoRecorder = new MediaRecorder(videoStream, {
      mimeType: mime,
      videoBitsPerSecond: videoBitrate,
      audioBitsPerSecond: 192_000
    });
    videoRecorder.ondataavailable = (e) => e.data.size && videoChunks.push(e.data);
    videoRecorder.start(1000);

    // Recorder 2: microphone → a separate, isolated voice file for later cleanup.
    voiceRecorder = null;
    if (micStream) {
      voiceChunks = [];
      voiceRecorder = new MediaRecorder(micStream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 256_000
      });
      voiceRecorder.ondataavailable = (e) => e.data.size && voiceChunks.push(e.data);
      voiceRecorder.start(1000);
    }

    // If the user stops sharing from the OS bar, stop cleanly.
    screenStream.getVideoTracks()[0].addEventListener('ended', stopRecording);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    dotEl.classList.add('recording');
    startTimer();
    const bits = [];
    bits.push('screen video');
    if (wantSystemAudio) bits.push('system audio');
    if (micStream) bits.push('mic (separate file)');
    setStatus('Recording ' + bits.join(' + ') + '…', 'ok');
  } catch (err) {
    setStatus('Could not start: ' + err.message, 'err');
    cleanupStreams();
  }
}

async function stopRecording() {
  stopBtn.disabled = true;
  lastDurationSec = startTime ? (Date.now() - startTime) / 1000 : 0;
  stopTimer();
  dotEl.classList.remove('recording');

  const stops = [];
  if (videoRecorder && videoRecorder.state !== 'inactive') {
    stops.push(new Promise((res) => (videoRecorder.onstop = res)));
    videoRecorder.stop();
  }
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    stops.push(new Promise((res) => (voiceRecorder.onstop = res)));
    voiceRecorder.stop();
  }
  await Promise.all(stops);

  setStatus('Saving files…');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const saved = [];
  lastVideoPath = null;
  lastVoicePath = null;

  if (videoChunks.length) {
    const blob = new Blob(videoChunks, { type: 'video/webm' });
    const buf = await blob.arrayBuffer();
    const p = await window.recorder.saveRecording(`recording-${ts}.webm`, buf);
    lastVideoPath = p;
    saved.push({ name: 'Screen video (+ system audio)', path: p, size: blob.size });
  }
  if (voiceChunks.length) {
    const blob = new Blob(voiceChunks, { type: 'audio/webm' });
    const buf = await blob.arrayBuffer();
    const p = await window.recorder.saveRecording(`recording-${ts}-voice.webm`, buf);
    lastVoicePath = p;
    saved.push({ name: 'Voice track (raw, isolated)', path: p, size: blob.size });
  }

  cleanupStreams();
  startBtn.disabled = false;
  await finalizeAndRender(saved);
}

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

// Run an ffmpeg-backed op while showing its progress on `btn`.
async function runWithProgress(btn, label, fn, onDone) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = `${label} 0%`;
  progressCb = (pct) => { btn.textContent = `${label} ${pct}%`; };
  try {
    const res = await fn();
    progressCb = null;
    onDone(res);
  } catch (err) {
    progressCb = null;
    btn.disabled = false;
    btn.textContent = orig;
    setStatus(`${label.replace(/…$/, '')} failed: ${err.message}`, 'err');
  }
}

function resultCard(name, filePath, sizeBytes, opts = {}) {
  const card = document.createElement('div');
  card.className = 'result-card';
  if (opts.accent) card.style.borderColor = opts.accent;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const n = document.createElement('div');
  n.className = 'name';
  n.textContent = name + (sizeBytes != null ? ` · ${mb(sizeBytes)} MB` : '');
  const p = document.createElement('div');
  p.className = 'path';
  p.textContent = filePath;
  meta.append(n, p);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const reveal = document.createElement('button');
  reveal.className = 'ghost small';
  reveal.textContent = 'Reveal';
  reveal.addEventListener('click', () => window.recorder.revealFile(filePath));
  actions.append(reveal);

  card.append(meta, actions);
  return { card, actions };
}

// Add a "Compress → smaller MP4" control (level picker + button) to a card.
function addCompressControl(actions, inputPath) {
  const sel = document.createElement('select');
  sel.className = 'mini';
  [['balanced', '1080p'], ['small', '720p']].forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    sel.appendChild(o);
  });
  const btn = document.createElement('button');
  btn.className = 'ghost small';
  btn.textContent = 'Compress';
  btn.addEventListener('click', () => {
    runWithProgress(
      btn,
      'Compressing…',
      () => window.recorder.compressVideo({
        inputPath,
        level: sel.value,
        durationSec: lastDurationSec
      }),
      (res) => {
        const pct = res.originalSize
          ? Math.max(0, Math.round((1 - res.size / res.originalSize) * 100))
          : 0;
        const label = sel.value === 'small' ? '720p' : '1080p';
        const { card } = resultCard(
          `✓ Compressed (${label}) · ${pct}% smaller`,
          res.path,
          res.size,
          { accent: 'var(--ok)' }
        );
        resultsEl.appendChild(card);
        btn.disabled = false;
        btn.textContent = 'Compress';
        setStatus(`Compressed MP4 ready — ${pct}% smaller.`, 'ok');
      }
    );
  });
  actions.append(sel, btn);
}

// A compact, muted row for the raw source files.
function sourceRow(name, filePath) {
  const row = document.createElement('div');
  row.className = 'source-row';
  const label = document.createElement('span');
  label.className = 'source-label';
  label.textContent = name;
  const reveal = document.createElement('button');
  reveal.className = 'ghost small';
  reveal.textContent = 'Reveal';
  reveal.addEventListener('click', () => window.recorder.revealFile(filePath));
  row.append(label, reveal);
  return row;
}

// An in-progress card with a live percentage while ffmpeg runs.
function progressCard(label) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.style.borderColor = 'var(--accent-2)';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const n = document.createElement('div');
  n.className = 'name';
  n.textContent = `${label} 0%`;
  meta.append(n);
  card.append(meta);
  return { card, setPct: (p) => { n.textContent = `${label} ${p}%`; } };
}

// After recording: auto-clean+merge into one MP4 (the primary result),
// then list the raw tracks as secondary source files.
async function finalizeAndRender(saved) {
  resultsEl.innerHTML = '';
  const rawVideo = saved.find((f) => f.path === lastVideoPath);
  const rawVoice = saved.find((f) => f.path === lastVoicePath);

  let primaryShown = false;

  if (lastVideoPath && lastVoicePath) {
    // Auto clean + merge.
    setStatus('Cleaning voice & merging into one MP4…');
    const prog = progressCard('Cleaning voice & merging…');
    resultsEl.appendChild(prog.card);
    progressCb = (pct) => prog.setPct(pct);
    try {
      const res = await window.recorder.cleanAndRemux({
        videoPath: lastVideoPath,
        voicePath: lastVoicePath,
        hasSystemAudio: recordedSystemAudio,
        durationSec: lastDurationSec
      });
      progressCb = null;
      prog.card.remove();
      const { card, actions } = resultCard(
        '✓ Recording (clean voice + video)', res.path, res.size, { accent: 'var(--ok)' }
      );
      addCompressControl(actions, res.path);
      resultsEl.appendChild(card);
      primaryShown = true;
      setStatus('Done — one clean MP4 is ready.', 'ok');
    } catch (err) {
      progressCb = null;
      prog.card.remove();
      setStatus('Auto clean/merge failed: ' + err.message + ' — raw files are saved below.', 'err');
      // Fall back to a manual retry button.
      const { card, actions } = resultCard('Merge failed — retry manually', lastVideoPath, null, {});
      const retry = document.createElement('button');
      retry.className = 'primary';
      retry.textContent = 'Clean voice → MP4';
      retry.addEventListener('click', () => runWithProgress(
        retry, 'Processing…',
        () => window.recorder.cleanAndRemux({
          videoPath: lastVideoPath, voicePath: lastVoicePath,
          hasSystemAudio: recordedSystemAudio, durationSec: lastDurationSec
        }),
        (res) => {
          const done = resultCard('✓ Clean MP4', res.path, res.size, { accent: 'var(--ok)' });
          addCompressControl(done.actions, res.path);
          resultsEl.appendChild(done.card);
          card.remove();
          setStatus('Clean MP4 ready.', 'ok');
        }
      ));
      actions.append(retry);
      resultsEl.appendChild(card);
    }
  } else if (rawVideo) {
    // No microphone track — the screen recording (with system audio) is the output.
    const { card, actions } = resultCard(
      '✓ Recording (screen + system audio)', rawVideo.path, rawVideo.size, { accent: 'var(--ok)' }
    );
    addCompressControl(actions, rawVideo.path);
    resultsEl.appendChild(card);
    primaryShown = true;
    setStatus('Done.', 'ok');
  }

  // Secondary: the raw source files (skip any already shown as the primary).
  const sources = [];
  if (rawVideo && !(primaryShown && !lastVoicePath)) {
    sources.push(sourceRow('Raw screen video (+ system audio)', rawVideo.path));
  }
  if (rawVoice) sources.push(sourceRow('Raw voice track (isolated, for re-cleaning)', rawVoice.path));

  if (sources.length) {
    const head = document.createElement('div');
    head.className = 'sources-head';
    head.textContent = 'Source files';
    resultsEl.appendChild(head);
    sources.forEach((r) => resultsEl.appendChild(r));
  }
}

function cleanupStreams() {
  [screenStream, micStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  screenStream = null;
  micStream = null;
  el('preview').srcObject = null;
  const wrap = document.querySelector('.preview-wrap');
  if (wrap) wrap.classList.remove('live');
  // Back to idle: restore the snapshot preview and its refresh loop.
  isRecording = false;
  showIdlePreview();
  startIdlePreviewLoop();
}

// ---------- timer ----------
function startTimer() {
  startTime = Date.now();
  timerEl.textContent = '00:00';
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    timerEl.textContent = `${mm}:${ss}`;
  }, 500);
}
function stopTimer() {
  clearInterval(timerInterval);
}

// ---------- save folder ----------
async function loadSaveDir() {
  try {
    const dir = await window.recorder.getRecordingsDir();
    const node = el('saveDir');
    node.textContent = dir;
    node.title = dir;
  } catch (_) {}
}

// ---------- app logo ----------
function loadLogo() {
  const img = el('applogo');
  if (!img) return;
  img.src = 'assets/icon.png';
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => {}; // icon not generated yet — header still shows the dot
}

// ---------- wire up ----------
el('refreshSources').addEventListener('click', loadSources);
el('folderBtn').addEventListener('click', () => window.recorder.openRecordingsFolder());
el('changeDirBtn').addEventListener('click', async () => {
  const dir = await window.recorder.chooseRecordingsDir();
  if (dir) {
    el('saveDir').textContent = dir;
    el('saveDir').title = dir;
    setStatus('Recordings will be saved to: ' + dir, 'ok');
  }
});
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

// Single progress listener, routed to whichever button is currently working.
window.recorder.onRemuxProgress((pct) => {
  if (progressCb) progressCb(pct);
});

(async function init() {
  loadLogo();
  await loadSaveDir();
  await refreshPermissions();
  await loadMics();
  await loadSources();
})();
