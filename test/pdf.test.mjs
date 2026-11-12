import test from 'node:test';
import assert from 'node:assert/strict';
import {trustedPdfSource,fetchPdf,extractPdfPages} from '../src/pdf.mjs';
const id='79ad721a-10d1-4767-a6cf-dc5ded2de5d1';
const source=`https://moonlight-paper.s3.ap-northeast-2.amazonaws.com/anonymous/${id}.pdf`;
function examplePdf(){
 const stream=s=>`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',stream('BT /F1 12 Tf 72 720 Td (Original page one) Tj ET'),'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',stream('BT /F1 12 Tf 72 720 Td (Original page two) Tj ET'),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let pdf='%PDF-1.4\n';const offsets=[0];
 objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 pdf+=offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
 pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(pdf);
}
test('original PDF extraction reads cold pages independently of browser rendering',async()=>{
 const result=await extractPdfPages(examplePdf(),1,2);assert.equal(result.totalPages,2);assert.match(result.pages[0].text,/Original page one/);assert.match(result.pages[1].text,/Original page two/);
 await assert.rejects(()=>extractPdfPages(examplePdf(),1,3),/超出范围/);
});
test('only the observed Moonlight PDF host and matching document ID can be fetched',()=>{
 assert.equal(trustedPdfSource({paperId:id,pdfSource:source}),source);
 for(const url of ['http://127.0.0.1/private',source.replace('moonlight-paper.s3.ap-northeast-2.amazonaws.com','attacker.invalid'),source.replace(id,'00000000-0000-0000-0000-000000000000'),source.replace('https://','https://user:pass@')])assert.equal(trustedPdfSource({paperId:id,pdfSource:url}),null);
});
test('PDF retrieval validates type, bounds bytes, forbids redirects and omits credentials',async()=>{
 let options;const bytes=await fetchPdf(source,{fetchImpl:async(u,o)=>{options=o;return new Response(examplePdf());}});assert.ok(bytes.length>0);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
 await assert.rejects(()=>fetchPdf(source,{fetchImpl:async()=>new Response('<html>Login</html>')}),/不是有效 PDF/);
 await assert.rejects(()=>fetchPdf(source,{maxBytes:5,fetchImpl:async()=>new Response(examplePdf())}),/大小限制/);
});

test('PDF sources reject malformed identifiers and absent metadata',()=>{
 assert.equal(trustedPdfSource(null),null);
 assert.equal(trustedPdfSource({paperId:'-'.repeat(36),pdfSource:source.replace(id,'-'.repeat(36))}),null);
});
test('PDF retrieval releases rejected and oversized response streams',async()=>{
 let cancelled=0;
 const response=(status,headers={})=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(8));},cancel(){cancelled++;}}),{status,headers});
 await assert.rejects(()=>fetchPdf(source,{fetchImpl:async()=>response(403)}),/HTTP 403/);
 await assert.rejects(()=>fetchPdf(source,{maxBytes:5,fetchImpl:async()=>response(200,{'content-length':'100'})}),/大小限制/);
 await assert.rejects(()=>fetchPdf(source,{maxBytes:5,fetchImpl:async()=>response(200)}),/大小限制/);
 assert.equal(cancelled,3);
 await assert.rejects(()=>fetchPdf(source,{fetchImpl:async()=>new Response(null,{status:204})}),/响应为空/);
});
test('PDF loading and extraction timeouts reject even when destruction cannot settle',async()=>{
 let destroys=0;
 const never=new Promise(()=>{});
 const getDocumentImpl=()=>({promise:never,destroy(){destroys++;return never;}});
 await assert.rejects(()=>extractPdfPages(examplePdf(),1,1,{getDocumentImpl,timeoutMs:10}),/解析超时/);
 assert.equal(destroys,1);
 let cleaned=0;
 const extracting=()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:()=>never,cleanup(){cleaned++;}})}),destroy(){destroys++;return Promise.reject(new Error('destroy failed'));}});
 await assert.rejects(()=>extractPdfPages(examplePdf(),1,1,{getDocumentImpl:extracting,timeoutMs:10}),/解析超时/);
 assert.equal(destroys,2);assert.equal(cleaned,0);
});
test('PDF extraction cleans pages after errors and preserves the original failure',async()=>{
 let cleaned=0,destroyed=0;
 const getDocumentImpl=()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>{throw new Error('text failed');},cleanup(){cleaned++;}})}),destroy(){destroyed++;return Promise.reject(new Error('destroy failed'));}});
 await assert.rejects(()=>extractPdfPages(examplePdf(),1,1,{getDocumentImpl}),/text failed/);
 assert.equal(cleaned,1);assert.equal(destroyed,1);
});
test('concurrent PDF reads share a download, retain originals and expire cached bytes',async()=>{
 const {createOriginalPdfReader}=await import('../src/pdf.mjs');
 let downloads=0,time=0,release;
 const ready=new Promise(resolve=>{release=resolve;});
 const read=createOriginalPdfReader({fetchImpl:async()=>{downloads++;await ready;return new Response(examplePdf());},now:()=>time});
 const meta={paperId:id,pdfSource:source,url:`https://www.themoonlight.io/paper/${id}`};
 const first=read(meta,1,1),second=read(meta,2,2);release();
 const results=await Promise.all([first,second]);
 assert.equal(downloads,1);assert.match(results[0].pages[0].text,/Original page one/);assert.match(results[1].pages[0].text,/Original page two/);
 assert.equal(results[0].extractionMethod,'original_pdf');assert.equal(results[0].completeRequestedRange,true);assert.equal(results[0].pages[0].citation,`${meta.url}#page=1`);
 await read(meta,1,2);assert.equal(downloads,1);
 time=10*60*1000;await read(meta,1,1);assert.equal(downloads,2);
});
test('failed PDF downloads are retryable and invalid ranges do not download',async()=>{
 const {createOriginalPdfReader}=await import('../src/pdf.mjs');
 let downloads=0;
 const read=createOriginalPdfReader({fetchImpl:async()=>{if(++downloads===1)throw new Error('offline');return new Response(examplePdf());}});
 const meta={paperId:id,pdfSource:source,url:'https://www.themoonlight.io/paper/example'};
 await assert.rejects(()=>read(meta,2,1),/1–10 页/);assert.equal(downloads,0);
 await assert.rejects(()=>read(meta,1,1),/offline/);
 const result=await read(meta,1,1);assert.equal(downloads,2);assert.equal(result.completeRequestedRange,true);
});
test('PDF cache retains at most two documents and evicts the least recently read',async()=>{
 const {createOriginalPdfReader}=await import('../src/pdf.mjs');
 const downloads=new Map();
 const read=createOriginalPdfReader({fetchImpl:async url=>{downloads.set(url,(downloads.get(url)||0)+1);return new Response(examplePdf());},extractPages:async()=>({totalPages:1,pages:[{page:1,text:'fixture',status:'ok'}]})});
 const papers=[1,2,3].map(n=>{const paperId=`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;return {paperId,pdfSource:source.replace(id,paperId),url:'https://www.themoonlight.io/paper/example'};});
 await read(papers[0],1,1);await read(papers[1],1,1);await read(papers[0],1,1);await read(papers[2],1,1);await read(papers[0],1,1);
 assert.equal(downloads.get(papers[0].pdfSource),1);
 await read(papers[1],1,1);assert.equal(downloads.get(papers[1].pdfSource),2);
});

test('cancelling one PDF reader does not cancel another reader or poison the cache',async()=>{
 const {createOriginalPdfReader}=await import('../src/pdf.mjs');
 let downloads=0,release;
 const ready=new Promise(resolve=>{release=resolve;});
 const read=createOriginalPdfReader({fetchImpl:async()=>{downloads++;await ready;return new Response(examplePdf());}});
 const meta={paperId:id,pdfSource:source,url:'https://www.themoonlight.io/paper/example'};
 const controller=new AbortController();
 const cancelled=read(meta,1,1,{signal:controller.signal}),successful=read(meta,2,2);
 controller.abort(new Error('caller cancelled'));
 await assert.rejects(()=>cancelled,/caller cancelled/);
 release();assert.match((await successful).pages[0].text,/Original page two/);
 await read(meta,1,1);assert.equal(downloads,1);
});
test('PDF extraction cancellation destroys the parser once without awaiting stuck cleanup',async()=>{
 let destroys=0;
 const never=new Promise(()=>{}),controller=new AbortController();
 const getDocumentImpl=()=>({promise:never,destroy(){destroys++;return never;}});
 const result=extractPdfPages(examplePdf(),1,1,{getDocumentImpl,signal:controller.signal});
 controller.abort(new Error('read deadline exceeded'));
 await assert.rejects(()=>result,/read deadline exceeded/);assert.equal(destroys,1);
 await assert.rejects(()=>extractPdfPages(examplePdf(),1,1,{getDocumentImpl,signal:controller.signal}),/read deadline exceeded/);assert.equal(destroys,1);
});
test('PDF download forwards cancellation and does not fetch when already cancelled',async()=>{
 let downloads=0,signal;
 const controller=new AbortController();
 const fetchImpl=async(_url,options)=>{downloads++;signal=options.signal;return new Response(examplePdf());};
 await fetchPdf(source,{fetchImpl,signal:controller.signal});
 controller.abort(new Error('download cancelled'));assert.equal(signal.aborted,true);
 await assert.rejects(()=>fetchPdf(source,{fetchImpl,signal:controller.signal}),/download cancelled/);assert.equal(downloads,1);
});
test('PDF cleanup itself remains bounded by the extraction deadline',async()=>{
 const never=new Promise(()=>{});
 const getDocumentImpl=()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items:[]}),cleanup(){}})}),destroy:()=>never});
 await assert.rejects(()=>extractPdfPages(examplePdf(),1,1,{getDocumentImpl,timeoutMs:10}),/解析超时/);
});
