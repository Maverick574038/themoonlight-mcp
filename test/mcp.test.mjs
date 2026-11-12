import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createBridge} from '../src/bridge.mjs';
import {ROOT} from '../src/config.mjs';

test('real MCP stdio handshake, tool discovery, validation and actionable disconnected status',async t=>{
 const bridge=await createBridge({port:0,clientToken:'test-client',browserToken:'test-browser'});t.after(()=>bridge.close());
 let startupHealthRequests=0;bridge.server.on('request',req=>{if(req.url==='/health')startupHealthRequests++;});
 const dir=await mkdtemp(path.join(os.tmpdir(),'moonlight-mcp-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const configFile=path.join(dir,'config.json');await writeFile(configFile,JSON.stringify({port:bridge.port,clientToken:'test-client',browserToken:'test-browser'}),{mode:0o600});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'src/server.mjs')],env:{...process.env,MOONLIGHT_MCP_CONFIG:configFile},stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',chunk=>stderr+=chunk);
 const client=new Client({name:'moonlight-integration-test',version:'1.0.0'});t.after(()=>client.close());
 await client.connect(transport);
 const result=await client.listTools();
 for(let i=0;i<20&&!startupHealthRequests;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(startupHealthRequests>0,'MCP startup should check/start its bridge before the first tool call');assert.equal(result.tools.length,10);assert.ok(result.tools.some(t=>t.name==='moonlight_submit_question'));
 const status=await client.callTool({name:'moonlight_status',arguments:{}});assert.equal(status.isError,undefined);assert.equal(JSON.parse(status.content[0].text).browserConnected,false);
 const offline=await client.callTool({name:'moonlight_tabs',arguments:{}});assert.equal(offline.isError,true);assert.match(offline.content[0].text,/Chrome/);
 const invalid=await client.callTool({name:'moonlight_open_paper',arguments:{paperId:'not-a-uuid'}});assert.equal(invalid.isError,true);
 assert.doesNotMatch(stderr,/uncaught|unhandled/i);
});
