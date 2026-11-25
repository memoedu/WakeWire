/** Existing workflow hook: shared baseline, deterministic node merges, frozen scheduled revisions. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const atom=(a,b)=>a.title===b.title&&a.text===b.text&&a.format===b.format&&a.tableOfContents===b.tableOfContents;
function acceptedColumns(article){
 return [...new Set((article.contributions??[]).filter(item=>item.state==='accepted')
  .map(item=>item.column?.url_token||item.column?.id).filter(Boolean).map(String))].sort();
}
function matchesReceiptColumns(actual,receipt,legacyColumn){
 return receipt?.columnIds ? same([...actual].sort(),[...receipt.columnIds].sort()) : actual.includes(legacyColumn);
}
/** Bounded retry is used only for reads, never for a native write or publication. */
export async function retrySyncRead(read,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
 for(let attempt=0;attempt<2;attempt++){
  try{return await read();}
  catch(error){
   const message=error instanceof Error?error.message:'';
   const transient=/MCP request failed|MCP.*timed out|remnote_.*(?:timeout|request failed)|Zhihu client (?:failed: (?:HTTPError|ConnectionError|Timeout|ReadTimeout)|timed out)/i.test(message);
   if(!transient||attempt)throw error;
   await pause(2000);
  }
 }
}
export async function auditControlled(o){
 const {snapshotArticle,scanArticles,validateArticle}=o.runtime??await import('../dist/workflows/remnote-zhihu.js');
 const {state,sync,publisher,reader,cfg,slot}=o;
 sync.revisions??={};sync.operations??={};sync.articles??={};sync.drafts??={};
 const reports=[];
 const readOnly=read=>retrySyncRead(read,o.readPause);
 const report=(id,title,status,issue,draftId)=>reports.push({articleId:id,sourceRemId:entries.find(e=>e.id===id)?.source.remId,title,status,issues:issue?[issue]:[],publicationSlot:slot,...(draftId?{editorUrl:`https://zhuanlan.zhihu.com/p/${draftId}/edit`}:{}),url:`https://zhuanlan.zhihu.com/p/${id}`});
 const eligible=new Set((await readOnly(()=>scanArticles(reader,cfg.documentRemId,cfg.publishedTagRemId,cfg.aiGeneratedTagRemId))).sources.map(s=>s.remId));
 const completed=new Set(state.receipts.map(r=>r.source.remId));
 const entries=[...state.receipts.filter(r=>['verified','archived'].includes(r.stage)).map(r=>({id:r.articleId,source:r.source,published:true,receipt:r})),
  ...(state.drafts??[]).filter(d=>d.draftId&&d.status!=='published'&&!completed.has(d.source.remId)&&d.reviewMode==='automatic'&&eligible.has(d.source.remId)).map(d=>({id:d.draftId,source:d.source,published:false,draft:d}))];
 for(const item of entries){
  let title=item.source.nodes[0].text;
  try{
   if(sync.operations[item.id])throw Error('sync_pending_operation_requires_review');
   const pending=sync.revisions[item.id];
   if(['creating','writing','submitting','published'].includes(pending?.stage)){
    throw Error(pending.issue??'sync_unknown_revision_result');
   }
   let base=item.published?sync.articles[item.id]:sync.drafts[item.source.remId];
   const remote=await readOnly(()=>publisher.syncModel('read-article',{id:item.id,draft:!item.published}));
   assert.equal(remote.state,item.published?'published':'draft');assert.equal(remote.author.id,cfg.accountId);
   if(item.published&&item.receipt.columnIds)assert(matchesReceiptColumns(acceptedColumns(remote),item.receipt,cfg.columnId),'sync_revision_column_membership_changed');
   if(!base){
    // Bootstrap from the last verified workflow snapshot, never from an unchecked live source.
    const saved=item.published?item.receipt:item.draft;
    const cloud=item.published?await publisher.verify(item.id):await publisher.readDraft(item.id);
    assert.equal(cloud.title,saved.title);assert.equal(cloud.text,saved.text);assert.equal(cloud.format,saved.format);
    assert(atom(await publisher.syncModel('view',{article:remote}),saved),'sync_baseline_cloud_changed');
    base={sourceBaseline:saved.source,articleBaseline:remote,publishedSnapshot:item.published?remote:undefined};
    if(item.published)sync.articles[item.id]=base;else sync.drafts[item.source.remId]={...base,draftId:item.id};
    o.saveSync();
   }
   let baselineArticle=base.publishedSnapshot??base.articleBaseline;
   if(!baselineArticle){
    const prepared=await publisher.prepare(base.sourceBaseline.nodes,'待发布',base.seriesLabel);
    assert.equal(prepared.title,base.cloudBaseline.title);
    assert.equal(prepared.text,base.cloudBaseline.text);assert.equal(prepared.format,base.cloudBaseline.format);
    baselineArticle={id:item.id,title:prepared.title,content:prepared.html,author:{id:cfg.accountId},state:'draft'};
    base.articleBaseline=baselineArticle;o.saveSync();
   }
   let source=await readOnly(()=>snapshotArticle(reader,item.source.remId,Boolean(item.source.tagTrigger),cfg.aiGeneratedTagRemId,true));
   if(item.source.tagTrigger)source.tagTrigger=item.source.tagTrigger;
   const decision=await publisher.syncModel('reconcile',{baselineSource:base.sourceBaseline,source,baselineArticle,article:remote});
   if(decision.direction==='conflict')throw Error(decision.code);
   if(decision.direction==='none'){
    const revision=sync.revisions[item.id];if(revision&&revision.source?.fingerprint!==source.fingerprint){revision.stage='cancelled';delete revision.issue;o.saveSync();}
    report(item.id,title,'unchanged',undefined,sync.revisions[item.id]?.previewId);continue;
   }
   const meta=await publisher.syncModel('metadata',{article:item.published?baselineArticle:remote});
   if(decision.pullPlan){
    // Persist a recovery fence before RemNote writes. Unknown operations are never replayed.
    const bundle=o.bundle(item.id);
    sync.operations[item.id]={stage:'pulling',bundle,sourceBefore:source,remote,decision:decision.direction};o.saveSync();
    await o.apply(decision.pullPlan,bundle);
    const fresh=await snapshotArticle(reader,source.remId,Boolean(source.tagTrigger),cfg.aiGeneratedTagRemId,true);
    if(source.tagTrigger)fresh.tagTrigger=source.tagTrigger;
    assert(source.nodes.every(n=>fresh.nodes.some(f=>f.remId===n.remId)),'sync_original_identity_lost');
    if(decision.direction==='remote')await publisher.syncModel('verify',{source:fresh,before:source,article:remote});
    else{
     const changed=new Map(decision.pullPlan.changes.map(n=>[n.id,n]));
     for(const old of source.nodes){const actual=fresh.nodes.find(n=>n.remId===old.remId);assert(same(actual.richText,changed.get(old.remId)?.runs??old.richText),'sync_merge_readback_mismatch');assert.equal(actual.parentRemId,old.parentRemId);}
    }
    source=fresh;sync.operations[item.id].stage='pull-verified';o.saveSync();
   }
   title=source.nodes[0].text;
   if(decision.direction==='remote'||decision.direction==='converged'){
    const value={sourceId:source.remId,sourceBaseline:source,publishedSnapshot:item.published?remote:undefined,articleBaseline:remote,lastSyncAt:new Date().toISOString(),draftId:item.id};
    if(item.published){
     const cloud=await publisher.verify(item.id),captured=await publisher.syncModel('view',{article:remote});
     assert(atom(cloud,captured)&&cloud.authorId===cfg.accountId&&matchesReceiptColumns(cloud.columnIds,item.receipt,cfg.columnId),'sync_remote_changed_before_baseline');
     const currentMeta=await publisher.syncModel('metadata',{article:remote});
     const bodyView=await publisher.syncModel('view',{article:{...remote,content:currentMeta.body}});
     Object.assign(item.receipt,cloud,{html:remote.content,source,bodyText:bodyView.text,firstPublishedAt:meta.firstPublishedAt,seriesLabel:meta.seriesLabel});o.saveState();
     sync.articles[item.id]=value;if(sync.revisions[item.id])sync.revisions[item.id].stage='cancelled';
    }
    else{
     const cloud=await publisher.readDraft(item.id);
     const prepared=await publisher.prepare(source.nodes,meta.firstPublishedAt,meta.seriesLabel??undefined);
     assert(atom(cloud,prepared),'sync_remote_projection_requires_review');
     Object.assign(item.draft,prepared,{source,status:'review',reviewMode:'automatic',seriesLabel:meta.seriesLabel??undefined});
     sync.drafts[source.remId]={...value,cloudBaseline:cloud,seriesLabel:meta.seriesLabel};o.saveState();
    }
    delete sync.operations[item.id];o.saveSync();report(item.id,title,'synchronized');continue;
   }
   const bodyPrepared=await publisher.prepare(source.nodes);
   const prepared=await publisher.prepare(source.nodes,meta.firstPublishedAt,meta.seriesLabel??undefined);
   validateArticle(source,bodyPrepared,{receipts:state.receipts.filter(r=>r.source.remId!==source.remId)});
   const fresh=await snapshotArticle(reader,source.remId,Boolean(source.tagTrigger),cfg.aiGeneratedTagRemId,true);
   assert.equal(fresh.fingerprint,source.fingerprint,'sync_source_changed_during_review');
   if(!item.published){
    const cloud=await publisher.readDraft(item.id);
    const guard=await publisher.syncModel('assert-published',{before:remote,article:await publisher.syncModel('read-article',{id:item.id,draft:true})});assert(guard.unchanged);
    sync.operations[item.id]={stage:'draft-writing',source,prepared};o.saveSync();
    const saved=await publisher.writeDraft(item.id,prepared.title,prepared.html,cloud);assert(atom(saved,prepared),'sync_draft_readback_mismatch');
    Object.assign(item.draft,prepared,{source,seriesLabel:meta.seriesLabel??undefined,status:'review',reviewMode:'automatic'});o.saveState();
    const raw=await publisher.syncModel('read-article',{id:item.id,draft:true});
    sync.drafts[source.remId]={draftId:item.id,sourceBaseline:source,articleBaseline:raw,cloudBaseline:saved,seriesLabel:meta.seriesLabel};
    delete sync.operations[item.id];o.saveSync();report(item.id,title,'synchronized');
   }else{
    let revision=sync.revisions[item.id];
    if(revision&&['creating','submitting','published'].includes(revision.stage))throw Error('sync_unknown_revision_result');
    if(!revision)revision={stage:'creating',articleId:item.id};
    else if(['completed','cancelled'].includes(revision.stage))revision={stage:'preview-known',articleId:item.id,previewId:revision.previewId,preview:revision.preview};
    if(!revision.previewId){sync.revisions[item.id]=revision;o.saveSync();const created=await publisher.createDraft();revision.previewId=created.id;revision.stage='preview-known';o.saveSync();}
    const cloud=await publisher.readDraft(revision.previewId);
    assert.equal(cloud.state,'draft');assert.equal(cloud.authorId,cfg.accountId);
    if(revision.preview)assert(atom(cloud,revision.preview),'sync_revision_preview_edited');
    else assert(!cloud.title&&!cloud.text,'sync_revision_preview_not_empty');
    Object.assign(revision,{stage:'writing',source,prepared,bodyText:bodyPrepared.text,expectedPublic:remote,firstPublishedAt:meta.firstPublishedAt,seriesLabel:meta.seriesLabel,slot});o.saveSync();
    const saved=atom(cloud,prepared)?cloud:await publisher.writeDraft(revision.previewId,prepared.title,prepared.html,cloud);
    assert(atom(saved,prepared),'sync_revision_readback_mismatch');
    await publisher.syncModel('assert-published',{before:remote,article:await publisher.syncModel('read-article',{id:item.id})});
    Object.assign(revision,{stage:'approved',preview:saved,checkedAt:new Date().toISOString()});
    delete revision.issue;
    delete sync.operations[item.id];o.saveSync();report(item.id,title,'revision-approved',undefined,revision.previewId);
   }
  }catch(error){
   const code=error instanceof Error&&/^[A-Za-z_]+$/.test(error.message)?error.message:
    sync.operations[item.id]||['creating','writing'].includes(sync.revisions[item.id]?.stage)?'sync_pending_operation_requires_review':'sync_'+hookFailureCode(error);
   const revision=sync.revisions[item.id];if(revision?.stage==='approved')revision.stage='blocked';
   // A conflicted source cannot retain a prior approval for a new publication.
   if(item.draft&&item.draft.status==='ready'){item.draft.status='review';item.draft.reviewMode='automatic';}
   for(const review of state.reviews??[])if(review.sourceRemId===item.source.remId&&review.status==='approved')review.status='blocked';
   report(item.id,title,'blocked',code,revision?.previewId??(!item.published?item.id:undefined));o.saveSync();o.saveState();
  }
 }
 state.syncFeedback={updatedAt:new Date().toISOString(),phase:'sync',articles:reports,issues:reports.filter(r=>r.status==='blocked').length};
 o.saveState();return {checked:reports.length,synchronized:reports.filter(r=>r.status==='synchronized').length,revisions:reports.filter(r=>r.status==='revision-approved').length,issues:state.syncFeedback.issues};
}

export async function publishControlled(o){
 const {state,sync,publisher,cfg,slot}=o;let updated=0;const updates=[];
 sync.revisions??={};sync.updatedSlots??={};
 const primaryColumn=(revision)=>{
  const expected=acceptedColumns(revision.expectedPublic);
  if(cfg.columnId)return cfg.columnId;
  const column=revision.expectedPublic.column;
  const primary=column?.url_token||column?.id;
  if(primary&&expected.includes(String(primary)))return String(primary);
  return state.receipts.find(r=>r.articleId===revision.articleId)?.columnIds?.[0]??expected[0]??null;
 };
 const finalize=async(revision)=>{
  const expected=acceptedColumns(revision.expectedPublic);
  const primary=primaryColumn(revision);
  const verifyBody=async()=>{
   const result=await publisher.verify(revision.articleId);
   assert.equal(result.id,revision.articleId);
   assert.equal(result.authorId,cfg.accountId);
   assert(atom(result,revision.prepared),'sync_revision_public_readback_mismatch');
   assert((expected.length ? expected.includes(primary)&&result.columnIds.includes(primary) : !primary)
    &&result.columnIds.every(id=>expected.includes(id)),'sync_revision_column_membership_changed');
   return result;
  };
  let actual=await verifyBody();
  for(const targetColumn of expected.filter(id=>!actual.columnIds.includes(id))){
   revision.columnAttempts??={};
   assert(!revision.columnAttempts[targetColumn],'sync_revision_column_restore_pending');
   revision.columnAttempts[targetColumn]=new Date().toISOString();
   o.saveSync();
   await publisher.restoreRevisionColumn({articleId:revision.articleId,expectedPublic:revision.expectedPublic,
    prepared:revision.prepared,columnId:primary,targetColumn});
   actual=await verifyBody();
   assert(actual.columnIds.includes(targetColumn),'sync_revision_column_restore_pending');
  }
  const raw=await publisher.syncModel('read-article',{id:revision.articleId});
  assert(atom(await publisher.syncModel('view',{article:raw}),revision.prepared),'sync_revision_changed_before_baseline');
  assert(same(acceptedColumns(raw),expected),'sync_revision_column_membership_changed');
  assert.equal(raw.created,revision.expectedPublic.created,'sync_revision_public_timestamp_changed');
  sync.articles[revision.articleId]={sourceBaseline:revision.source,publishedSnapshot:raw,lastSyncAt:new Date().toISOString()};
  const receipt=state.receipts.find(r=>r.articleId===revision.articleId);assert(receipt);
  Object.assign(receipt,revision.prepared,{source:revision.source,bodyText:revision.bodyText,firstPublishedAt:revision.firstPublishedAt,seriesLabel:revision.seriesLabel});
  revision.stage='completed';delete revision.issue;revision.updatedAt=new Date().toISOString();o.saveSync();o.saveState();
  updates.push({id:revision.articleId,title:revision.prepared.title,url:`https://zhuanlan.zhihu.com/p/${revision.articleId}`,kind:'update'});
 };
 const feedback=()=>{
  const active=Object.values(sync.revisions).filter(r=>!['completed','cancelled'].includes(r.stage)).map(r=>({articleId:r.articleId,sourceRemId:r.source?.remId,title:r.prepared?.title??'修订稿',status:r.issue?'blocked':r.stage==='approved'?'revision-approved':r.stage,issues:r.issue?[r.issue]:[],publicationSlot:r.slot,url:`https://zhuanlan.zhihu.com/p/${r.articleId}`,editorUrl:r.previewId?`https://zhuanlan.zhihu.com/p/${r.previewId}/edit`:undefined}));
  const unresolved=(state.syncFeedback?.articles??[]).filter(r=>r.status==='blocked'&&!sync.revisions[r.articleId]);
  const articles=[...unresolved,...active];state.syncFeedback={updatedAt:new Date().toISOString(),phase:'update',articles,issues:articles.filter(r=>r.status==='blocked').length};o.saveState();
 };
 for(const r of Object.values(sync.revisions))if(['submitting','published'].includes(r.stage)){
  try{await finalize(r);}catch(error){
   r.issue=Object.keys(r.columnAttempts??{}).length?'sync_revision_column_restore_pending':error.message==='sync_revision_column_membership_changed'?'sync_revision_column_membership_changed':'sync_unknown_revision_result';o.saveSync();
  }
 }
 if(!slot){feedback();return {updated,updates};}
 if(sync.updatedSlots[slot]||Object.values(sync.revisions).some(r=>r.submittedSlot===slot)){feedback();return {updated,updates};}
 for(const revision of Object.values(sync.revisions)){
  if(revision.stage!=='approved'||revision.slot!==slot)continue;
  try{
   assert.equal(o.currentSlot(),slot,'sync_revision_window_ended');
   const frozen=await publisher.prepare(revision.source.nodes,revision.firstPublishedAt,revision.seriesLabel??undefined);
   assert(atom(frozen,revision.prepared),'sync_revision_frozen_changed');
   const preview=await publisher.readDraft(revision.previewId);assert(atom(preview,revision.preview),'sync_revision_preview_edited');
   const current=await publisher.syncModel('read-article',{id:revision.articleId});
   if(current.title_image||current.comment_permission&&current.comment_permission!=='all'||current.creation_statement)throw Error('sync_public_settings_require_review');
   await publisher.syncModel('assert-published',{before:revision.expectedPublic,article:current});
   const primary=primaryColumn(revision),expected=acceptedColumns(revision.expectedPublic);
   assert(same(acceptedColumns(current),expected)&&(expected.length ? expected.includes(primary) : !primary),'sync_revision_column_membership_changed');
   assert.equal(o.currentSlot(),slot,'sync_revision_window_ended');
   revision.stage='submitting';revision.submittedSlot=slot;sync.updatedSlots[slot]={articleId:revision.articleId,at:new Date().toISOString()};o.saveSync();
   const result=await publisher.updatePublished({articleId:revision.articleId,previewId:revision.previewId,expectedPublic:revision.expectedPublic,expectedPreview:revision.preview,title:revision.prepared.title,html:revision.prepared.html,...(cfg.columnId?{}:{columnId:primary})});
   assert.equal(result.id,revision.articleId);revision.stage='published';o.saveSync();await finalize(revision);updated++;
  }catch(error){revision.issue=Object.keys(revision.columnAttempts??{}).length?'sync_revision_column_restore_pending':revision.stage==='submitting'?'sync_unknown_revision_result':error instanceof Error&&/^sync_[a-z_]+$/.test(error.message)?error.message:'sync_revision_changed_before_update';if(revision.stage==='approved')revision.stage='blocked';o.saveSync();}
  break;
 }
 feedback();return {updated,updates};
}

export async function seedControlled(o){
 o.sync.articles??={};o.sync.drafts??={};let seeded=0;
 const values=[...o.state.receipts.filter(r=>r.articleId&&['verified','archived'].includes(r.stage)).map(r=>({saved:r,id:r.articleId,published:true})),...(o.state.drafts??[]).filter(d=>d.draftId&&d.status==='ready').map(d=>({saved:d,id:d.draftId,published:false}))];
 for(const item of values){
  const key=item.published?item.id:item.saved.source.remId,collection=item.published?o.sync.articles:o.sync.drafts;
  if(collection[key])continue;
  const actual=item.published?await o.publisher.verify(item.id):await o.publisher.readDraft(item.id);
  if(!atom(actual,item.saved))continue;
  const raw=await o.publisher.syncModel('read-article',{id:item.id,draft:!item.published});
  if(!atom(await o.publisher.syncModel('view',{article:raw}),item.saved))continue;
  collection[key]={sourceBaseline:item.saved.source,articleBaseline:raw,publishedSnapshot:item.published?raw:undefined,draftId:item.id,cloudBaseline:actual,seriesLabel:item.saved.seriesLabel};seeded++;
 }
 o.saveSync();return {seeded};
}

async function main(){
 const {ArticleRemNoteMcp,ZhihuPublisher}=await import('../dist/workflows/remnote-zhihu-cli.js');
 const {publicationSlot}=await import('../dist/workflows/remnote-zhihu.js');
 const [action,configFile,parentPid,slot]=process.argv.slice(2);assert(['audit','publish','seed'].includes(action)&&path.isAbsolute(configFile));
 const home=path.dirname(configFile),read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
 assert.equal(read(path.join(home,'run.lock')).pid,Number(parentPid));process.kill(Number(parentPid),0);
 const cfg=read(configFile),stateFile=path.join(home,'state.json'),syncFile=path.join(home,'sync-state.json');
 const state=read(stateFile),sync=fs.existsSync(syncFile)?read(syncFile):{version:2,articles:{},drafts:{}};sync.version=2;
 const atomic=(file,value)=>{const temp=file+`.${process.pid}.tmp`;const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);};
 const publisher=new ZhihuPublisher(cfg),reader=new ArticleRemNoteMcp();
 const options={cfg,state,sync,publisher,reader,slot,saveState:()=>atomic(stateFile,state),saveSync:()=>atomic(syncFile,sync),
  currentSlot:()=>publicationSlot(new Date()),
  bundle:id=>{const dir=path.join(home,'sync-runs',`${Date.now()}-${id}`);fs.mkdirSync(dir,{recursive:true});return dir;},
  apply:async(plan,bundle)=>{atomic(path.join(bundle,'pull-plan.json'),[plan]);const {applySyncPlan}=await import('./zhihu_sync_apply.mjs');try{await applySyncPlan(configFile,bundle,Number(parentPid),()=>{});}catch{throw Error('sync_native_write_requires_review');}}
 };
 try{if(action==='audit')await reader.connect(cfg.mcpUrl,cfg.knowledgeBaseId);const result=action==='audit'?await auditControlled(options):action==='publish'?await publishControlled(options):await seedControlled(options);console.log(JSON.stringify(result));}
 finally{await reader.close();}
}
export function hookFailureCode(error){
 const message=error instanceof Error?error.message:'';
 if(/knowledge base/i.test(message))return 'remnote_knowledge_base_changed';
 if(/RemNote|MCP|remnote_/i.test(message))return /timeout|timed out/i.test(message)?'remnote_timeout':'remnote_unavailable';
 if(/^Zhihu client failed: (?:LoginError|cookie_snapshot_stale|zhihu_account_changed|account_changed)$/i.test(message))return 'zhihu_login_required';
 if(/^Zhihu client (?:failed: (?:HTTPError|ConnectionError|Timeout|ReadTimeout)|timed out)/i.test(message))return 'zhihu_read_failed';
 if(/^sync_[a-z_]{1,80}$/.test(message))return message;
 return 'hook_failed';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error('controlled_sync_failed:'+hookFailureCode(error));process.exitCode=1;});
