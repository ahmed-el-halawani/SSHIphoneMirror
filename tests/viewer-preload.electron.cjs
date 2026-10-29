// Opt-in desktop smoke: click the test surface three times; no device is connected.
const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mirror-preload-smoke-'));
app.setPath('userData',directory);
let window,stage=0,loads=0,blocked=0,inputs=0;
const output=path.resolve('.research/viewer-preload-smoke.json');
const preload=path.resolve(process.argv[2]||'app/viewer-preload.cjs');
function mode(readOnly){window.webContents.send('mirror:viewer-mode',{readOnly,token:'smoke'});}
ipcMain.on('mirror:viewer-mode-applied',()=>window.webContents.executeJavaScript(`document.getElementById('mode').textContent=${JSON.stringify(stage===1?'Manual: click the surface':'View-only: click the surface')}`).catch(()=>{}));
ipcMain.on('mirror:read-only-attempt',async()=>{
  blocked++;
  if(stage===0){stage=1;await dialog.showMessageBox(window,{message:'You are viewing in read-only mode.',detail:'In iPhone Mirror use View > Watch agent (read-only) to switch. This is a device-free input-gate test.',buttons:['Continue test']});mode(false);}
  else if(stage===2){fs.writeFileSync(output,JSON.stringify({passed:loads===1&&inputs===1&&blocked===2,loads,inputs,blocked}));app.quit();}
});
ipcMain.handle('mirror:real-input',()=>{inputs++;if(stage===1){stage=2;mode(true);}return {};});
app.whenReady().then(async()=>{
  window=new BrowserWindow({title:'Viewer input smoke — no device connected',width:440,height:380,webPreferences:{preload,contextIsolation:true,sandbox:true}});
  window.webContents.on('did-finish-load',()=>loads++);
  await window.loadURL('data:text/html,'+encodeURIComponent('<!doctype html><html><body style="background:#191919;color:#eee;font:16px Segoe UI;padding:25px"><h2>Viewer input smoke</h2><p>No device connected</p><p id="mode">View-only: click the surface</p><div id="surface" style="padding:45px;background:#333">Click this test surface</div><script>document.getElementById("surface").onpointerdown=()=>window.realPhone.send({type:"tap"}).catch(()=>{});</script></body></html>'));
  mode(true);
});
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>fs.rmSync(directory,{recursive:true,force:true}));
