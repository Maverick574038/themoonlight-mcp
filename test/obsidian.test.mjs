import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {importToObsidian,safeName} from '../src/obsidian.mjs';
const paperId='11111111-1111-4111-8111-111111111111';
const bundle=()=>({paperId,title:'Paper title',url:`https://www.themoonlight.io/paper/${paperId}`,complete:true,conversations:[{entry:{kind:'discussion',title:'Question'},messages:[{role:'user',markdown:'Full question'},{role:'assistant',markdown:'Full **answer**\n\n```js\na()\n```'}]}]});
async function vault(t){const p=await mkdtemp(path.join(os.tmpdir(),'moonlight-obsidian-'));t.after(()=>rm(p,{recursive:true,force:true}));await mkdir(path.join(p,'.obsidian'));return realpath(p);}
test('import reuses canonical existing paper branch, creates all four folders and is idempotent',async t=>{
 const v=await vault(t);const branch=path.join(v,'论文阅读','Existing paper');await mkdir(path.join(branch,'论文原文'),{recursive:true});await writeFile(path.join(branch,'论文原文','阅读入口.md'),bundle().url);await mkdir(path.join(branch,'问答'));const manual=path.join(branch,'问答','Moonlight已有问答.md');await writeFile(manual,'My manual note');
 const result=await importToObsidian(bundle(),{vaultPath:v});assert.equal(result.folder,branch);assert.equal(result.created,1);for(const dir of ['论文原文','配图','解释','问答'])assert.ok((await readdir(branch)).includes(dir));assert.equal(await readFile(manual,'utf8'),'My manual note');assert.match(await readFile(path.join(branch,'问答',result.files[0].file),'utf8'),/Full \*\*answer\*\*/);
 const again=await importToObsidian(bundle(),{vaultPath:v});assert.equal(again.unchanged,1);assert.equal(again.created,0);assert.equal(again.index,result.index);
});
test('new replies create snapshots; existing user edits are never overwritten',async t=>{
 const v=await vault(t),b=bundle();const first=await importToObsidian(b,{vaultPath:v});const file=path.join(first.folder,'问答',first.files[0].file);await writeFile(file,'My edited version');await assert.rejects(()=>importToObsidian(b,{vaultPath:v}),/未覆盖手工修改/);assert.equal(await readFile(file,'utf8'),'My edited version');
 b.conversations[0].messages.push({role:'user',markdown:'Next question'},{role:'assistant',markdown:'Next answer'});const next=await importToObsidian(b,{vaultPath:v});assert.equal(next.created,1);assert.notEqual(next.files[0].file,first.files[0].file);assert.equal(await readFile(file,'utf8'),'My edited version');
});
test('incomplete and empty bundles create no paper branches',async t=>{
 const v=await vault(t);for(const b of [{...bundle(),complete:false},{...bundle(),conversations:[]}])await assert.rejects(()=>importToObsidian(b,{vaultPath:v}),/完整会话/);assert.deepEqual(await readdir(v),['.obsidian']);
});
test('unsafe titles stay inside the vault and symlink destinations are refused',async t=>{
 const v=await vault(t),b=bundle();b.title='../../escape/恶意';const r=await importToObsidian(b,{vaultPath:v});assert.equal(path.dirname(r.folder),path.join(v,'论文阅读'));assert.ok(!safeName('x'.repeat(400)).includes('/'));assert.ok(Buffer.byteLength(safeName('论文'.repeat(300)))<=180);
 const v2=await vault(t);await symlink(v,path.join(v2,'论文阅读'));await assert.rejects(()=>importToObsidian(bundle(),{vaultPath:v2}),/符号链接/);
});
test('same title on different papers produces separate branches and concurrent lock is respected',async t=>{
 const v=await vault(t),a=await importToObsidian(bundle(),{vaultPath:v});const b=bundle();b.paperId='22222222-2222-4222-8222-222222222222';b.url=`https://www.themoonlight.io/paper/${b.paperId}`;const c=await importToObsidian(b,{vaultPath:v});assert.notEqual(c.folder,a.folder);
 await writeFile(path.join(v,'论文阅读','.moonlight-import.lock'),'');await assert.rejects(()=>importToObsidian(b,{vaultPath:v}),/另一个导入/);
});
