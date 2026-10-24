const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

function versionParts(value){
  const match=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value||'');
  return match?match.slice(1).map(Number):null;
}
function compare(a,b){for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;}
function planRelease(base,tags,releases,sha,pointing=[]){
  const baseline=versionParts(base);if(!baseline)throw Error('package.json must use a stable X.Y.Z version.');
  const same=releases.filter(r=>!r.prerelease&&versionParts(r.tag_name)&&(r.target_commitish===sha||pointing.includes(r.tag_name)))
    .sort((a,b)=>compare(versionParts(b.tag_name),versionParts(a.tag_name)))[0];
  if(same)return{version:same.tag_name.replace(/^v/,''),tag:same.tag_name,skip:!same.draft};
  const reserved=pointing.filter(tag=>versionParts(tag)).sort((a,b)=>compare(versionParts(b),versionParts(a)))[0];
  if(reserved)return{version:reserved.replace(/^v/,''),tag:reserved,skip:false};
  let next=baseline;
  for(const tag of [...tags,...releases.map(r=>r.tag_name)]){const parts=versionParts(tag);if(parts&&compare(parts,next)>0)next=parts;}
  next=[...next];next[2]++;
  if(next.some(n=>!Number.isSafeInteger(n)||n>65535))throw Error('Release version exceeds the Windows version limit. Bump the minor version in package.json.');
  const version=next.join('.');return{version,tag:'v'+version,skip:false};
}
function applyVersion(directory,version){
  if(!versionParts(version))throw Error('Invalid release version.');
  for(const name of ['package.json','package-lock.json']){
    const file=path.join(directory,name),data=JSON.parse(fs.readFileSync(file,'utf8'));
    data.version=version;if(data.packages?.[''])data.packages[''].version=version;
    fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
  }
}
async function main(){
  const repo=process.env.GITHUB_REPOSITORY,sha=process.env.GITHUB_SHA,token=process.env.GH_TOKEN;
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo||'')||!/^[a-f0-9]{40}$/i.test(sha||'')||!token)throw Error('GitHub Actions repository, commit and token are required.');
  const root=`https://api.github.com/repos/${repo}`;
  async function api(url,options={}){
    const response=await fetch(url.startsWith('https:')?url:root+url,{...options,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28',...options.headers},signal:AbortSignal.timeout(120000)});
    const text=await response.text();const data=text?JSON.parse(text):null;
    if(!response.ok)throw Error(`GitHub API ${response.status}: ${data?.message||'Request failed'}`);
    return data;
  }
  async function releases(){let all=[];for(let page=1;;page++){const batch=await api(`/releases?per_page=100&page=${page}`);all.push(...batch);if(batch.length<100)return all;}}
  const existing=await releases();
  if(process.argv[2]==='prepare'){
    const tags=execFileSync('git',['tag','--list'],{encoding:'utf8'}).trim().split(/\r?\n/);
    const pointing=execFileSync('git',['tag','--points-at',sha],{encoding:'utf8'}).trim().split(/\r?\n/);
    const plan=planRelease(JSON.parse(fs.readFileSync('package.json','utf8')).version,tags,existing,sha,pointing);
    if(!plan.skip)applyVersion('.',plan.version);
    if(!process.env.GITHUB_OUTPUT)throw Error('GITHUB_OUTPUT is missing.');
    fs.appendFileSync(process.env.GITHUB_OUTPUT,`version=${plan.version}\ntag=${plan.tag}\nskip=${plan.skip}\n`);
    console.log(plan.skip?`${plan.tag} already published for this commit.`:`Building ${plan.tag} from ${sha.slice(0,7)}.`);
    return;
  }
  if(process.argv[2]!=='publish')throw Error('Use prepare or publish.');
  const version=process.env.RELEASE_VERSION,tag=process.env.RELEASE_TAG;
  if(!versionParts(version)||tag!=='v'+version)throw Error('Invalid release version/tag.');
  const file=path.join('release',`iPhone Mirror Setup ${version}.exe`);
  if(!fs.statSync(file).isFile()||fs.statSync(file).size<1000000)throw Error('The Windows installer is missing or incomplete.');
  let release=existing.find(r=>r.tag_name===tag);
  if(release&&!release.draft)throw Error('This release is already public; refusing to overwrite it.');
  if(!release)release=await api('/releases',{method:'POST',body:JSON.stringify({tag_name:tag,target_commitish:sha,name:`iPhone Mirror ${version}`,draft:true,generate_release_notes:true})});
  if(release.target_commitish!==sha)throw Error('The draft release belongs to a different commit.');
  // GitHub normalizes spaces in uploads; use a stable name for draft retries.
  const name=`iPhone-Mirror-Setup-${version}.exe`;
  for(const asset of release.assets||[])if(asset.name===name)await api(`/releases/assets/${asset.id}`,{method:'DELETE'});
  const upload=new URL(release.upload_url.replace(/\{.*$/,''));
  if(upload.protocol!=='https:'||upload.hostname!=='uploads.github.com')throw Error('Unexpected release upload destination.');
  upload.searchParams.set('name',name);
  await api(upload.href,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:fs.readFileSync(file)});
  await api(`/releases/${release.id}`,{method:'PATCH',body:JSON.stringify({draft:false,make_latest:'true'})});
  console.log(`Published ${release.html_url} with ${name}`);
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={planRelease,applyVersion};
