const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  addSlot: (name, url) => ipcRenderer.invoke('launcher:add-slot', { name, url }),
  removeSlot: (id) => ipcRenderer.invoke('launcher:remove-slot', { id }),
  renameSlot: (id, name) => ipcRenderer.invoke('launcher:rename-slot', { id, name }),
  setLayout: (cols) => ipcRenderer.invoke('launcher:set-layout', { cols }),
  focusSlot: (id) => ipcRenderer.send('launcher:focus-slot', { id }),
  closePopups: () => ipcRenderer.invoke('launcher:close-popups'),
  runDiagnostics: () => ipcRenderer.invoke('diagnostics:collect'),
  setAutomation: (id, config) => ipcRenderer.invoke('automation:set', { id, config }),
  stopAllAutomation: () => ipcRenderer.invoke('automation:stop-all'),
  riskText: () => ipcRenderer.invoke('automation:risk-text'),
  onState: (cb) => ipcRenderer.on('launcher:state', (_e, slots) => cb(slots)),
});
