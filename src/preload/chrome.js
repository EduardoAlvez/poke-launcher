import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('launcher', {
  addSlot: (name, url) => ipcRenderer.invoke('launcher:add-slot', { name, url }),
  removeSlot: (id) => ipcRenderer.invoke('launcher:remove-slot', { id }),
  setLayout: (cols) => ipcRenderer.invoke('launcher:set-layout', { cols }),
  focusSlot: (id) => ipcRenderer.send('launcher:focus-slot', { id }),
  onState: (cb) => ipcRenderer.on('launcher:state', (_e, slots) => cb(slots)),
});
