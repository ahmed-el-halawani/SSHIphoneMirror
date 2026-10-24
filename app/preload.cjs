const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mirror', {
  profiles: () => ipcRenderer.invoke('mirror:profiles'),
  importHosts: () => ipcRenderer.invoke('mirror:import'),
  chooseKey: () => ipcRenderer.invoke('mirror:key'),
  setup: profile => ipcRenderer.invoke('mirror:setup', profile),
  start: udid => ipcRenderer.invoke('mirror:start', udid),
  devices: () => ipcRenderer.invoke('mirror:devices'),
  shutdown: udid => ipcRenderer.invoke('mirror:shutdown', udid),
  disconnect: () => ipcRenderer.invoke('mirror:disconnect'),
  stop: () => ipcRenderer.invoke('mirror:stop'),
  panel: visible => ipcRenderer.invoke('mirror:panel', visible),
  windowAction: command => ipcRenderer.invoke('mirror:window', command),
  zoom: direction => ipcRenderer.invoke('mirror:zoom', direction),
  control: command => ipcRenderer.invoke('mirror:control', command),
  screenshot: () => ipcRenderer.invoke('mirror:screenshot'),
  menu: (name, canShutdown) => ipcRenderer.invoke('mirror:menu', name, canShutdown),
  onPanel: callback => ipcRenderer.on('mirror:panel', (_event, name) => callback(name)),
  onAction: callback => ipcRenderer.on('mirror:action', (_event, action) => callback(action)),
  onProgress: callback => ipcRenderer.on('mirror:progress', (_event, message) => callback(message))
});
