import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteBrowser} from '../browser.mjs';
import {createCloudApp,normalizeEvent} from '../server.mjs';
import {validateTarget,publicIP} from '../security.mjs';
import {compare,specFromRows} from '../../web/dist/core.mjs';
class FakeBrowser{
 constructor(opts){this.opts=opts;this.lastMeta={url:'https://example.com',title:'test'};}
 async start(){this.opts.emit('event',{event_name:'search_submit',source:'GA4',layer:'JS_QUEUE',payload:{event:'search_submit',search_term:'hotel'},captured_at:new Date().toISOString()});}
 async navigate(){} async frame(){return{data:'',width:1280,height:800};} async stop(){this.stopped=true;}async action(d){this.lastAction=d;}async tabs(){return[{id:'a',title:'test',url:'https://example.com'}];}
}
async function fixture(options={}){const app=createCloudApp({Browser:FakeBrowser,...options});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${app.server.address().port}`;let cookie='';return{app,origin,async request(route,data,{newOwner=false,originOverride}={}){const res=await fetch(origin+'/api/'+route,{method:data===undefined?'GET':'POST',headers:{...(cookie&&!newOwner?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json',Origin:originOverride??origin}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});const set=res.headers.get('set-cookie');if(set&&!newOwner)cookie=set.split(';')[0];return{status:res.status,data:await res.json()};},close:()=>app.close()};}
test('session lifecycle uses owned browser, retains evidence after stop',async()=>{const f=await fixture();try{await f.request('capabilities');const start=await f.request('start',{mode:'cdp',demo:true});assert.equal(start.status,200);assert.equal(start.data.active,true);assert.equal(start.data.events.length,1);const mark=await f.request('mark',{name:'search'});assert.equal(mark.data.eventIndex,1);const action=await f.request('action',{type:'click',x:10,y:20});assert.equal(action.status,200);const stop=await f.request('stop',{});assert.equal(stop.data.active,false);assert.equal(stop.data.events.length,1);}finally{await f.close();}});
test('a separate visitor cannot see or stop another visitor session',async()=>{const f=await fixture();try{await f.request('start',{mode:'cdp',demo:true});const other=await f.request('state',undefined,{newOwner:true});assert.equal(other.data.events.length,0);assert.equal(other.data.active,false);const own=await f.request('state');assert.equal(own.data.active,true);}finally{await f.close();}});
test('capacity and duplicate starts are rejected',async()=>{const f=await fixture({maxSessions:1});try{await f.request('start',{mode:'cdp',demo:true});assert.equal((await f.request('start',{mode:'cdp',demo:true})).status,409);assert.equal((await f.request('start',{mode:'cdp',demo:true},{newOwner:true})).status,429);}finally{await f.close();}});
test('cross origin writes are rejected',async()=>{const f=await fixture();try{assert.equal((await f.request('start',{mode:'cdp',demo:true},{originOverride:'https://foreign.example'})).status,403);}finally{await f.close();}});
test('optional access code gates session APIs',async()=>{const f=await fixture({accessCode:'test-only-code'});try{const caps=await f.request('capabilities');assert.equal(caps.data.needsLogin,true);assert.equal((await f.request('state')).status,401);assert.equal((await f.request('login',{code:'wrong'})).status,403);assert.equal((await f.request('login',{code:'test-only-code'})).status,200);assert.equal((await f.request('state')).status,200);}finally{await f.close();}});
test('HTTP response update does not add a duplicate event',async()=>{class B extends FakeBrowser{async start(){const e={source:'GA4',layer:'TRACKING_REQUEST',event_name:'test',payload:{event:'test'},page:{target_id:'t'},network:{request_id:'r',phase:'request'}};this.opts.emit('event',e);this.opts.emit('event',{...e,network:{...e.network,phase:'response',status:204}});}}const f=await fixture({Browser:B});try{const r=await f.request('start',{mode:'cdp',demo:true});assert.equal(r.data.events.length,1);assert.equal(r.data.events[0].status,204);}finally{await f.close();}});
test('public target validation rejects local, metadata, credentials and non-web URLs',async()=>{for(const u of ['http://127.0.0.1/','http://169.254.169.254/','http://192.168.0.1/','file:///etc/passwd','https://user:pass@example.com'])await assert.rejects(()=>validateTarget(u));assert.equal(publicIP('8.8.8.8'),true);assert.equal(publicIP('::1'),false);const lookup=async()=>[{address:'8.8.8.8'}];assert.equal(await validateTarget('https://example.com',{lookup}),'https://example.com/');await assert.rejects(()=>validateTarget('https://other.com',{lookup,allowedHosts:['example.com']}));});
test('demo exception only permits its own demo paths',async()=>{const demoOrigin='http://127.0.0.1:4173';assert.equal(await validateTarget(demoOrigin+'/demo/',{demoOrigin}),demoOrigin+'/demo/');await assert.rejects(()=>validateTarget(demoOrigin+'/api/state',{demoOrigin}));});
test('live JS queue comparison has no invented HTTP status',()=>{const e=normalizeEvent({source:'GA4',layer:'JS_QUEUE',event_name:'search_submit',payload:{event:'search_submit',search_term:'hotel'}},1);assert.equal(e.status,null);const s=specFromRows([['Nền tảng','Event Name','DataLayer Sample'],['GA4','search_submit',"{event:'search_submit',search_term:'example'}"]],'spec.csv');s.specs[0].rules[0].layer='JS_QUEUE';assert.equal(compare([e],s.specs,{live:true})[0].status,'PASS');assert.equal(compare([e],s.specs)[0].status,'REVIEW');});

test('live comparison isolates layers and waits for HTTP response',()=>{
 const s=specFromRows([['Nền tảng','Event Name','DataLayer Sample'],['GA4','search_submit',"{event:'search_submit',search_term:'example'}"]],'spec.csv');
 s.specs[0].rules[0].layer='JS_QUEUE';
 const queue=normalizeEvent({source:'GA4',layer:'JS_QUEUE',event_name:'search_submit',payload:{event:'search_submit',search_term:'hotel'}},1);
 const request=normalizeEvent({source:'GA4',layer:'TRACKING_REQUEST',event_name:'search_submit',payload:{event:'search_submit',search_term:'hotel'},network:{phase:'request',request_id:'r'}},2);
 const rows=compare([queue,request],s.specs,{live:true});assert.equal(rows.length,1);assert.equal(rows[0].status,'PASS');assert.equal(rows[0].matches,1);
 s.specs[0].rules[0].layer='TRACKING_REQUEST';assert.equal(compare([queue,request],s.specs,{live:true})[0].status,'REVIEW');
 request.status=204;assert.equal(compare([queue,request],s.specs,{live:true})[0].status,'PASS');
 request.status=500;assert.equal(compare([queue,request],s.specs,{live:true})[0].status,'FAIL');
});
test('static pages are available and traversal is rejected',async()=>{const f=await fixture();try{
 for(const route of ['/','/live.mjs','/live.css','/offline/core.mjs','/demo/']){const r=await fetch(f.origin+route);assert.equal(r.status,200,route);}
 assert.equal((await fetch(f.origin+'/offline/%2e%2e%2fpackage.json')).status,404);
 assert.equal((await fetch(f.origin+'/health')).status,200);
 }finally{await f.close();}});

test('initial screenshot failure does not terminate a working capture session',async()=>{
 class B extends FakeBrowser{async frame(){throw new Error('Page.captureScreenshot: Not attached to an active page');}}
 const f=await fixture({Browser:B});try{const r=await f.request('start',{mode:'cdp',demo:true});assert.equal(r.status,200);assert.equal(r.data.active,true);assert.equal(r.data.events.length,1);assert.match(r.data.logs.at(-1).message,/chưa lấy được hình/);assert.equal((await f.request('action',{type:'click',x:1,y:1})).status,200);}finally{await f.close();}
});
test('transient inactive page screenshot is retried after activation',async()=>{
 const b=new RemoteBrowser({emit:()=>{},validateURL:async x=>x});let captures=0,activations=0;
 b.control={async send(method){if(method==='Page.bringToFront')activations++;if(method==='Page.captureScreenshot'){if(++captures===1)throw new Error('Not attached to an active page');return{data:'image'};}return{};}};
 assert.equal((await b.frame(2)).data,'image');assert.equal(captures,2);assert.equal(activations,2);
});
test('closed Chromium reports failure without repeated screenshot commands',async()=>{
 const b=new RemoteBrowser({emit:()=>{},validateURL:async x=>x});b.child={exitCode:137};await assert.rejects(()=>b.frame(),/Chromium đã đóng/);
});
