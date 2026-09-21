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
}

function selectSource(id, node) {
  selectedSourceId = id;
  document.querySelectorAll('.source').forEach((n) => n.classList.remove('selected'));
  if (node) node.classList.add('selected');
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
  if (!selectedSourceId) {
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

  renderResults(saved);
  cleanupStreams();
  startBtn.disabled = false;
  setStatus('Done. Saved ' + saved.length + ' file(s).', 'ok');
}

function renderResults(saved) {
  resultsEl.innerHTML = '';
  saved.forEach((f) => {
    const mb = (f.size / (1024 * 1024)).toFixed(1);
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="meta">
        <div class="name">${f.name} · ${mb} MB</div>
        <div class="path">${f.path}</div>
      </div>
      <button class="ghost">Reveal</button>`;
    card.querySelector('button').addEventListener('click', () =>
      window.recorder.revealFile(f.path)
    );
    resultsEl.appendChild(card);
  });

  // Offer the clean-voice + merge step when we have both a video and a mic track.
  if (lastVideoPath && lastVoicePath) {
    const action = document.createElement('div');
    action.className = 'result-card';
    action.style.borderColor = 'var(--accent-2)';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = 'Clean the voice & merge into one MP4';
    const sub = document.createElement('div');
    sub.className = 'path';
    sub.textContent =
      'Denoises the mic, mixes it' +
      (recordedSystemAudio ? ' with system audio' : '') +
      ', and exports H.264 MP4.';
    meta.append(name, sub);

    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Clean voice → MP4';

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Processing… 0%';
      window.recorder.onRemuxProgress((pct) => {
        btn.textContent = `Processing… ${pct}%`;
      });
      try {
        const res = await window.recorder.cleanAndRemux({
          videoPath: lastVideoPath,
          voicePath: lastVoicePath,
          hasSystemAudio: recordedSystemAudio,
          durationSec: lastDurationSec
        });
        const mb = (res.size / (1024 * 1024)).toFixed(1);
        const done = document.createElement('div');
        done.className = 'result-card';
        done.style.borderColor = 'var(--ok)';
        const m2 = document.createElement('div');
        m2.className = 'meta';
        const n2 = document.createElement('div');
        n2.className = 'name';
        n2.textContent = `✓ Clean MP4 · ${mb} MB`;
        const p2 = document.createElement('div');
        p2.className = 'path';
        p2.textContent = res.path;
        m2.append(n2, p2);
        const b2 = document.createElement('button');
        b2.className = 'ghost';
        b2.textContent = 'Reveal';
        b2.addEventListener('click', () => window.recorder.revealFile(res.path));
        done.append(m2, b2);
        resultsEl.appendChild(done);
        action.remove();
        setStatus('Clean MP4 ready.', 'ok');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Clean voice → MP4';
        setStatus('Cleaning failed: ' + err.message, 'err');
      }
    });

    action.append(meta, btn);
    resultsEl.appendChild(action);
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

(async function init() {
  loadLogo();
  await loadSaveDir();
  await refreshPermissions();
  await loadMics();
  await loadSources();
})();
