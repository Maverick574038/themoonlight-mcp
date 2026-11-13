import {collectConversations} from './conversations.mjs';
import {importToObsidian} from './obsidian.mjs';
const [tabId,vaultPath]=process.argv.slice(2);
if(!/^\d+$/.test(tabId||''))throw new Error('用法：npm run import:obsidian -- <tabId> [Obsidian库路径]');
const bundle=await collectConversations({tabId:Number(tabId)});
const result=await importToObsidian(bundle,{vaultPath});
console.log(JSON.stringify(result,null,2));
