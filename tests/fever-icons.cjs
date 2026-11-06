const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
function load(file, imports, fetchImpl) {
  const code = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  const module={exports:{}};
  const extra=file.endsWith('/service.ts')?'\nexports.__updateSources=updateSources;':'';
  new Function('require','module','exports','fetch',code+extra)(id=>imports[id]||{},module,module.exports,fetchImpl);
  return module.exports;
}
const DATA='data:image/png;base64,iVBORw0KGgo=';
const Source=class {constructor(url,name){this.url=url;this.name=name}};
const imports={'../source':{RSSSource:Source},'react-intl-universal':{get:x=>x}};
async function testImport() {
 const calls=[];
 const fever=load('src/scripts/models/services/fever.ts',imports,async url=>({ok:true,status:200,json:async()=>{calls.push(url);return url.includes('favicons')?{favicons:[{id:31,data:DATA}]}:{feeds:[{id:45,url:'http://127.0.0.1:18082/rss/test',title:'arXiv',favicon_id:31}],feeds_groups:[]}}}));
 const [sources]=await fever.feverServiceHooks.updateSources()(()=>{},()=>({service:{endpoint:'https://example.test/fever/',apiKey:'test'}}));
 assert.equal(sources[0].iconurl,DATA,'Fever adapter must import favicon data rather than fetch loopback source URL');
 assert.ok(calls.some(u=>u.includes('favicons')));
 console.log('PASS Fever favicon imported into new RSSSource');
}
async function testExisting() {
 const state={service:{},sources:{0:{sid:0,url:'http://127.0.0.1:18082/rss/test',serviceRef:'45',iconurl:'',unreadCount:12}},app:{settings:{}},groups:{}};let writes=0;
 const deps={'./source':{updateSource:s=>async()=>{writes++;state.sources[s.sid]=s}},'../utils':{ActionStatus:{Success:'success'}}};
 const svc=load('src/scripts/models/service.ts',deps);
 const dispatch=async action=>typeof action==='function'?action(dispatch,()=>state):action;
 const hook=()=>async()=>[[{...state.sources[0],iconurl:DATA}],undefined];
 await svc.__updateSources(hook)(dispatch,()=>state);
 assert.equal(state.sources[0].iconurl,DATA,'existing cached empty icon must be replaced on ordinary sync');
 assert.equal(state.sources[0].unreadCount,12);assert.equal(writes,1);
 console.log('PASS existing source icon updated without altering unread count');
}
function loadDiagnostics() {
  const code = ts.transpileModule(
    fs.readFileSync('src/scripts/models/net/diagnostics.ts','utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}
  ).outputText;
  const module={exports:{}};
  new Function('require','module','exports',code)(require,module,module.exports);
  return module.exports;
}
const diagnostics=loadDiagnostics();
const feverImports={...imports,'../net/diagnostics':diagnostics};
function loadFever(fetchImpl){return load('src/scripts/models/services/fever.ts',feverImports,fetchImpl)}
function faviconFetch(faviconPayload,feeds){
  return async url=>{
    if(url.includes('&favicons')){
      const payload=typeof faviconPayload==='function'?faviconPayload():faviconPayload;
      if(payload&&payload.__http) return {ok:false,status:payload.__http,json:async()=>({})};
      if(payload instanceof Error) throw payload;
      return {ok:true,status:200,json:async()=>payload};
    }
    return {ok:true,status:200,json:async()=>({feeds:feeds||[],feeds_groups:[]})};
  };
}
async function runFever(fever,service){
  const state={service:{endpoint:'https://example.test/fever/',apiKey:'test',...(service||{})}};
  const [sources]=await fever.feverServiceHooks.updateSources()(()=>{},()=>state);
  return sources;
}
function captureDiagnostics(){
  const events=[];
  const previous=global.window;
  global.window={network:{ensureRoute:async()=>({routes:{default:'DIRECT'}}),appendLog:event=>{events.push(event)}}};
  return {events,restore(){if(previous===undefined) delete global.window;else global.window=previous;}};
}
async function testIdNormalization(){
  const feeds=[
    {id:1,url:'http://example.test/1',title:'one',favicon_id:31},
    {id:2,url:'http://example.test/2',title:'two',favicon_id:'42'},
    {id:3,url:'http://example.test/3',title:'three',favicon_id:null},
    {id:4,url:'http://example.test/4',title:'four',favicon_id:''},
  ];
  const favicons=[
    {id:'31',data:DATA},
    {id:42,data:DATA+'A'},
    {id:null,data:DATA+'N'},
    {id:'',data:DATA+'E'},
    {id:'   ',data:DATA+'W'},
  ];
  const fever=loadFever(faviconFetch({favicons},feeds));
  const sources=await runFever(fever);
  assert.equal(sources[0].iconurl,DATA,'string favicon id "31" must match numeric favicon_id 31');
  assert.equal(sources[1].iconurl,DATA+'A','numeric favicon id 42 must match string favicon_id "42"');
  assert.equal(sources[2].iconurl,undefined,'null favicon_id must never match');
  assert.equal(sources[3].iconurl,undefined,'empty favicon_id must never match');
  console.log('PASS favicon ids normalize across number and string types');
}
async function testMalformedIconPayload(){
  const feeds=[{id:45,url:'http://example.test/1',title:'one',favicon_id:31}];
  const variants=[
    ['missing favicons key',{}],
    ['favicons is an object',{favicons:{id:31,data:DATA}}],
    ['favicons is a number',{favicons:31}],
    ['favicons is a string',{favicons:'not-an-array'}],
    ['favicons is null',{favicons:null}],
  ];
  for(const [name,payload] of variants){
    const fever=loadFever(faviconFetch(payload,feeds));
    const sources=await runFever(fever);
    assert.equal(sources.length,1,name+': feed sync must still return sources');
    assert.equal(sources[0].iconurl,undefined,name+': malformed payload must not fabricate an icon');
  }
  const malformed={favicons:[
    {id:31},
    {id:32,data:123},
    {id:33,data:'image/svg+xml;base64,PHN2Zz48c2NyaXB0PjE8L3NjcmlwdD48L3N2Zz4='},
    {id:34,data:'text/html;base64,PGgxPng8L2gxPg=='},
    {id:35,data:'image/png;base64,'},
    {id:99,data:DATA},
  ]};
  const fever=loadFever(faviconFetch(malformed,[{id:46,url:'http://example.test/2',title:'two',favicon_id:99}]));
  const sources=await runFever(fever);
  assert.equal(sources.length,1,'malformed entries must not abort feed sync');
  assert.equal(sources[0].iconurl,DATA,'valid sibling icon must still be applied');
  console.log('PASS malformed favicon payload never aborts feed sync');
}
async function testIconDataUriHygiene(){
  const feeds=[{id:1,url:'http://example.test/1',title:'one',favicon_id:31}];
  const accepted=[
    ['bare png','image/png;base64,AAA','data:image/png;base64,AAA'],
    ['prefixed png','data:image/png;base64,AAA','data:image/png;base64,AAA'],
    ['surrounding whitespace','  data:image/jpeg;base64,BBB  ','data:image/jpeg;base64,BBB'],
    ['bare gif with whitespace',' image/gif;base64,CCC ','data:image/gif;base64,CCC'],
    ['svg','image/svg+xml;base64,PHN2Zz48L3N2Zz4=','data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['prefixed svg','data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=','data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
  ];
  for(const [name,data,expected] of accepted){
    const fever=loadFever(faviconFetch({favicons:[{id:31,data}]},feeds));
    const sources=await runFever(fever);
    assert.equal(sources[0].iconurl,expected,name+': accepted data URI');
  }
  const rejected=[
    ['html','text/html;base64,PGgxPng8L2gxPg=='],
    ['empty payload','data:image/png;base64,   '],
    ['non data uri','http://example.test/icon.png'],
    ['blank','   '],
  ];
  for(const [name,data] of rejected){
    const fever=loadFever(faviconFetch({favicons:[{id:31,data}]},feeds));
    const sources=await runFever(fever);
    assert.equal(sources[0].iconurl,undefined,name+': rejected data URI');
  }
  console.log('PASS favicon data URIs are kept strict');
}
async function testFaviconDiagnosticsOk(){
  const cap=captureDiagnostics();
  try{
    const fever=loadFever(faviconFetch({favicons:[{id:31,data:DATA}]},[{id:1,url:'http://example.test/1',title:'one',favicon_id:31}]));
    await runFever(fever);
    const fav=cap.events.filter(e=>e.phase==='favicons');
    assert.equal(fav.length,1,'exactly one favicon summary event');
    assert.equal(fav[0].outcome,'ok');
    assert.equal(fav[0].count,1,'count is the number of usable icons applied');
    const request=cap.events.filter(e=>e.phase==='request');
    assert.equal(request.length,2,'request phase events must be preserved');
  }finally{cap.restore()}
  const zero=captureDiagnostics();
  try{
    const fever=loadFever(faviconFetch({favicons:[]},[{id:1,url:'http://example.test/1',title:'one',favicon_id:31}]));
    await runFever(fever);
    const fav=zero.events.filter(e=>e.phase==='favicons');
    assert.equal(fav.length,1,'zero usable icons still emits exactly one summary');
    assert.equal(fav[0].outcome,'ok');
    assert.equal(fav[0].count,0,'zero usable icons is ok with count 0, not an error');
  }finally{zero.restore()}
  console.log('PASS favicon phase emits one ok summary with an applied count');
}
async function testFaviconDiagnosticsError(){
  const cap=captureDiagnostics();
  const apiKey='APIKEY-SECRET-UNIQUE';
  try{
    const fever=loadFever(faviconFetch({__http:503},[{id:1,url:'http://example.test/1',title:'one',favicon_id:31}]));
    const sources=await runFever(fever,{apiKey});
    assert.equal(sources.length,1,'an icon failure must not abort feed sync');
    const fav=cap.events.filter(e=>e.phase==='favicons');
    assert.equal(fav.length,1,'exactly one favicon summary event on failure');
    assert.equal(fav[0].outcome,'error');
    assert.equal(fav[0].errorKind,'http');
    assert.equal(fav[0].status,503);
    assert.ok(cap.events.some(e=>e.phase==='request'&&e.outcome==='error'),'request error event must remain');
    const blob=JSON.stringify(cap.events);
    assert.equal(blob.includes(apiKey),false,'diagnostics must not contain the api key');
    assert.equal(blob.includes('iVBORw0KGgo'),false,'diagnostics must not contain favicon base64');
  }finally{cap.restore()}
  console.log('PASS favicon failure emits one redacted error summary without failing sync');
}
async function testSvgFaviconAccepted(){
  const svg='image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  const feeds=[{id:1,url:'http://example.test/1',title:'one',favicon_id:7}];
  const fever=loadFever(faviconFetch({favicons:[{id:7,data:svg}]},feeds));
  const sources=await runFever(fever);
  assert.equal(sources[0].iconurl,'data:'+svg,'svg favicon data URIs are accepted');
  console.log('PASS svg favicon data URIs are accepted');
}
async function testFaviconsNonArraySchemaError(){
  const cap=captureDiagnostics();
  try{
    const feeds=[{id:1,url:'http://example.test/1',title:'one',favicon_id:31}];
    const fever=loadFever(faviconFetch({favicons:{oops:true}},feeds));
    const sources=await runFever(fever);
    assert.equal(sources.length,1,'feed sync must still return sources on a schema error');
    assert.equal(sources[0].iconurl,undefined,'a non-array favicons payload must not fabricate an icon');
    const fav=cap.events.filter(e=>e.phase==='favicons');
    assert.equal(fav.length,1,'exactly one favicon summary event');
    assert.equal(fav[0].outcome,'error','non-array favicons payload must be an error, not ok');
    assert.equal(fav[0].errorKind,'json','non-array favicons payload is a schema (json) error');
  }finally{cap.restore()}
  console.log('PASS non-array favicons payload reports a schema error');
}
async function testAbsentFaviconsKey(){
  const cap=captureDiagnostics();
  try{
    const feeds=[{id:1,url:'http://example.test/1',title:'one',favicon_id:31}];
    const fever=loadFever(faviconFetch({},feeds));
    const sources=await runFever(fever);
    assert.equal(sources.length,1,'feed sync must still return sources');
    const fav=cap.events.filter(e=>e.phase==='favicons');
    assert.equal(fav.length,1,'exactly one favicon summary event');
    assert.equal(fav[0].outcome,'ok','an absent favicons key is not an error');
    assert.equal(fav[0].count,0,'an absent favicons key is an empty icon set');
  }finally{cap.restore()}
  console.log('PASS absent favicons key is an empty icon set');
}
function serviceCacheHarness(cachedIcon,incomingIcon){
  const state={service:{},sources:{0:{sid:0,url:'http://example.test/1',serviceRef:'45',iconurl:cachedIcon,unreadCount:12,hasRead:false}},app:{settings:{}},groups:{}};
  let writes=0;
  const deps={'./source':{updateSource:s=>async()=>{writes++;state.sources[s.sid]=s}},'../utils':{ActionStatus:{Success:'success'}}};
  const svc=load('src/scripts/models/service.ts',deps);
  const dispatch=async action=>typeof action==='function'?action(dispatch,()=>state):action;
  const hook=()=>async()=>[[{...state.sources[0],iconurl:incomingIcon}],undefined];
  const run=()=>svc.__updateSources(hook)(dispatch,()=>state);
  return {state,run,getWrites:()=>writes};
}
async function testServiceIconCacheUpdate(){
  const placeholder='data:image/png;base64,cGxhY2Vob2xkZXI=';
  let h=serviceCacheHarness(placeholder,DATA);
  await h.run();
  assert.equal(h.state.sources[0].iconurl,DATA,'incoming icon must overwrite a local placeholder');
  assert.equal(h.state.sources[0].unreadCount,12);
  assert.equal(h.getWrites(),1);
  for(const incoming of [undefined,'','   ']){
    h=serviceCacheHarness(placeholder,incoming);
    await h.run();
    assert.equal(h.state.sources[0].iconurl,placeholder,'absent/empty icon must preserve the cached icon');
    assert.equal(h.state.sources[0].unreadCount,12,'absent/empty icon must preserve the unread count');
    assert.equal(h.state.sources[0].hasRead,false,'absent/empty icon must preserve read state');
    assert.equal(h.getWrites(),0,'absent/empty icon must not write to the database');
  }
  console.log('PASS service icon cache updates only on a real changed icon');
}
async function testRetryAfterIconFailure(){
  const placeholder='data:image/png;base64,cGxhY2Vob2xkZXI=';
  let mode='fail';
  const fever=loadFever(async url=>{
    if(url.includes('&favicons')){
      if(mode==='fail') return {ok:false,status:503,json:async()=>({})};
      return {ok:true,status:200,json:async()=>({favicons:[{id:31,data:DATA}]})};
    }
    return {ok:true,status:200,json:async()=>({feeds:[{id:45,url:'http://example.test/1',title:'one',favicon_id:31}],feeds_groups:[]})};
  });
  const state={service:{endpoint:'https://example.test/fever/',apiKey:'test'},sources:{0:{sid:0,url:'http://example.test/1',serviceRef:'45',iconurl:placeholder,unreadCount:12,hasRead:false}},app:{settings:{}},groups:{}};
  let writes=0;
  const deps={'./source':{updateSource:s=>async()=>{writes++;state.sources[s.sid]=s}},'../utils':{ActionStatus:{Success:'success'}}};
  const svc=load('src/scripts/models/service.ts',deps);
  const dispatch=async action=>typeof action==='function'?action(dispatch,()=>state):action;
  const run=()=>svc.__updateSources(fever.feverServiceHooks.updateSources)(dispatch,()=>state);
  const cap=captureDiagnostics();
  try{
    await run();
    assert.equal(state.sources[0].iconurl,placeholder,'a failed icon phase must keep the existing placeholder');
    assert.equal(state.sources[0].unreadCount,12,'a failed icon phase must keep the unread count');
    assert.equal(writes,0);
    assert.ok(cap.events.some(e=>e.phase==='favicons'&&e.outcome==='error'),'first call must report the icon failure instead of latching silently');
    mode='ok';
    await run();
    assert.equal(state.sources[0].iconurl,DATA,'a later successful icon fetch must replace the placeholder');
    assert.equal(state.sources[0].unreadCount,12);
    assert.equal(writes,1);
  }finally{cap.restore()}
  console.log('PASS icons are retried after a failed favicon fetch');
}
async function testCsp(){
  const html=fs.readFileSync('src/index.html','utf8');
  assert.match(html,/img-src[^;]*\bdata:/,'CSP must allow Fever data-URI images without relaxing script policy');
  assert.ok(html.includes("script-src-elem 'self'"));
  console.log('PASS CSP permits image data URLs only');
}
const tests=[
  ['Fever favicon imported',testImport],
  ['existing icon update',testExisting],
  ['favicon id normalization',testIdNormalization],
  ['malformed favicon payload',testMalformedIconPayload],
  ['favicon data URI hygiene',testIconDataUriHygiene],
  ['favicon diagnostics ok',testFaviconDiagnosticsOk],
  ['favicon diagnostics error',testFaviconDiagnosticsError],
  ['svg favicon accepted',testSvgFaviconAccepted],
  ['non-array favicons schema error',testFaviconsNonArraySchemaError],
  ['absent favicons key',testAbsentFaviconsKey],
  ['service icon cache update',testServiceIconCacheUpdate],
  ['icon retry after failure',testRetryAfterIconFailure],
  ['CSP',testCsp],
];
(async()=>{for(const [name,fn] of tests){await fn()} })().catch(e=>{console.error(e);process.exit(1)});
