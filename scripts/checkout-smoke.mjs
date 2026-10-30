// Local-only checkout fixture: trusted mouse clicks, no real purchases or external services.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server.mjs';
import {CDPCollector,CDPConnection,listTargets} from '../src/collectors/cdp.mjs';
import {launchBrowser,closeOwnedBrowser} from '../src/browser/launcher.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eventqa-checkout-'));
const app=await createApp({port:0,runsDir:dir,initialCases:[]});
let orders=0;
const fixture=http.createServer(async(req,res)=>{
 if(req.url==='/order'&&req.method==='POST'){for await(const chunk of req){}orders++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));return;}
 if(req.url==='/insider/events'){for await(const chunk of req){}res.writeHead(204);res.end();return;}
 res.setHeader('content-type','text/html');
 res.end(`<!doctype html><button id="order" style="margin:40px;padding:20px">Đặt hàng thử</button><p id="result"></p><script>
 window.dataLayer=[];window.getterCalls=0;window.jsonCalls=0;window.ordersDone=0;
 document.getElementById('order').onclick=async function(){
 const button=this;window.dataLayer.push({event:'begin_checkout',product_id:'SKU-REAL',get total(){window.getterCalls++;return 110000;},toJSON(){window.jsonCalls++;button.disabled=true;return {event:'changed'};}});
 if(button.disabled)return;
 const response=await fetch('/order',{method:'POST',body:'local-test-only'});
 if(response.ok){window.ordersDone++;document.getElementById('result').textContent='LOCAL_ORDER_OK';await fetch('/insider/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event_name:'cart_page_view',event_params:{currency:'VND',product_id:'SKU-REAL',quantity:1,unit_price:110000,custom:{provider:'fixture-provider',total:110000}}})});}
 };</script>`);
});
let browser,cdp,collector;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const evaluate=async expression=>(await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
async function waitFor(expression){for(let i=0;i<120;i++){if(await evaluate(expression))return;await delay(50);}throw Error('Timeout: '+expression);}
try{
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${fixture.address().port}`;
 const ui=await app.listen();
 browser=await launchBrowser({port:9487,headless:true,profileDir:path.join(dir,'browser')});
 cdp=new CDPConnection((await listTargets(9487))[0].webSocketDebuggerUrl);await cdp.connect();
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');
 const outcomes=[];
 for(const captureQueues of [true,false]){
  app.manager.start({capture_queues:captureQueues});
  collector=new CDPCollector({port:9487,captureQueues,endpointPatterns:['/insider/events'],onEvent:e=>app.manager.emit(e)});
  await collector.start({});await cdp.send('Page.navigate',{url:origin});await waitFor('!!document.getElementById("order")');
  await evaluate('for(let i=0;i<100;i++)dataLayer.push({event:"tracking_burst",index:i})');
  for(let n=0;n<3;n++){
   const {x,y}=await evaluate('(()=>{const r=document.getElementById("order").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
   await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x,y});
   await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x,y});
   await waitFor(`window.ordersDone===${n+1}`);
  }
  assert.equal(await evaluate('window.jsonCalls'),0);assert.equal(await evaluate('window.getterCalls'),0);
  await collector.stop();collector=null;
  const events=app.manager.snapshot().events;
  const requests=events.filter(e=>e.event_name==='cart_page_view'&&e.network?.phase==='request');
  assert.equal(requests.length,3);
  assert.equal(events.some(e=>e.layer==='JS_QUEUE'),captureQueues);
  outcomes.push({captureQueues,ordersCompleted:3,requestEvents:requests.length,websiteSerializationCalls:0});
  if(!captureQueues)break;
  app.manager.finish();
 }
 await cdp.send('Page.navigate',{url:ui});await waitFor('document.querySelectorAll("[data-activity-id]").length>0');
 assert.equal(await evaluate('document.querySelectorAll(".activity-table tbody tr").length'),3,'each actual occurrence gets its own activity row');
 await evaluate('document.querySelector("[data-activity-id]").click()');await waitFor('document.getElementById("activity-dialog").open');
 const view=JSON.parse(await evaluate('document.querySelector("[data-activity-panel=json] pre").textContent'));
 assert.equal(view.event,'Cart Page View');assert.equal(view.default_parameters.product_id,'SKU-REAL');
 assert.equal(view.default_parameters.unit_price,110000);assert.equal(view.custom_parameters.total,110000);
 assert.equal(view.custom_parameters.provider,'fixture-provider');assert.equal(view.custom_parameters.app_version,undefined);
 await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir});await evaluate('document.getElementById("activity-download").click()');
 let file;for(let i=0;i<100&&!file;i++){file=(await fs.readdir(dir)).find(n=>n.endsWith('.json'));if(!file)await delay(50);}
 assert.ok(file);assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,file),'utf8')),view);
 await evaluate('document.querySelector("[data-activity-view=raw]").click()');
 const raw=JSON.parse(await evaluate('document.querySelector("[data-activity-panel=raw] pre").textContent'));
 assert.equal(raw.event_params.custom.provider,'fixture-provider');
 await evaluate('document.querySelector("[data-activity-view=json]").click()');
 await fs.mkdir('runs/checkout-smoke',{recursive:true});
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await fs.writeFile('runs/checkout-smoke/activity-json.png',Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await evaluate('document.getElementById("activity-close").click()');assert.equal(await evaluate('document.getElementById("activity-dialog").open'),false);
 assert.equal(orders,6);
 console.log(JSON.stringify({result:'PASS',localOnly:true,orders,tests:outcomes,jsonDownloadMatchesActualRequest:true,rawPayloadPreserved:true},null,2));
}finally{
 await collector?.stop();cdp?.close();if(browser)await closeOwnedBrowser(browser);
 await app.close();await new Promise(r=>fixture.close(r));await fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
