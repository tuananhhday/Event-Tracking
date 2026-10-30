import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {CDPConnection,listTargets,CDPCollector} from '../src/collectors/cdp.mjs';
import {ProxyCollector,proxyCaSpki} from '../src/collectors/proxy.mjs';
import {VENDOR_ENDPOINTS} from '../src/core/decoder.mjs';
import {redact,redactUrl} from '../src/core/privacy.mjs';
export const findChrome=()=>[process.env.CHROME_PATH,'/usr/bin/chromium','/usr/bin/google-chrome','/usr/bin/chromium-browser'].find(x=>x&&existsSync(x));
export const findProxy=()=>[process.env.MITMDUMP_PATH,'/opt/proxy/bin/mitmdump','/usr/bin/mitmdump'].find(x=>x&&existsSync(x));
async function freePort(){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export class RemoteBrowser{
 constructor({emit,validateURL,mode='cdp',vendors=['ga4','insider'],patterns=[]}){Object.assign(this,{emit,validateURL,mode,vendors});this.patterns=[...vendors.flatMap(x=>VENDOR_ENDPOINTS[x]?.patterns??[]),...patterns];this.closed=false;this.lastFrame=0;this.lastMeta={url:'about:blank',title:''};}
 async start(){
  const executable=findChrome();if(!executable)throw new Error('Máy chủ chưa có Chromium. Hãy deploy bằng Dockerfile đi kèm để mở trình duyệt test.');
  this.dir=await mkdtemp(path.join(os.tmpdir(),'eventqa-cloud-'));this.port=await freePort();
  try{
   let proxyArgs=[];
   if(this.mode==='proxy'){
    const command=findProxy();if(!command)throw new Error('Máy chủ chưa có mitmproxy. Chọn CDP hoặc cài bản Docker đầy đủ.');
    const port=await freePort();const confDir=path.join(this.dir,'proxy-ca');
    this.collector=new ProxyCollector({port,command,runDir:this.dir,confDir,endpointPatterns:this.patterns,onEvent:e=>this.emit('event',redact(e)),onStatus:x=>this.emit('log',{message:typeof x==='string'?x:x.message})});
    await this.collector.start();const ca=await proxyCaSpki(confDir);
    proxyArgs=[`--proxy-server=http://127.0.0.1:${port}`,'--proxy-bypass-list=<-loopback>',`--ignore-certificate-errors-spki-list=${ca.spki}`];
   }
   const args=['--headless=new','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',`--remote-debugging-port=${this.port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${path.join(this.dir,'profile')}`,'--window-size=1280,800',...proxyArgs];
   if(process.env.CHROME_NO_SANDBOX==='1')args.push('--no-sandbox');args.push('about:blank');
   this.child=spawn(executable,args,{stdio:'ignore'});let spawnError;this.child.once('error',e=>spawnError=e);
   let target;for(let n=0;n<60&&!this.closed;n++){if(spawnError)throw spawnError;if(this.child.exitCode!==null)throw new Error('Chromium đã thoát. Kiểm tra cấu hình Docker và RAM máy chủ.');try{[target]=await listTargets(this.port);}catch{}if(target)break;await delay(150);}
   if(!target)throw new Error('Chromium không mở được cổng điều khiển.');
   this.control=new CDPConnection(target.webSocketDebuggerUrl);await this.control.connect();
   this.control.on('event',m=>void this.protocolEvent(m).catch(e=>this.emit('log',{message:e.message})));
   await this.control.send('Page.enable');await this.control.send('Runtime.enable');
   await this.control.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
   await this.control.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
   await this.control.send('Page.setInterceptFileChooserDialog',{enabled:true});
   if(this.mode!=='proxy'){this.collector=new CDPCollector({port:this.port,endpointPatterns:this.patterns,onEvent:e=>this.emit('event',redact(e)),onStatus:message=>this.emit('log',{message})});await this.collector.start();}
   await this.control.send('Page.bringToFront');
   await this.control.send('Page.startScreencast',{format:'jpeg',quality:65,maxWidth:1280,maxHeight:800,everyNthFrame:1});
   this.child.once('exit',()=>{if(!this.closed)this.emit('browserClosed',{});});
   this.metaTimer=setInterval(()=>void this.updateMeta(),1500);
   this.frameTimer=setInterval(()=>{if(this.closed||this.frameBusy||Date.now()-this.lastFrame<2000)return;this.frameBusy=true;void this.frame(2).then(frame=>{this.lastFrame=Date.now();this.emit('frame',frame);}).catch(e=>{if(!this.frameWarning){this.frameWarning=true;this.emit('log',{message:'Chưa lấy được hình trình duyệt: '+e.message});}}).finally(()=>{this.frameBusy=false;});},1500);await this.updateMeta();
  }catch(e){await this.stop();throw e;}
 }
 async protocolEvent({method,params={}}){
  if(this.closed)return;
  if(method==='Page.screencastFrame'){
   await this.control.send('Page.screencastFrameAck',{sessionId:params.sessionId}).catch(()=>{});
   if(Date.now()-this.lastFrame>220){this.lastFrame=Date.now();this.emit('frame',{data:params.data,width:1280,height:800});}
  }
  if(method==='Fetch.requestPaused'){
   try{await this.validateURL(params.request.url);await this.control.send('Fetch.continueRequest',{requestId:params.requestId});}
   catch{await this.control.send('Fetch.failRequest',{requestId:params.requestId,errorReason:'BlockedByClient'}).catch(()=>{});this.emit('log',{message:'Đã chặn một URL không được phép trong môi trường cloud.'});}
  }
  if(method==='Page.javascriptDialogOpening')this.emit('dialog',{type:params.type,message:String(params.message).slice(0,1500),defaultPrompt:params.defaultPrompt??''});
  if(method==='Page.fileChooserOpened')this.emit('log',{message:'Bản điều khiển này chưa hỗ trợ upload file vào website test. Các thao tác khác vẫn hoạt động.'});
  if(method==='Page.windowOpen')this.emit('log',{message:'Website đã yêu cầu mở tab mới. Dùng nút Danh sách tab để chuyển sang tab đó.'});
 }
 async updateMeta(){try{const r=await this.control.send('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,title:document.title})',returnByValue:true});const d=JSON.parse(r.result?.value??'{}');this.lastMeta={url:redactUrl(d.url??''),title:String(redact(d.title??'')).slice(0,200)};this.emit('page',this.lastMeta);}catch{}}
 async frame(attempts=5){
  let lastError;
  for(let n=0;n<attempts;n++){
   if(this.closed||this.child?.exitCode!=null||this.child?.signalCode)throw new Error('Chromium đã đóng. Kiểm tra log Render và bộ nhớ máy chủ.');
   try{const c=this.control;await c.send('Page.bringToFront');await c.send('Page.getLayoutMetrics');const r=await c.send('Page.captureScreenshot',{format:'jpeg',quality:65,captureBeyondViewport:false});this.frameWarning=false;return{data:r.data,width:1280,height:800};}
   catch(e){lastError=e;if(!/active page|not attached|target|closed|context|timed out/i.test(e.message))throw e;if(n+1<attempts)await delay(250*(n+1));}
  }
  throw lastError;
 }
 async navigate(url){await this.control.send('Page.navigate',{url:await this.validateURL(url)});}
 async action(a){
  const c=this.control;
  if(!c||this.closed)throw new Error('Phiên trình duyệt đã kết thúc.');
  if(a.type==='navigate')return this.navigate(a.url);
  if(a.type==='reload')return c.send('Page.reload');
  if(a.type==='back'||a.type==='forward'){const h=await c.send('Page.getNavigationHistory'),entry=h.entries[h.currentIndex+(a.type==='back'?-1:1)];if(entry){await this.validateURL(entry.url);return c.send('Page.navigateToHistoryEntry',{entryId:entry.id});}return;}
  if(a.type==='text'){if(typeof a.text!=='string'||a.text.length>8000)throw new Error('Nội dung nhập quá dài.');return c.send('Input.insertText',{text:a.text});}
  if(a.type==='key'){
   const keys={Enter:13,Tab:9,Backspace:8,Delete:46,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34};
   if(!keys[a.key]&&a.key!=='a')throw new Error('Phím không được hỗ trợ.');
   const params={key:a.key,code:a.key==='a'?'KeyA':a.key,windowsVirtualKeyCode:keys[a.key]??65,modifiers:Number(a.modifiers)&15};await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...params});return c.send('Input.dispatchKeyEvent',{type:'keyUp',...params});
  }
  if(['click','wheel','pointer'].includes(a.type)){
   const x=Math.max(0,Math.min(1279,Number(a.x)||0)),y=Math.max(0,Math.min(799,Number(a.y)||0));
   if(a.type==='wheel')return c.send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:Math.max(-1500,Math.min(1500,Number(a.dx)||0)),deltaY:Math.max(-1500,Math.min(1500,Number(a.dy)||0))});
   if(a.type==='pointer')return c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
   await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:a.count===2?2:1,x,y});return c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:a.count===2?2:1,x,y});
  }
  if(a.type==='dialog')return c.send('Page.handleJavaScriptDialog',{accept:!!a.accept,promptText:String(a.text??'').slice(0,1000)});
  if(a.type==='tab'){const target=(await listTargets(this.port)).find(t=>t.id===a.id);if(!target)throw new Error('Tab không còn tồn tại.');await this.validateURL(target.url);await c.send('Page.stopScreencast').catch(()=>{});c.close();this.control=new CDPConnection(target.webSocketDebuggerUrl);await this.control.connect();this.control.on('event',m=>void this.protocolEvent(m).catch(()=>{}));await this.control.send('Page.enable');await this.control.send('Runtime.enable');await this.control.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});await this.control.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await this.control.send('Page.bringToFront');await this.control.send('Page.startScreencast',{format:'jpeg',quality:65,maxWidth:1280,maxHeight:800});return;}
  throw new Error('Thao tác không được hỗ trợ.');
 }
 async tabs(){return(await listTargets(this.port)).map(t=>({id:t.id,title:String(redact(t.title)),url:redactUrl(t.url)}));}
 async stop(){if(this.closed)return;this.closed=true;clearInterval(this.metaTimer);clearInterval(this.frameTimer);try{await this.collector?.stop();}catch{}this.control?.close();if(this.child?.exitCode===null){this.child.kill('SIGTERM');await Promise.race([new Promise(r=>this.child.once('exit',r)),delay(2000)]);if(this.child.exitCode===null)this.child.kill('SIGKILL');}if(this.dir)await rm(this.dir,{recursive:true,force:true}).catch(()=>{});}
}
