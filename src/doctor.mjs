import packageInfo from '../package.json' with {type:'json'};
import { ensureBridge, request, command } from './client.mjs';
import { ROOT } from './config.mjs';
try {
 const config=await ensureBridge();
 let health=await request(config,'/health');
 for(let i=0;i<10&&!health.browserConnected;i++){await new Promise(resolve=>setTimeout(resolve,500));health=await request(config,'/health');}
 console.log(`本机 MCP：正常（127.0.0.1:${config.port}）`);
 console.log(`本机服务版本：${health.version}；项目版本：${packageInfo.version}`);
 console.log(`Chrome 扩展：${health.browserConnected?'已完成鉴权连接':'尚未连接'}`);
 if(health.version!==packageInfo.version)console.log('本机服务仍是旧版，请在没有页面操作时重启本机连接服务。');
 if(health.browserConnected&&health.browserVersion!==packageInfo.version)console.log('Chrome 扩展尚未加载新版：请在 chrome://extensions 重新加载「Moonlight · Codex 本地连接」，然后点击扩展中的「连接」。');
 if(health.timedOutPending)console.log('有已超时但尚未结束的页面操作；请等待，或在扩展中断开并重新连接后核查页面。');
 if(health.browserConnected){const result=await command({action:'tabs'});console.log(`可用 Moonlight 标签页：${result.tabs.length}`);}
 else {
  console.log('本机服务已经启动；已载入的扩展通常会自动重新连接，也可在扩展弹窗点击「连接」。');
  console.log(`尚未载入扩展时，请选择：${ROOT}extension-install`);
  console.log('请区分新扩展「Moonlight · Codex 本地连接」与原来的论文阅读扩展。');
  console.log('载入后点击新扩展图标，再点击「连接」。');
  if(health.diagnostics?.length)console.log(JSON.stringify(health.diagnostics,null,2));
 }
}catch(error){console.error(error.message);process.exitCode=1;}
