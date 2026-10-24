const fs=require('node:fs');
const path=require('node:path');
const marker='// iPhone Mirror: bracket IPv6 CoreDevice tunnel addresses.';
function patchURL(source) {
  if(source.includes(marker))return source;
  const old='this._url = new URL(`${parsedBaseUrl.protocol}//${this.wdaBindingIP || parsedBaseUrl.hostname}:${port}`);';
  if(!source.includes(old))throw Error('The installed WebDriverAgent URL code changed; cannot apply its IPv6 fix safely.');
  return source.replace(old,'const host = this.wdaBindingIP || parsedBaseUrl.hostname;\n'+
    'this._url = new URL(`${parsedBaseUrl.protocol}//${host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host}:${port}`);')+'\n'+marker+'\n';
}
if(require.main===module){
  const file=path.join(process.env.APPIUM_HOME,'node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/build/lib/webdriveragent.js');
  const source=fs.readFileSync(file,'utf8'),patched=patchURL(source);
  if(patched!==source)fs.writeFileSync(file,patched);
  const utils=path.join(process.env.APPIUM_HOME,'node_modules/appium-xcuitest-driver/build/lib/commands/wda/utils.js');
  const text=fs.readFileSync(utils,'utf8');
  const old='return `http://${remoteIp}:${remotePort}`;';
  if(!text.includes(marker)){
    if(!text.includes(old))throw Error('The installed XCUITest URL code changed; cannot apply its IPv6 fix safely.');
    fs.writeFileSync(utils,text.replace(old,'return `http://${remoteIp.includes(":") && !remoteIp.startsWith("[") ? "[" + remoteIp + "]" : remoteIp}:${remotePort}`;')+'\n'+marker+'\n');
  }
}
module.exports={patchURL};
