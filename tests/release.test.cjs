const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {planRelease,applyVersion}=require('../scripts/github-release.cjs');
const sha='a'.repeat(40);
test('first release increments the source patch; later tags compare numerically',()=>{
 assert.equal(planRelease('0.3.1',[],[],sha).version,'0.3.2');
 assert.equal(planRelease('0.3.1',['v0.3.9','v0.3.10','v0.4.0-beta'],[],sha).version,'0.3.11');
});
test('drafts reserve versions and retries reuse the same draft or skip a published commit',()=>{
 const draft={tag_name:'v0.3.3',draft:true,target_commitish:sha};
 assert.equal(planRelease('0.3.1',[],[draft],'b'.repeat(40)).version,'0.3.4');
 assert.deepEqual(planRelease('0.3.1',[],[draft],sha),{version:'0.3.3',tag:'v0.3.3',skip:false});
 assert.equal(planRelease('0.3.1',[],[{...draft,draft:false}],sha).skip,true);
 assert.equal(planRelease('0.3.1',[],[],sha,['v0.3.2']).version,'0.3.2');
});
test('build version updates both lockfile roots without changing dependencies',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'iphone-release-'));
 try{
 fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({version:'0.3.1',dependencies:{x:'1.0.0'}}));
 fs.writeFileSync(path.join(folder,'package-lock.json'),JSON.stringify({version:'0.3.1',packages:{'':{version:'0.3.1'},'node_modules/x':{version:'1.0.0'}}}));
 applyVersion(folder,'0.3.2');const lock=JSON.parse(fs.readFileSync(path.join(folder,'package-lock.json')));
 assert.equal(lock.version,'0.3.2');assert.equal(lock.packages[''].version,'0.3.2');assert.equal(lock.packages['node_modules/x'].version,'1.0.0');
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
