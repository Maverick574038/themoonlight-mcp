import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, bridgeUrl, validateCommand } from './config.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function request(config, pathname, body, { signal } = {}) {
  const timeout = AbortSignal.timeout(body ? 65000 : 1500);
  const response = await fetch(bridgeUrl(config) + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.clientToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  let data;
  try { data = await response.json(); }
  catch (cause) {
    if (cause.name === 'AbortError' || cause.name === 'TimeoutError' || signal?.aborted) throw signal?.reason || cause;
    throw new Error('本机端口返回了无效响应，请检查端口是否被其他程序占用。', { cause });
  }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`);
  if (pathname === '/health' && (!data || data.name !== 'themoonlight-reader-mcp' || typeof data.browserConnected !== 'boolean')) {
    throw new Error('本机端口不是预期的 Moonlight 连接服务，请检查端口占用。');
  }
  return data;
}

// Share one startup attempt within this MCP process. Failures are not cached.
export function createBridgeEnsurer({ loadConfig = readConfig, send = request, start = spawn, wait = pause } = {}) {
  let starting;
  return function ensure() {
    if (starting) return starting;
    starting = (async () => {
      const config = await loadConfig();
      try { await send(config, '/health'); return config; }
      catch (error) {
        if (error.cause?.code !== 'ECONNREFUSED') throw error;
      }
      let spawnError;
      const child = start(process.execPath, [fileURLToPath(new URL('./bridge.mjs', import.meta.url))], { detached: true, stdio: 'ignore', env: process.env });
      child.once('error', error => { spawnError = error; });
      child.unref();
      for (let i = 0; i < 25; i++) {
        await wait(100);
        if (spawnError) throw new Error(`本地连接服务无法启动：${spawnError.message}`, { cause: spawnError });
        try { await send(config, '/health'); return config; }
        catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
      }
      throw new Error(`本地连接服务无法启动。请检查 ${config.port} 端口，或运行 npm run bridge 查看错误。`);
    })().finally(() => { starting = undefined; });
    return starting;
  };
}
export const ensureBridge = createBridgeEnsurer();

export async function command(value, { signal } = {}) {
  validateCommand(value);
  const deadline = AbortSignal.timeout(70000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  signal.throwIfAborted();
  const config = await ensureBridge();
  signal.throwIfAborted();
  if (value.action === 'pages') {
    const meta = await request(config, '/command', { action: 'paper', tabId: value.tabId }, { signal });
    try {
      const { originalPdfPages } = await import('./pdf.mjs');
      signal.throwIfAborted();
      const result = await originalPdfPages(meta, value.startPage, value.endPage, { signal });
      if (result) return result;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new Error(`原始 PDF 读取失败：${error.message}。未将部分页面文字作为完整原文返回。`, { cause: error });
    }
  }
  signal.throwIfAborted();
  const result = await request(config, '/command', value, { signal });
  return value.action === 'pages' ? { ...result, extractionMethod: 'browser_text_layer' } : result;
}
