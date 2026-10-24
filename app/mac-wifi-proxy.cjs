// Runs on the Mac: only CoreDevice's Mac-private encrypted IPv6 route is accepted.
const http=require('node:http');
const net=require('node:net');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const udid=process.argv[2],route=process.argv[3];
if(!/^(?:[0-9a-f]{8}-[0-9a-f]{16}|[0-9a-f]{40})$/i.test(udid||''))throw Error('Invalid iPhone identifier.');
let address=JSON.parse(fs.readFileSync(route,'utf8')).address,refreshing=false;
function valid(ip){return net.isIPv6(ip)&&ip.toLowerCase().startsWith('fd');}
if(!valid(address))throw Error('No private CoreDevice tunnel address.');
function refresh(){
  if(refreshing)return;refreshing=true;
  const file=path.join(os.tmpdir(),`iphone-mirror-wifi-${process.pid}.json`);
  execFile('xcrun',['devicectl','device','info','details','--device',udid,'--json-output',file],{timeout:15000},error=>{
    try{if(!error){const data=JSON.parse(fs.readFileSync(file,'utf8'));const ip=data.result?.connectionProperties?.tunnelIPAddress;if(valid(ip))address=ip;}}
    catch {}finally{fs.rmSync(file,{force:true});refreshing=false;}
  });
}
const timer=setInterval(refresh,5000);refresh();
const server=http.createServer((request,response)=>{
  if(request.method!=='GET'){response.writeHead(405);response.end();return;}
  const upstream=http.get({hostname:address,port:19102,path:'/',timeout:15000},remote=>{
    response.writeHead(remote.statusCode||502,{'Content-Type':remote.headers['content-type']||'multipart/x-mixed-replace','Cache-Control':'no-store'});
    remote.pipe(response);
  });
  upstream.on('timeout',()=>upstream.destroy(Error('iPhone stream timeout')));
  upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});
  response.on('close',()=>upstream.destroy());
});
server.listen(19100,'127.0.0.1');
server.on('error',error=>{console.error(error.message);process.exit(1)});
function stop(){clearInterval(timer);server.closeAllConnections();server.close(()=>process.exit(0));}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
