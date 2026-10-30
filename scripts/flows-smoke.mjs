// Local fixture only. Exercises isolated Golf/Flight activity, SDK envelopes and queue reads.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server.mjs';
import {importSpec} from '../src/spec/import.mjs';
import {CDPConnection,listTargets} from '../src/collectors/cdp.mjs';
import {launchBrowser,closeOwnedBrowser} from '../src/browser/launcher.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eventqa-flows-'));
const cases=process.argv[2]?(await importSpec(process.argv[2],{sheet:'R1511'})).cases:[];
const app=await createApp({port:0,runsDir:dir,initialCases:cases});
const fixture=http.createServer(async(req,res)=>{
 if(req.url==='/insider/events'){for await(const chunk of req){}res.writeHead(204);res.end();return;}
 const flow=req.url.includes('/flight/')?'flight':'golf';
 res.setHeader('content-type','text/html');res.end(`<!doctype html><button id="fire">Emit ${flow}</button><script>
 window.InsiderQueue=[];window.dataLayer=[];window.Insider={eventManager:{dispatch(){return 7;}}};window.sent=0;
 document.getElementById('fire').onclick=async()=>{
 const custom={product_id:'${flow}-sku',quantity:1,total:3150000,currency:'VND',taxonomy:['${flow}']};
 InsiderQueue.push({type:'custom_event',value:[{event_name:'${flow}_checkout',event_parameters:{custom}}]});
 dataLayer.push({event:'page_view',service:'${flow}'});
 const data={partner:'fixture',source:'web',events:[{event_name:'${flow}_checkout',event_params:{ta:'${flow}',...Object.fromEntries(Object.entries(custom).map(([k,v])=>['c_'+k,v]))}}]};
 Insider.eventManager.dispatch('nativeSdk:permission:prompted',{ignored:true});
 Insider.eventManager.dispatch('Ucd:event:beforeSend',data);
 await fetch('/insider/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});window.sent++;
 };</script>`);
});
let browser,site,ui;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const ev=async(c,expression)=>(await c.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
async function wait(c,expr){for(let i=0;i<160;i++){if(await ev(c,expr))return;await delay(50);}throw Error('Timeout: '+expr);}
try{
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${fixture.address().port}`;
 const base=await app.listen();browser=await launchBrowser({port:9488,headless:true,url:origin+'/vi/golf/checkout',profileDir:path.join(dir,'profile')});
 const target=(await listTargets(9488))[0];site=new CDPConnection(target.webSocketDebuggerUrl);await site.connect();
 const r=await fetch(base+'/api/start',{method:'POST',headers:{'content-type':'application/json','X-EventQA-Token':app.csrf},body:JSON.stringify({attach:true,targetId:target.id,debugPort:9488,url:origin+'/vi/golf/checkout',endpointPatterns:['/insider/events']})});assert.equal(r.status,200,await r.text());
 await wait(site,"!!window[Symbol.for('eventqa.collector.v1')]?.dispatchWrapper");
 for(let i=0;i<2;i++){await ev(site,"document.getElementById('fire').click()");await wait(site,`window.sent===${i+1}`);}
 await site.send('Page.navigate',{url:origin+'/vi/flight/checkout'});await wait(site,"!!window[Symbol.for('eventqa.collector.v1')]?.dispatchWrapper");
 await ev(site,"document.getElementById('fire').click()");await wait(site,'window.sent===1');
 const newTab=await(await fetch(`http://127.0.0.1:9488/json/new?${encodeURIComponent(base)}`,{method:'PUT'})).json();ui=new CDPConnection(newTab.webSocketDebuggerUrl);await ui.connect();
 await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await wait(ui,'document.querySelectorAll(".activity-table tbody tr").length===2');
 assert.equal(await ev(ui,'document.getElementById("activity-flow").value'),'golf');
 assert.equal(await ev(ui,'document.getElementById("activity-channel").value'),'network');
 assert.ok(!(await ev(ui,'document.querySelector(".activity-table").innerText')).includes('Flight Checkout'));
 await ev(ui,'document.getElementById("activity-flow").value="flight";document.getElementById("activity-flow").dispatchEvent(new Event("input"))');
 await wait(ui,'document.querySelectorAll(".activity-table tbody tr").length===1&&document.querySelector(".activity-table").innerText.includes("Flight Checkout")');
 await ev(ui,'document.getElementById("activity-channel").value="sdk";document.getElementById("activity-channel").dispatchEvent(new Event("input"))');
 await wait(ui,'document.querySelectorAll(".activity-table tbody tr").length===1');
 await ev(ui,'document.querySelector("[data-activity-id]").click()');await wait(ui,'document.getElementById("activity-dialog").open');
 const json=JSON.parse(await ev(ui,'document.querySelector("[data-activity-panel=json] pre").textContent'));
 assert.equal(json.event,'Flight Checkout');assert.equal(json.custom_parameters.product_id,'flight-sku');assert.equal(json.default_parameters.events,undefined);
 assert.ok((await ev(ui,'document.getElementById("activity-content").innerText')).includes('SDK trước khi gửi'));
 await ev(ui,'document.getElementById("activity-close").click()');
 const before=app.manager.snapshot().events.length;
 await ev(ui,'document.getElementById("queues-read").click()');await wait(ui,'document.getElementById("queues-dialog").open');
 const text=await ev(ui,'document.getElementById("queues-content").innerText');
 assert.ok(text.includes('InsiderQueue')&&text.includes('flight_checkout')&&text.includes('dataLayer'));
 assert.equal(app.manager.snapshot().events.length,before,'queue inspection must not replay any event');
 await ev(ui,'document.getElementById("queues-close").click()');
 await ev(ui,'document.getElementById("activity-channel").value="queue";document.getElementById("activity-channel").dispatchEvent(new Event("input"))');
 await wait(ui,'document.querySelectorAll(".activity-table tbody tr").length===1&&document.querySelector(".activity-table").innerText.includes("InsiderQueue.push")');
 await fs.mkdir('runs/flows-smoke',{recursive:true});await fs.writeFile('runs/flows-smoke/flight-only.png',Buffer.from((await ui.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 console.log(JSON.stringify({result:'PASS',golfRequests:2,flightRequests:1,realRepeatsRetained:true,separateSdkAndQueue:true,beforeSendUnwrapped:true,queueSnapshotReadOnly:true}));
}finally{ui?.close();site?.close();await app.close();if(browser)await closeOwnedBrowser(browser);await new Promise(r=>fixture.close(r));await fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
