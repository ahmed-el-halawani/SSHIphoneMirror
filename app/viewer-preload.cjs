const {contextBridge,ipcRenderer}=require('electron');
let readOnly=true;
contextBridge.exposeInMainWorld('realPhone',{
  send:input=>readOnly?Promise.reject(Error('Watch agent is enabled. Switch to Manual in the View menu.')):ipcRenderer.invoke('mirror:real-input',input)
});
ipcRenderer.on('mirror:viewer-mode',(_event,{readOnly:next,token})=>{
  document.querySelectorAll('video,img').forEach(surface=>surface.dispatchEvent(new Event('pointercancel',{bubbles:true})));
  readOnly=next;
  ipcRenderer.send('mirror:viewer-mode-applied',token);
});
for(const type of ['pointerdown','pointerup','pointermove','click','dblclick','keydown','touchstart','touchend','wheel','contextmenu']) {
  window.addEventListener(type,event=>{
    if(!readOnly)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(type==='pointerdown'||type==='keydown'&&!event.repeat)ipcRenderer.send('mirror:read-only-attempt');
  },{capture:true,passive:false});
}
