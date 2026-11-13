import { CONNECTION } from './connection.js';
import { pageOperation } from './adapter.js';
import { conversationOperation } from './conversations.js';

const BASE = `http://127.0.0.1:${CONNECTION.port}`;
const EXPIRY_MS = 600000;
let socket = null, retry = null, enabled = false, authenticated = false, lastError = '';
let serial = Promise.resolve(), storageSerial = Promise.resolve();
const stages = new Map();
const isMoonlight = url => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['themoonlight.io', 'www.themoonlight.io'].includes(u.hostname);
  } catch { return false; }
};
const paperIdPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const expired = stage => Date.now() - stage.created >= EXPIRY_MS;
const recordError = error => { lastError = error?.message || String(error); };
async function badge(text, color = '#475569') {
  await chrome.action.setBadgeText({text});
  await chrome.action.setBadgeBackgroundColor({color});
}
function persistStages() {
  const pending = [...stages.values()].map(stage => ({...stage}));
  storageSerial = storageSerial.catch(() => {}).then(() => chrome.storage.session.set({pending}));
  return storageSerial;
}
function connect() {
  if (!enabled || socket && socket.readyState < 2) return;
  clearTimeout(retry);
  const ws = new WebSocket(`ws://127.0.0.1:${CONNECTION.port}/browser`);
  socket = ws;
  authenticated = false;
  let heartbeat = null;
  const current = () => enabled && socket === ws && authenticated && ws.readyState === 1;
  const assertActive = () => {
    if (!current()) throw new Error('连接已中断，尚未执行的页面操作已取消；请重新检查页面。');
  };
  const reply = value => { if (current()) ws.send(JSON.stringify(value)); };
  ws.onopen = () => {
    if (!enabled || socket !== ws) { ws.close(); return; }
    ws.send(JSON.stringify({type:'hello', token:CONNECTION.token, version:chrome.runtime.getManifest().version}));
  };
  ws.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== 'object' || socket !== ws || !enabled) return;
    if (message.type === 'ready') {
      if (authenticated) return;
      authenticated = true;
      lastError = '';
      void badge('ON', '#16704a').catch(recordError);
      heartbeat = setInterval(() => {
        try { if (current()) ws.send(JSON.stringify({type:'ping'})); }
        catch (error) { recordError(error); ws.close(); }
      }, 20000);
      return;
    }
    if (message.type !== 'command' || !current()) return;
    serial = serial.catch(recordError).then(async () => {
      // Never replay commands queued on a disconnected/replaced connection.
      assertActive();
      try {
        const result = await execute(message.command, assertActive);
        reply({type:'result', id:message.id, result});
      } catch (error) {
        reply({type:'result', id:message.id, error:error.message});
      }
    }).catch(recordError);
  };
  ws.onclose = event => {
    clearInterval(heartbeat);
    if (socket !== ws) return;
    socket = null;
    authenticated = false;
    lastError = event.reason || `连接已断开（${event.code}），请确认本机 MCP 已启动。`;
    void badge(enabled ? '…' : 'OFF').catch(recordError);
    if (enabled) retry = setTimeout(connect, 3000);
  };
  ws.onerror = () => {
    if (socket === ws) lastError = '无法连接本机 127.0.0.1:' + CONNECTION.port;
    ws.close();
  };
}
async function target(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isMoonlight(tab.url)) throw new Error('只允许访问 themoonlight.io 页面。');
  return tab;
}
async function run(tabId, command, assertActive = () => {}) {
  const tab = await target(tabId);
  assertActive();
  // PDF.js throttles lazy rendering in inactive tabs. Reading pages intentionally shows the paper.
  if (command.action === 'pages' && !tab.active) await chrome.tabs.update(tabId, {active:true});
  assertActive();
  // Probe every permitted frame before any action; never run a send in multiple frames.
  const frames = await chrome.scripting.executeScript({target:{tabId, allFrames:true}, func:pageOperation, args:[{action:'probe'}], world:'ISOLATED'});
  const surface = command.action === 'library' ? 'library' : 'viewer';
  const active = frames.filter(result => result.result?.surface === surface);
  if (active.length !== 1) throw new Error(active.length ? '检测到多个阅读器，已在操作前停止以避免重复操作。' : '未找到对应页面。请等待 Moonlight 加载，或切换到论文库/论文阅读页。');
  assertActive();
  const results = await chrome.scripting.executeScript({target:{tabId, frameIds:[active[0].frameId]}, func:command.action.startsWith('conversation_')?conversationOperation:pageOperation, args:[{...command,paperTitle:tab.title}], world:'ISOLATED'});
  const result = results[0]?.result;
  if(result?.operationError)throw new Error(result.operationError);
  if (!result || result.skipped) throw new Error('页面在操作前发生变化，请重新检查。');
  return {...result, title:tab.title};
}
async function execute(command, assertActive = () => {}) {
  await initialized;
  assertActive();
  if (command.action === 'tabs') {
    const tabs = (await chrome.tabs.query({url:['https://www.themoonlight.io/*', 'https://themoonlight.io/*']})).filter(tab => isMoonlight(tab.url));
    return {tabs:tabs.map(tab => ({tabId:tab.id, title:tab.title, url:tab.url, active:tab.active})), notice:'仅列出 Moonlight 标签页。'};
  }
  if (command.action === 'open_paper') {
    if (!paperIdPattern.test(command.paperId)) throw new Error('无效的论文 ID。');
    const url = `https://www.themoonlight.io/paper/${command.paperId}`;
    const existing = (await chrome.tabs.query({url:['https://www.themoonlight.io/paper/*', 'https://themoonlight.io/paper/*']})).find(tab => {
      if (!isMoonlight(tab.url)) return false;
      return new URL(tab.url).pathname.replace(/\/$/, '').toLowerCase() === `/paper/${command.paperId}`.toLowerCase();
    });
    assertActive();
    const tab = existing || await chrome.tabs.create({url, active:false});
    return {tabId:tab.id, url:tab.url || url, notice:'论文已打开；等待加载后读取。'};
  }
  if (command.action === 'ai_prepare') {
    for (const [key, value] of stages) if (expired(value)) stages.delete(key);
    if (stages.size >= 20) throw new Error('待确认请求过多，请先处理扩展中的请求。');
    const result = await run(command.tabId, command, assertActive);
    if (!paperIdPattern.test(result.paperId)) throw new Error('无法确认当前论文身份，请等待论文加载后重新准备。');
    const requestId = crypto.randomUUID().replaceAll('-', '');
    stages.set(requestId, {requestId, tabId:command.tabId, question:command.question, paperId:result.paperId, title:result.title, created:Date.now(), approved:false, status:'prepared'});
    try { await persistStages(); } catch (error) { stages.delete(requestId); throw error; }
    await badge('确认', '#a55b00');
    return {...result, requestId, approval:'required_in_extension_popup', expiresInSeconds:600};
  }
  if (command.action === 'ai_submit') {
    const stage = stages.get(command.requestId);
    if (!stage || expired(stage)) throw new Error('请求不存在或已过期，请重新准备。');
    if (stage.tabId !== command.tabId) throw new Error('标签页不匹配。');
    if (stage.result) return stage.result;
    if (stage.status !== 'prepared') throw new Error('此请求曾尝试发送，状态不确定。请读取对话核查，不会重发。');
    if (!stage.approved) throw new Error('请先点击扩展图标，确认该问题。');
    const current = await run(stage.tabId, {action:'paper'}, assertActive);
    if (current.paperId !== stage.paperId) throw new Error('论文已切换，请重新准备问题。');
    // Popup cancellation and expiry can occur while awaiting the page probe.
    if (stages.get(command.requestId) !== stage || !stage.approved || expired(stage)) throw new Error('请求已取消或过期，请重新准备。');
    assertActive();
    stage.status = 'attempted';
    await persistStages();
    // A request becomes non-repeatable before it reaches the page.
    stage.result = await run(stage.tabId, {...command, question:stage.question, expectedPaperId:stage.paperId}, assertActive);
    stage.status = stage.result.status;
    await persistStages();
    return stage.result;
  }
  return run(command.tabId, command, assertActive);
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  (async () => {
    await initialized;
    if (message.type === 'state') return {connected:authenticated && socket?.readyState === 1, enabled, lastError, pending:[...stages.values()].filter(value => value.status === 'prepared' && !expired(value)), base:BASE};
    if (message.type === 'connect') {
      enabled = true;
      await chrome.storage.local.set({enabled});
      connect();
      return {ok:true};
    }
    if (message.type === 'disconnect') {
      enabled = false;
      authenticated = false;
      clearTimeout(retry);
      socket?.close();
      await chrome.storage.local.set({enabled});
      await badge('OFF');
      return {ok:true};
    }
    if (message.type === 'approve') {
      const stage = stages.get(message.requestId);
      if (!stage || stage.status !== 'prepared' || expired(stage)) throw new Error('请求已过期。');
      stage.approved = true;
      try { await persistStages(); } catch (error) { stage.approved = false; throw error; }
      return {ok:true};
    }
    if (message.type === 'reject') {
      const stage = stages.get(message.requestId);
      if (stage && stage.status !== 'prepared') throw new Error('请求已尝试发送，请读取对话核查；无法撤回。');
      stages.delete(message.requestId);
      await persistStages();
      return {ok:true};
    }
    throw new Error('Unknown message');
  })().then(respond, error => respond({error:error.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'reconnect') void initialized.then(() => { if (enabled) connect(); }).catch(recordError);
});
async function init() {
  const local = await chrome.storage.local.get('enabled');
  enabled = local.enabled === true;
  const saved = await chrome.storage.session.get('pending');
  for (const stage of saved.pending || []) if (!expired(stage)) stages.set(stage.requestId, stage);
  await chrome.alarms.create('reconnect', {periodInMinutes:0.5});
  if (enabled) connect();
  else await badge('OFF');
}
const initialized = init();
void initialized.catch(recordError);
