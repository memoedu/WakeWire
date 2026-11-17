/** Manual one-way sync commands inside the existing article workflow; no scheduler or publication. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import assert from 'node:assert/strict';
import {ArticleRemNoteMcp,ZhihuPublisher} from '../dist/workflows/remnote-zhihu-cli.js';
import {snapshotArticle,scanArticles,validateArticle,nextPublicationSlot} from '../dist/workflows/remnote-zhihu.js';
import {auditArticles,articleFeedback} from '../dist/workflows/remnote-zhihu-review.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{out:{type:'string'},bindings:{type:'string'},apply:{type:'boolean',default:false}}});
const [action,configFile]=positionals;
assert(['pull','push-drafts'].includes(action)&&configFile&&path.isAbsolute(configFile)&&values.out&&path.isAbsolute(values.out),'Use pull|push-drafts <absolute config> --out <absolute bundle> [--bindings <file>] [--apply]');
const cfg=JSON.parse(fs.readFileSync(configFile,'utf8'));
const home=path.dirname(configFile),bundle=values.out,scripts=path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(bundle,{recursive:true});
const stateFile=path.join(home,'state.json'),syncFile=path.join(home,'sync-state.json');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
let state,sync;
const atomic=(file,value)=>{const temporary=file+'.tmp';const fd=fs.openSync(temporary,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);};
const capture=(name,value)=>{const file=path.join(bundle,name);assert(!fs.existsSync(file),'Capture exists; use a new bundle or inspect the known result');atomic(file,value);};
const run=(program,args,input)=>new Promise((resolve,reject)=>{
 const child=spawn(program,args,{cwd:scripts,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',bytes=0;
 child.stdout.setEncoding('utf8');
 const timer=setTimeout(()=>{child.kill();reject(Error('Sync helper timeout; inspect known mutation results before retry'));},300000);
 child.stdout.on('data',data=>{bytes+=Buffer.byteLength(data,'utf8');if(bytes>16*1024*1024){child.kill();return reject(Error('Sync helper output exceeded bound'));}out+=data;});
 child.stderr.resume();child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('Sync helper failed; inspect bundle and known state'));resolve(out);});child.stdin.end(input?JSON.stringify(input):undefined);
});
const helper=async request=>{const result=JSON.parse(await run(cfg.python,[path.join(scripts,'zhihu_sync.py')],{configFile,...request}));assert(result.ok,result.error);return result.data;};
const publisher=new ZhihuPublisher(cfg);
publisher.publish=async()=>{throw Error('Directional sync never publishes articles');};
const reader=new ArticleRemNoteMcp();
let lockOwned=false;
const lock=()=>{const fd=fs.openSync(path.join(home,'run.lock'),'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,operation:'directional-sync'}));fs.fsyncSync(fd);fs.closeSync(fd);lockOwned=true;};
const unlock=()=>{if(lockOwned){fs.unlinkSync(path.join(home,'run.lock'));lockOwned=false;}};
try{
 if(action==='push-drafts'&&values.apply)lock();
 state=read(stateFile);sync=fs.existsSync(syncFile)?read(syncFile):{version:1,articles:{},drafts:{}};
 await reader.connect(cfg.mcpUrl,cfg.knowledgeBaseId);
 if(action==='pull'){
  const receipts=state.receipts.filter(r=>r.stage==='archived');assert(receipts.length,'No completed mapped publications');
  const articles=await helper({action:'read-published',ids:receipts.map(r=>r.articleId)});
  const captures=[],plans=[];
  for(const receipt of receipts){
   const article=articles.find(a=>String(a.id)===receipt.articleId);assert(article);
   const source=await snapshotArticle(reader,receipt.source.remId,Boolean(receipt.source.tagTrigger),cfg.aiGeneratedTagRemId,true);
   const baseline=sync.articles[receipt.articleId]?.sourceBaseline??receipt.source;
   const plan=await helper({action:'plan',source,baseline,article});plans.push(plan);captures.push({articleId:receipt.articleId,source,article});
  }
  capture('pull-plan.json',plans);capture('capture.json',captures);
  if(!values.apply){console.log(JSON.stringify({status:'sync-plan',articles:plans.length,changes:plans.flatMap(p=>p.changes).length,published:0}));}
  else{
   const current=await helper({action:'read-published',ids:receipts.map(r=>r.articleId)});
   for(const item of captures)await helper({action:'assert-published',before:item.article,article:current.find(a=>String(a.id)===item.articleId)});
   await run(process.execPath,[path.join(scripts,'zhihu_sync_apply.mjs'),configFile,bundle]);
   lock();
   const proof=[];
   for(const item of captures){
    const source=await snapshotArticle(reader,item.source.remId,Boolean(item.source.tagTrigger),cfg.aiGeneratedTagRemId,true);
    const verified=await helper({action:'verify',source,before:item.source,article:item.article});proof.push({articleId:item.articleId,...verified});
    sync.articles[item.articleId]={sourceId:source.remId,sourceBaseline:source,publishedSnapshot:item.article,lastPullAt:new Date().toISOString(),publicationFooter:verified.publicationFooter};
   }
   atomic(syncFile,sync);atomic(path.join(bundle,'verification.json'),proof);
   console.log(JSON.stringify({status:'sync-pull-verified',articles:proof.length,created:Object.keys(read(path.join(bundle,'pull-journal.json')).nodes).length,published:0}));
  }
 }else{
  assert(values.bindings&&path.isAbsolute(values.bindings),'Explicit source/draft bindings are required');
  const bindings=read(values.bindings);assert(Array.isArray(bindings)&&bindings.length&&bindings.length<=20);
  assert(new Set(bindings.map(b=>b.sourceId)).size===bindings.length&&new Set(bindings.map(b=>b.draftId)).size===bindings.length);
  const scan=await scanArticles(reader,cfg.documentRemId,cfg.publishedTagRemId,cfg.aiGeneratedTagRemId);
  const stats=await publisher.seriesStats(),clouds=[];let maxOrdinal=Math.max(stats.publishedCount,stats.maxOrdinal);
  for(const binding of bindings){const cloud=await publisher.readDraft(binding.draftId);assert.equal(cloud.authorId,cfg.accountId);assert.equal(cloud.state,'draft');
   const text=JSON.parse(cloud.format).blocks.map(b=>b.text??'').join('\n');const found=/^第(\d+)篇\|day(\d+)$/mu.exec(text);if(found)maxOrdinal=Math.max(maxOrdinal,Number(found[1]));clouds.push({binding,cloud,existingOrdinal:found?Number(found[1]):undefined});}
  const slot=nextPublicationSlot(new Date());const date=slot.slice(0,10);const day=(Date.parse(date+'T00:00:00Z')-Date.parse(cfg.seriesStartDate+'T00:00:00Z'))/86400000+1;assert(Number.isInteger(day)&&day>0);
  const pending=[];
  for(const item of clouds){
   const source=scan.sources.find(s=>s.remId===item.binding.sourceId);assert(source,'Source is no longer eligible');
   validateArticle(source,await publisher.prepare(source.nodes),state);
   const seriesLabel=`第${item.existingOrdinal??++maxOrdinal} 篇 | day ${day}`;
   const prepared=await publisher.prepare(source.nodes,'待发布',seriesLabel);
   const raw=await helper({action:'read-draft',id:item.binding.draftId});pending.push({...item,source,prepared,seriesLabel,rawBefore:raw});
  }
  capture('drafts-before.json',pending);capture('state-before.json',state);
  if(!values.apply)console.log(JSON.stringify({status:'sync-drafts-plan',drafts:pending.length,published:0}));
  else{
   const journal={drafts:[]};atomic(path.join(bundle,'push-journal.json'),journal);
   for(const item of pending){
    const fresh=await snapshotArticle(reader,item.source.remId,Boolean(item.source.tagTrigger),cfg.aiGeneratedTagRemId,true);assert.equal(fresh.fingerprint,item.source.fingerprint,'Source changed during sync');assert.equal(fresh.parentRemId,item.source.parentRemId);
    journal.drafts.push({id:item.binding.draftId,stage:'writing',fingerprint:fresh.fingerprint});atomic(path.join(bundle,'push-journal.json'),journal);
    const saved=await publisher.writeDraft(item.binding.draftId,item.prepared.title,item.prepared.html,item.cloud);
    assert.equal(saved.text,item.prepared.text);assert.equal(saved.format,item.prepared.format);assert.equal(saved.title,item.prepared.title);assert.equal(saved.tableOfContents,item.prepared.tableOfContents);assert.equal(saved.state,'draft');
    const draft={source:fresh,...item.prepared,seriesLabel:item.seriesLabel,status:'review',reviewMode:'automatic',draftId:item.binding.draftId,editorUrl:saved.editorUrl};
    state.drafts??=[];const index=state.drafts.findIndex(d=>d.source.remId===fresh.remId);if(index>=0)state.drafts[index]=draft;else state.drafts.push(draft);atomic(stateFile,state);
    sync.drafts[fresh.remId]={draftId:saved.id,sourceBaseline:fresh,cloudBaseline:saved,seriesLabel:item.seriesLabel,lastPushAt:new Date().toISOString()};atomic(syncFile,sync);
    journal.drafts.at(-1).stage='verified';atomic(path.join(bundle,'push-journal.json'),journal);
   }
   const result=await auditArticles({remnote:reader,publisher,documentRemId:cfg.documentRemId,accountId:cfg.accountId,columnId:cfg.columnId,state,save:()=>atomic(stateFile,state),now:new Date(),slot,seriesStartDate:cfg.seriesStartDate,publishedTagRemId:cfg.publishedTagRemId,aiGeneratedTagRemId:cfg.aiGeneratedTagRemId});
   for(const item of pending){
    const final=state.drafts.find(d=>d.source.remId===item.source.remId);
    const cloud=await publisher.readDraft(item.binding.draftId);
    assert.equal(cloud.text,final.text);assert.equal(cloud.format,final.format);
    sync.drafts[item.source.remId]={draftId:cloud.id,sourceBaseline:final.source,cloudBaseline:cloud,seriesLabel:final.seriesLabel,lastPushAt:new Date().toISOString()};
   }
   atomic(syncFile,sync);
   const feedback=articleFeedback(state,new Date(),'audit',slot);const at=new Date().toISOString();
   atomic(path.join(home,'last-run.json'),{at,finishedAt:at,...result,issues:feedback.issues,summary:`草稿同步与审核完成：通过 ${result.approved} 篇，待处理 ${feedback.issues} 项；本次未发布。`,feedback});
   atomic(path.join(bundle,'verification.json'),{...result,feedback});console.log(JSON.stringify({status:'sync-drafts-verified',drafts:pending.length,...result,issues:feedback.issues,published:0}));
  }
 }
}finally{await reader.close();unlock();}
