import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {ArticleRemNoteMcp} from '../dist/workflows/remnote-zhihu-cli.js';
import {snapshotArticle} from '../dist/workflows/remnote-zhihu.js';
export async function applySyncPlan(configFile,bundle,parentLock,emit=console.log){
assert(configFile&&bundle&&path.isAbsolute(configFile)&&path.isAbsolute(bundle),'Absolute config and bundle paths are required');
const dir=pathToFileURL(path.resolve(bundle)+path.sep);
const read=name=>JSON.parse(fs.readFileSync(new URL(name,dir),'utf8'));
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const plans=read('pull-plan.json');
const journalFile=new URL('pull-journal.json',dir);
let journal=fs.existsSync(journalFile)?read('pull-journal.json'):{nodes:{},updates:{},moves:{}};
function save(){const file=fs.openSync(journalFile,'w',0o600);try{fs.writeFileSync(file,JSON.stringify(journal,null,2));fs.fsyncSync(file);}finally{fs.closeSync(file);}}
function assertRuns(runs){
 assert(Array.isArray(runs)&&runs.length<=1000);
 for(const run of runs){
  if('text' in run){assert(Object.keys(run).every(k=>['text','bold','italic','code'].includes(k)),'Unsupported native write mark');assert.equal(typeof run.text,'string');}
  else if(run.type==='link'){assertRuns(run.children);const u=new URL(run.url);assert(['https:','http:','mailto:'].includes(u.protocol)&&!u.username&&!u.password);}
  else{assert.equal(run.type,'math');assert.equal(typeof run.tex,'string');assert.equal(typeof run.display,'boolean');}
 }
}
for(const p of plans){assert.equal(p.deletedIds,0);for(const row of p.changes)if(!row.oldId||row.contentChanged)assertRuns(row.runs);}
class SyncReader extends ArticleRemNoteMcp{invoke(name,args){return this.call(name,args);}}
const m=new SyncReader();
const lock=path.join(path.dirname(configFile),'run.lock');
if(parentLock){assert(Number.isSafeInteger(parentLock)&&parentLock>0);assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).pid,parentLock);process.kill(parentLock,0);}
else{const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,operation:'zhihu-pull-sync'}));fs.fsyncSync(fd);fs.closeSync(fd);}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
try{
 await m.connect(config.mcpUrl,config.knowledgeBaseId);
 if(!Object.keys(journal.nodes).length&&!Object.keys(journal.updates).length&&!Object.keys(journal.moves).length){
  for(const p of plans){
   const fresh=await snapshotArticle(m,p.sourceId,Boolean(p.tagTrigger),config.aiGeneratedTagRemId,true);
   assert.equal(fresh.fingerprint,p.fingerprint,'Local source changed since plan');
  }
 }
 // Validate every existing changed atom before the first mutation.
 for(const p of plans)for(const row of p.changes)if(row.oldId){
  const actual=await m.invoke('personalwebsite_richtext',{remId:row.oldId,preserveReferences:true});
  const done=journal.updates[row.oldId];
  assert(equal(actual.content,done?row.runs:row.oldContent),'Local atom changed since plan');
  assert(actual.parentRemId===(journal.moves[row.oldId]?.parentId??row.oldParentId),'Local parent changed since plan');
 }
 for(const p of plans){
  const resolve=id=>id.startsWith('new:')?journal.nodes[p.articleId+':'+id]?.id:id;
  for(const row of p.changes){
   const parentId=resolve(row.parentId);assert(parentId,'New parent is not known yet');
   let id=resolve(row.id);
   if(!row.oldId){
    const key=p.articleId+':'+row.id;
    let item=journal.nodes[key];
    if(!item){item={parentId,marker:'知乎同步暂存-'+crypto.randomUUID(),stage:'creating'};journal.nodes[key]=item;save();
      const created=await m.invoke('remnote_create_note',{parentId,title:item.marker,...(row.aiPrefix?{tagRemIds:[config.aiGeneratedTagRemId]}:{})});
      assert.equal(created.remIds.length,1);item.id=created.remIds[0];item.stage='created';save();
    }
    assert(item.id,'Unknown creation result; inspect owned marker, never create again');id=item.id;
    let current=await m.invoke('personalwebsite_richtext',{remId:id,preserveReferences:true});
    if(!equal(current.content,row.runs)){
      assert.equal(item.stage,'created','Unknown write result; inspect before retry');
      assert(equal(current.content,[{text:item.marker}])&&current.parentRemId===parentId);
      item.stage='writing';save();
      await m.invoke('personalwebsite_richtext',{remId:id,content:row.runs,expectedContent:current.content,expectedParentRemId:parentId,preserveReferences:true,expectedReferenceIds:[]});
      current=await m.invoke('personalwebsite_richtext',{remId:id,preserveReferences:true});assert(equal(current.content,row.runs));item.stage='written';save();
    }
   }else if(row.contentChanged&&!journal.updates[id]){
    const current=await m.invoke('personalwebsite_richtext',{remId:id,preserveReferences:true});
    assert(equal(current.content,row.oldContent));assert.equal(current.parentRemId,row.oldParentId);
    journal.updates[id]={stage:'writing',before:current.content};save();
    await m.invoke('personalwebsite_richtext',{remId:id,content:row.runs,expectedContent:current.content,expectedParentRemId:current.parentRemId,preserveReferences:true,expectedReferenceIds:current.referenceIds});
    const saved=await m.invoke('personalwebsite_richtext',{remId:id,preserveReferences:true});assert(equal(saved.content,row.runs));journal.updates[id].stage='verified';save();
   }
   if((!row.oldId||row.parentChanged)&&!journal.moves[id]){
    const siblings=p.nodes.filter(n=>n.parentId===row.parentId);const index=siblings.findIndex(n=>n.id===row.id);
    let anchor;for(let j=index-1;j>=0;j--){const found=resolve(siblings[j].id);if(found){const note=await m.read(found);if(note.parentRemId===parentId){anchor=found;break;}}}
    let next;
    if(!anchor&&!row.oldId){
      // A new parent precedes the existing children it adopts, including intervening blank siblings.
      const adopted=p.nodes.filter(n=>n.parentId===row.id&&n.oldId);
      for(const child of adopted){const note=await m.read(child.oldId);if(note.parentRemId===parentId){next=child.oldId;break;}}
    }
    if(!anchor&&!next)for(let j=index+1;j<siblings.length;j++){const found=resolve(siblings[j].id);if(found){const note=await m.read(found);if(note.parentRemId===parentId){next=found;break;}}}
    const current=await m.read(id);
    journal.moves[id]={stage:'moving',parentId,beforeParentId:current.parentRemId,position:anchor?'after':next?'before':'first',anchor:anchor??next};save();
    await m.invoke('remnote_move_note',{remId:id,newParentRemId:parentId,expectedOldParentRemId:current.parentRemId,position:anchor?'after':next?'before':'first',...(anchor||next?{siblingRemId:anchor??next}:{}),dryRun:false});
    const moved=await m.read(id);assert.equal(moved.parentRemId,parentId);journal.moves[id].stage='verified';save();
   }
   emit(JSON.stringify({articleId:p.articleId,remId:id,new:!row.oldId,contentChanged:row.contentChanged,moved:!row.oldId||row.parentChanged}));
  }
  journal.blankMoves??={};
  for(const intent of p.blankIntents??[]){
   const beforeId=resolve(intent.beforeId),parentId=resolve(intent.parentId);let children=[],cursor;
   do{const page=await m.children(parentId,cursor);children.push(...page.children);cursor=page.hasMore?page.nextCursor:undefined;assert(!page.hasMore||cursor);}while(cursor);
   const at=children.findIndex(c=>c.remId===beforeId),gapAt=children.findIndex(c=>c.remId===intent.id);
   assert(at>=0&&gapAt>=0,'Blank anchor moved outside source');
   if(gapAt!==at-1){
    // SDK same-parent forward insertion can be a no-op; cross-parent moves have stable indexes.
    const rootNote=await m.read(p.sourceId);const stagingParent=parentId===p.sourceId?rootNote.parentRemId:p.sourceId;
    assert(stagingParent&&stagingParent!==parentId);
    journal.blankMoves[intent.id]={stage:'moving-out',parentId,beforeId,stagingParent};save();
    await m.invoke('remnote_move_note',{remId:intent.id,newParentRemId:stagingParent,expectedOldParentRemId:parentId,position:'last',dryRun:false});
    journal.blankMoves[intent.id].stage='moving-back';save();
    await m.invoke('remnote_move_note',{remId:intent.id,newParentRemId:parentId,expectedOldParentRemId:stagingParent,position:'before',siblingRemId:beforeId,dryRun:false});
    const check=await m.children(parentId);const savedAt=check.children.findIndex(n=>n.remId===intent.id),targetAt=check.children.findIndex(n=>n.remId===beforeId);
    assert(!check.hasMore&&savedAt===targetAt-1,'Blank move did not achieve requested order');
    journal.blankMoves[intent.id].stage='verified';save();
   }
  }
 }
 journal.completedAt=new Date().toISOString();save();
 emit(JSON.stringify({status:'pull-applied',created:Object.keys(journal.nodes).length,updated:Object.keys(journal.updates).length,movedExisting:plans.flatMap(p=>p.changes).filter(r=>r.oldId&&r.parentChanged).length,deleted:0}));
}finally{await m.close();if(!parentLock)fs.unlinkSync(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 await applySyncPlan(process.argv[2],process.argv[3],process.argv[4]==='--parent-lock'?Number(process.argv[5]):undefined);
