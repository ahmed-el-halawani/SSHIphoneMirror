const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const {patchURL}=require('../app/patch-wda-ipv6.cjs');
const source='function resolve() { const port=18100;const parsedBaseUrl={protocol:"http:",hostname:"127.0.0.1"};this._url = new URL(`${parsedBaseUrl.protocol}//${this.wdaBindingIP || parsedBaseUrl.hostname}:${port}`);return this._url.href; }';
test('WDA IPv6 fix preserves loopback and brackets native tunnel addresses',()=>{
  const patched=patchURL(source),context={URL};vm.runInNewContext(patched,context);
  assert.equal(context.resolve.call({wdaBindingIP:'127.0.0.1'}),'http://127.0.0.1:18100/');
  assert.equal(context.resolve.call({wdaBindingIP:'fd12:3456::1'}),'http://[fd12:3456::1]:18100/');
  assert.equal(patchURL(patched),patched);assert.throws(()=>patchURL('changed upstream code'));
});
