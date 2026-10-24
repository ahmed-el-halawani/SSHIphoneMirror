const image=document.getElementById('screen');
const message=document.getElementById('message');
let chain=Promise.resolve(),pending=0,start;
function send(input){
  if(pending>=30){message.textContent='Input queue full. Wait for the iPhone to respond.';return;}
  pending++;
  chain=chain.then(()=>window.realPhone.send(input)).catch(error=>{message.textContent=error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/,'');}).finally(()=>pending--);
}
function coords(event){const r=image.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))};}
image.onpointerdown=event=>{if(event.button!==0)return;start={...coords(event),px:event.clientX,py:event.clientY,time:Date.now()};image.setPointerCapture(event.pointerId);};
image.onpointerup=event=>{
  if(!start||event.button!==0)return;
  const end=coords(event);
  if(Math.hypot(event.clientX-start.px,event.clientY-start.py)<6)send({type:'tap',x:start.x,y:start.y});
  else send({type:'swipe',x1:start.x,y1:start.y,x2:end.x,y2:end.y,duration:(Date.now()-start.time)/1000});
  start=null;
};
image.onpointercancel=()=>{start=null;};
window.onkeydown=event=>{
  if(event.ctrlKey||event.metaKey||event.altKey||['Shift','Control','Alt','Meta','Dead'].includes(event.key))return;
  event.preventDefault();send({type:'key',key:event.key});
};
image.onerror=()=>{message.textContent='The iPhone stream disconnected. Use Reconnect to retry.';console.info('MIRROR_STREAM_DISCONNECTED');};
let shown=false;
const watch=setInterval(()=>{
  if(!image.naturalWidth)return;
  document.getElementById('phone').style.aspectRatio=`${image.naturalWidth}/${image.naturalHeight}`;
  document.getElementById('phone').style.setProperty('--ratio',image.naturalWidth/image.naturalHeight);
  if(!shown){message.textContent='';console.info('MIRROR_STREAM_READY');shown=true;}
},250);
