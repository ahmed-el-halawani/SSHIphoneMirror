const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('realPhone',{
  send: input=>ipcRenderer.invoke('mirror:real-input',input)
});
