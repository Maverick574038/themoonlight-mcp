import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { readConfig, validateCommand } from './config.mjs';
import { fileURLToPath } from 'node:url';

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error('Request too large');
    chunks.push(chunk);
  }
  // Decode only after joining bytes: a Chinese character may span HTTP chunks.
  const body = new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks));
  return JSON.parse(body || '{}');
}
export async function createBridge(config, options = {}) {
  const now=options.now || Date.now;
  let browser = null, browserId = null, browserVersion = null, lastUsed = now(), closing=null;
  const pending = new Map();
  const diagnostics=[];
  const trace=(event,detail='')=>{diagnostics.push({at:new Date().toISOString(),event,detail});if(diagnostics.length>12)diagnostics.shift();};
  const json = (res, status, value) => { if(res.destroyed || res.writableEnded)return; res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    if (!['127.0.0.1', `127.0.0.1:${server.address()?.port}`].includes(req.headers.host)) return json(res, 403, {error:'Invalid Host'});
    // The browser page itself cannot call local control endpoints, even if it tries CORS.
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, {error:'Browser origins forbidden'});
    if (!equal(req.headers.authorization, `Bearer ${config.clientToken}`)) return json(res, 401, {error:'Unauthorized'});
    lastUsed = now();
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, {name:'themoonlight-reader-mcp', version:'0.1.2', browserConnected:browser?.readyState === WebSocket.OPEN, browserId, browserVersion, pending:pending.size, timedOutPending:[...pending.values()].filter(job=>job.timedOut).length, diagnostics});
    if (req.method !== 'POST' || req.url !== '/command') return json(res, 404, {error:'Not found'});
    try {
      const command = validateCommand(await readBody(req));
      if (!browser || browser.readyState !== WebSocket.OPEN) return json(res, 503, {error:'请先在 Chrome 载入 extension-install 扩展，并在扩展中点击「连接」。'});
      json(res, 200, await dispatch(command));
    } catch (error) { json(res, 400, {error:error.message}); }
  });
  const wss = new WebSocketServer({noServer:true,maxPayload:8*1024*1024});
  server.on('upgrade', (req, socket, head) => {
    trace('websocket_upgrade', /^chrome-extension:\/\//.test(req.headers.origin||'')?'extension_origin':'other_origin');
    if (req.url !== '/browser' || !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || '') || req.headers.host !== `127.0.0.1:${server.address()?.port}`) {trace('upgrade_rejected');socket.destroy(); return;}
    wss.handleUpgrade(req, socket, head, ws => {
      let authenticated = false;
      const authTimer = setTimeout(()=>ws.close(1008,'Authentication required'),3000);
      ws.on('message', data => {
        let message; try {message=JSON.parse(data.toString());} catch {ws.close(1008);return;}
        if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
          ws.close(1008,'Invalid message'); return;
        }
        if (!authenticated) {
          if (message.type !== 'hello' || !equal(message.token, config.browserToken)) {trace('authentication_rejected');ws.close(1008,'Unauthorized'); return;}
          // Wait for the old socket's close handler to settle its pending operation.
          if (browser) { ws.close(1008,'Another browser is connected'); return; }
          authenticated=true;lastUsed=now();trace('authenticated'); clearTimeout(authTimer); browser=ws; browserId=req.headers.origin.replace('chrome-extension://','');
          browserVersion=typeof message.version === 'string' && /^\d+(?:\.\d+){0,3}$/.test(message.version) && message.version.length<=64 ? message.version : null;
          ws.send(JSON.stringify({type:'ready'})); return;
        }
        if (browser !== ws) { ws.close(1008,'Inactive browser session'); return; }
        if (message.type === 'ping') { lastUsed=now();ws.send(JSON.stringify({type:'pong'})); return; }
        const hasError=Object.hasOwn(message,'error'),hasResult=Object.hasOwn(message,'result');
        if (message.type !== 'result' || typeof message.id !== 'string' || hasError === hasResult || (hasError && (typeof message.error !== 'string' || !message.error))) {
          ws.close(1008,'Invalid result'); return;
        }
        const job=pending.get(message.id);
        if (job && job.browser === ws) {
          clearTimeout(job.timer);pending.delete(message.id);lastUsed=now();
          hasError ? job.reject(new Error(message.error)) : job.resolve(message.result);
        }
      });
      ws.on('close',(code)=>{
        trace('websocket_closed',String(code));
        clearTimeout(authTimer);
        if(browser===ws){browser=null;browserId=null;browserVersion=null;lastUsed=now();for(const job of pending.values()){clearTimeout(job.timer);job.reject(new Error('扩展连接中断；未自动重试，请先检查页面，尤其不要重复发送 AI 请求。'));}pending.clear();}
      });
      ws.on('error',()=>{});
    });
  });
  function dispatch(command) {
    if (pending.size >= 1) {
      const timedOut=[...pending.values()].some(job=>job.timedOut);
      return Promise.reject(new Error(timedOut
        ? '已有页面操作执行中：上次请求已超时，但扩展尚未完成。请等待；若长期无响应，请在扩展中断开并重新连接，再核查页面。'
        : '已有页面操作执行中，请等待后再试。'));
    }
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),socket=browser;
      const job={resolve,reject,browser:socket,timer:null,timedOut:false};
      job.timer=setTimeout(()=>{
        // HTTP timeout does not cancel an operation already executing in Chrome.
        // Keep the slot until its result or a disconnect prevents queued late sends.
        job.timedOut=true;
        reject(new Error('页面操作超时。AI 发送状态可能不确定，请待当前操作结束后读取对话确认；不要自动重发。'));
      }, options.commandTimeout || 60000);
      pending.set(id,job);
      const failed=error=>{
        if (!error || pending.get(id) !== job) return;
        clearTimeout(job.timer);pending.delete(id);
        reject(new Error('扩展连接发送失败；未自动重试，请先检查页面。'));
      };
      try { socket.send(JSON.stringify({type:'command',id,command}),failed); }
      catch(error) { failed(error); }
    });
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
  async function checkIdle(){
    const connected=browser?.readyState===WebSocket.OPEN;
    // An enabled, authenticated browser session must not be closed merely because Codex is idle.
    if(options.idleMs && !connected && !pending.size && now()-lastUsed>options.idleMs){await close();return true;}
    return false;
  }
  const idle=setInterval(()=>{void checkIdle();},30000);idle.unref();
  function close(){
    if(closing)return closing;
    closing=(async()=>{
      clearInterval(idle);
      for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Bridge closed'));}
      pending.clear();
      for(const ws of wss.clients)ws.terminate();
      if(server.listening)await new Promise(resolve=>server.close(resolve));
    })();
    return closing;
  }
  return {server,wss,close,checkIdle,port:server.address().port};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createBridge(await readConfig(),{idleMs:30*60*1000}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
