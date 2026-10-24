const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateRealUdid,validateInput,startScript,input}=require('../app/real-device.cjs');
const session='12345678-1234-1234-1234-123456789abc';

test('real device identifiers and input reject injection and invalid coordinates',()=>{
  assert.equal(validateRealUdid('00008140-0000000000000001'),'00008140-0000000000000001');
  assert.throws(()=>startScript('00008140-0000000000000001;whoami'));
  assert.match(startScript('00008140-0000000000000001'),/'appium:wdaBindingIP':'127.0.0.1'/);
  for(const bad of [{type:'tap',x:-1,y:0},{type:'tap',x:NaN,y:1},{type:'swipe',x1:0,y1:0,x2:Infinity,y2:1},{type:'shell',command:'whoami'},{type:'key',key:'x'.repeat(33)}])assert.throws(()=>validateInput(bad));
});

test('touch coordinates use the current iPhone point dimensions, including screen edges',async()=>{
  const original=global.fetch,requests=[];
  global.fetch=async(url,options)=>{
    requests.push({url,body:options.body?JSON.parse(options.body):null});
    return {ok:true,json:async()=>({value:url.endsWith('/window/rect')?{x:0,y:0,width:440,height:956}:{}})};
  };
  try{
    await input('http://127.0.0.1:1',session,{type:'tap',x:1,y:1});
    assert.deepEqual(requests[1].body,{script:'mobile: tap',args:[{x:439,y:955}]});
    await input('http://127.0.0.1:1',session,{type:'swipe',x1:0,y1:1,x2:1,y2:0,duration:99});
    assert.equal(requests[3].body.args[0].duration,2);
    assert.equal(requests[3].body.args[0].fromY,955);
  }finally{global.fetch=original;}
});

test('Home and keyboard use limited Appium commands',async()=>{
  const original=global.fetch,requests=[];
  global.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{ok:true,json:async()=>({value:{}})}};
  try{
    await input('http://127.0.0.1:1',session,{type:'home'});
    assert.equal(requests[0].body.script,'mobile: pressButton');
    await input('http://127.0.0.1:1',session,{type:'key',key:'Backspace'});
    assert.equal(requests[1].body.actions[0].actions[0].value,'\uE003');
    assert.ok(requests[1].url.endsWith('/actions'));
  }finally{global.fetch=original;}
});
