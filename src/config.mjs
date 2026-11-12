import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CONFIG_PATH = process.env.MOONLIGHT_MCP_CONFIG || path.join(ROOT, '.local', 'bridge.json');

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535 ||
      !['clientToken', 'browserToken'].every(key => typeof config[key] === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(config[key])) ||
      config.clientToken === config.browserToken) {
    throw new Error('连接配置无效：请检查端口和两份独立凭证；不会自动覆盖现有配置。');
  }
  return config;
}
export async function readConfig(configPath = CONFIG_PATH) {
  let source;
  try { source = await readFile(configPath, 'utf8'); }
  catch (cause) {
    throw new Error(cause.code === 'ENOENT' ? '尚未初始化。请在项目目录运行 npm run setup。' : '无法读取连接配置，请检查文件访问权限。', { cause });
  }
  let config;
  try { config = JSON.parse(source); }
  catch { throw new Error('连接配置不是有效 JSON；请修复配置，不会自动更换连接凭证。'); }
  return validateConfig(config);
}
export async function ensureConfig(configPath = CONFIG_PATH) {
  try { return await readConfig(configPath); }
  catch (error) { if (error.cause?.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const config = { port: 47831, clientToken: randomBytes(32).toString('hex'), browserToken: randomBytes(32).toString('hex') };
  try { await writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return readConfig(configPath); }
  await chmod(configPath, 0o600);
  return config;
}
export function bridgeUrl(config) { return `http://127.0.0.1:${config.port}`; }
export const ACTIONS = new Set(['tabs', 'library', 'open_paper', 'paper', 'pages', 'annotations', 'ai_read', 'ai_prepare', 'ai_submit']);
export function validateCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ACTIONS.has(value.action)) throw new Error('Unknown action');
  if (value.action !== 'tabs' && value.action !== 'open_paper' && (!Number.isSafeInteger(value.tabId) || value.tabId < 0)) throw new Error('A nonnegative tabId is required');
  if (value.action === 'open_paper' && (typeof value.paperId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.paperId))) throw new Error('Invalid Moonlight paper ID');
  if (value.action === 'pages' && (!Number.isSafeInteger(value.startPage) || !Number.isSafeInteger(value.endPage) || value.startPage < 1 || value.endPage < value.startPage || value.endPage - value.startPage > 9)) throw new Error('Read 1–10 pages at a time');
  if (value.action === 'library' && (value.query !== undefined && (typeof value.query !== 'string' || value.query.length > 500) || value.maxPages !== undefined && (!Number.isSafeInteger(value.maxPages) || value.maxPages < 1 || value.maxPages > 20))) throw new Error('Library query must be at most 500 characters and maxPages must be 1–20');
  if (value.action === 'annotations' && !['notes', 'highlights', 'comments', 'explanations'].includes(value.kind)) throw new Error('Invalid annotation kind');
  if (value.action === 'ai_prepare' && (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 12000)) throw new Error('Question must contain 1–12000 characters');
  if (value.action === 'ai_submit' && (typeof value.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(value.requestId))) throw new Error('Invalid requestId');
  return value;
}
