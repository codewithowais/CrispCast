const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorder', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  setCaptureConfig: (config) => ipcRenderer.invoke('set-capture-config', config),
  getPermissions: () => ipcRenderer.invoke('get-permissions'),
  askMicrophone: () => ipcRenderer.invoke('ask-microphone'),
  saveRecording: (fileName, buffer) =>
    ipcRenderer.invoke('save-recording', { fileName, buffer }),
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),
  getRecordingsDir: () => ipcRenderer.invoke('get-recordings-dir'),
  chooseRecordingsDir: () => ipcRenderer.invoke('choose-recordings-dir'),
  revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
  cleanAndRemux: (opts) => ipcRenderer.invoke('clean-and-remux', opts),
  compressVideo: (opts) => ipcRenderer.invoke('compress-video', opts),
  onRemuxProgress: (cb) => ipcRenderer.on('remux-progress', (_e, pct) => cb(pct)),
  notifyRecordingState: (state) => ipcRenderer.invoke('recording-state', state),
  onTrayStart: (cb) => ipcRenderer.on('tray-start', () => cb()),
  onTrayStop: (cb) => ipcRenderer.on('tray-stop', () => cb()),
  selftestDone: (report) => ipcRenderer.invoke('selftest-done', report)
});
