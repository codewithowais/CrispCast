const logEl = document.getElementById('log');
const log = (m) => {
  logEl.textContent += m + '\n';
};

function pickVideoMime() {
  const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find((x) => MediaRecorder.isTypeSupported(x)) || 'video/webm';
}

async function run() {
  const report = { ok: false };
  try {
    log('Listing sources…');
    const sources = await window.recorder.listSources();
    log('Sources found: ' + sources.length);
    const screen = sources.find((s) => s.kind === 'screen') || sources[0];
    if (!screen) throw new Error('No capture sources — screen recording permission likely not granted.');
    log('Using source: ' + screen.name);

    await window.recorder.setCaptureConfig({ sourceId: screen.id, systemAudio: true });

    log('Requesting screen + system audio…');
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { frameRate: { ideal: 30, max: 30 } }
    });
    const vTrack = screenStream.getVideoTracks()[0];
    const vs = vTrack.getSettings();
    report.video = { width: vs.width, height: vs.height, frameRate: vs.frameRate };
    report.systemAudioTracks = screenStream.getAudioTracks().length;
    log('Video: ' + vs.width + 'x' + vs.height + ' @' + Math.round(vs.frameRate || 0) + 'fps');
    log('System audio tracks: ' + report.systemAudioTracks);

    let micStream = null;
    try {
      log('Requesting microphone (raw)…');
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      report.micTracks = micStream.getAudioTracks().length;
      log('Mic tracks: ' + report.micTracks + ' (' + (micStream.getAudioTracks()[0]?.label || '?') + ')');
    } catch (e) {
      report.micTracks = 0;
      report.micError = e.message;
      log('Mic error: ' + e.message);
    }

    const mime = pickVideoMime();
    report.videoMime = mime;
    const videoStream = new MediaStream([...screenStream.getVideoTracks(), ...screenStream.getAudioTracks()]);
    const vChunks = [];
    const vRec = new MediaRecorder(videoStream, { mimeType: mime, videoBitsPerSecond: 24_000_000, audioBitsPerSecond: 192_000 });
    vRec.ondataavailable = (e) => e.data.size && vChunks.push(e.data);

    let mRec = null;
    const mChunks = [];
    if (micStream) {
      mRec = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256_000 });
      mRec.ondataavailable = (e) => e.data.size && mChunks.push(e.data);
    }

    // Play a test tone through the system output so loopback has real audio to
    // capture — this is how we verify the captured system-audio track isn't silent.
    let audioCtx = null, osc = null;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      g.gain.value = 0.2;
      osc.type = 'sine';
      osc.frequency.value = 440;
      osc.connect(g).connect(audioCtx.destination);
      osc.start();
      report.tonePlayed = true;
      log('Playing 440Hz test tone through system output…');
    } catch (e) {
      report.toneError = e.message;
      log('Tone error: ' + e.message);
    }

    log('Recording 6s…');
    vRec.start(1000);
    if (mRec) mRec.start(1000);
    await new Promise((r) => setTimeout(r, 6000));

    const stops = [new Promise((r) => (vRec.onstop = r))];
    vRec.stop();
    if (mRec) { stops.push(new Promise((r) => (mRec.onstop = r))); mRec.stop(); }
    await Promise.all(stops);

    if (osc) { try { osc.stop(); } catch (_) {} }
    if (audioCtx) { try { await audioCtx.close(); } catch (_) {} }

    const vBlob = new Blob(vChunks, { type: 'video/webm' });
    report.videoBytes = vBlob.size;
    report.videoFile = await window.recorder.saveRecording('selftest-video.webm', await vBlob.arrayBuffer());
    log('Saved video: ' + report.videoBytes + ' bytes');

    if (mChunks.length) {
      const mBlob = new Blob(mChunks, { type: 'audio/webm' });
      report.voiceBytes = mBlob.size;
      report.voiceFile = await window.recorder.saveRecording('selftest-voice.webm', await mBlob.arrayBuffer());
      log('Saved voice: ' + report.voiceBytes + ' bytes');
    }

    screenStream.getTracks().forEach((t) => t.stop());
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    report.ok = true;
  } catch (err) {
    report.error = err.message;
    report.stack = err.stack;
    log('ERROR: ' + err.message);
  }
  await window.recorder.selftestDone(report);
}

run();
