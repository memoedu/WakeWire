import {describe,it,expect} from 'vitest';
import {auditControlled,publishControlled,seedControlled,hookFailureCode} from './zhihu-controlled-sync.mjs';
import * as runtime from '../src/workflows/remnote-zhihu.ts';
import {articleFeedback} from '../src/workflows/remnote-zhihu-review.ts';
const {snapshotArticle}=runtime;

async function fixture(){
 const clone=v=>structuredClone(v),slot='2026-01-03T17:30+08:00';
 const nodes=new Map([
  ['doc',{remId:'doc',title:'Publication Document',remType:'document'}],
  ['done',{remId:'done',title:'已发布',parentRemId:'doc'}],
  ['root',{remId:'root',title:'Original title',parentRemId:'done'}],
  ['body',{remId:'body',title:'Original independently checked body.',parentRemId:'root'}]
 ]);
 const reader={read:async id=>clone(nodes.get(id)),richText:async id=>[{text:nodes.get(id).title}],children:async id=>({children:[...nodes.values()].filter(n=>n.parentRemId===id).map(clone),hasMore:false})};
 const baseline=await snapshotArticle(reader,'root');
 const preparedByHtml=new Map(),drafts=new Map(),calls={create:0,write:0,update:0,apply:0,savedSync:[]};
 const prepare=async(ns,stamp,series)=>{const text=ns.slice(1).map(n=>n.text).join('|')+(stamp?`|${series}|${stamp}`:'');const result={title:ns[0].text,text,html:`<p>${text}</p>`,format:JSON.stringify({text}),tableOfContents:false};preparedByHtml.set(result.html,result);return clone(result);};
 let publicCloud=await prepare(baseline.nodes,'2026.01.02 12:00','第3 篇 | day 2');
 const remote={id:'123',title:publicCloud.title,content:publicCloud.html,state:'published',author:{id:'owner'}};
 const state={receipts:[{source:baseline,articleId:'123',title:publicCloud.title,text:publicCloud.text,format:publicCloud.format,tableOfContents:false,stage:'archived',slot:'initial',columnId:'col'}]};
 const sync={articles:{'123':{sourceBaseline:clone(baseline),publishedSnapshot:clone(remote)}},drafts:{}};
 const publisher={prepare,
  syncModel:async(action,args)=>{
   if(action==='read-article')return clone(remote);
   if(action==='view')return {...clone(preparedByHtml.get(args.article.content)??publicCloud),id:args.article.id,state:args.article.state,authorId:'owner'};
   if(action==='reconcile')return clone(o.decision);
   if(action==='metadata')return {firstPublishedAt:'2026.01.02 12:00',seriesLabel:'第3 篇 | day 2'};
   if(action==='assert-published'){if(args.before.content!==args.article.content)throw Error('sync_published_changed_during_planning');return {unchanged:true};}
   if(action==='verify')return {verified:true};
   throw Error(action);
  },
  createDraft:async()=>{expect(Object.values(sync.revisions).some(r=>r.stage==='creating')).toBe(true);calls.create++;const id=String(900+calls.create);drafts.set(id,{id,title:'',text:'',format:'empty',tableOfContents:false,authorId:'owner',state:'draft',editorUrl:`https://example.org/${id}`});return {id};},
  readDraft:async id=>clone(drafts.get(id)),
  writeDraft:async(id,title,html,expected)=>{calls.write++;expect(drafts.get(id)).toEqual(expected);const p=preparedByHtml.get(html);const saved={...p,id,authorId:'owner',state:'draft',editorUrl:`https://example.org/${id}`};drafts.set(id,saved);return clone(saved);},
  updatePublished:async args=>{expect(sync.revisions['123'].stage).toBe('submitting');expect(args.articleId).toBe('123');calls.update++;publicCloud=clone(preparedByHtml.get(args.html));remote.title=args.title;remote.content=args.html;return {id:'123'};},
  verify:async id=>({...clone(publicCloud),id,authorId:'owner',columnIds:['col'],url:`https://zhuanlan.zhihu.com/p/${id}`})
 };
 const o={runtime,state,sync,reader,publisher,slot,cfg:{documentRemId:'doc',accountId:'owner',columnId:'col'},decision:{direction:'local'},
  saveSync:()=>calls.savedSync.push(clone(sync)),saveState:()=>{},currentSlot:()=>slot,bundle:id=>`isolated-${id}`,apply:async()=>{calls.apply++;throw Error('sync_native_write_requires_review');},nodes,calls,drafts,remote};
 nodes.get('body').title='A revised independently checked body.';
 return o;
}

describe('controlled article sync ownership and recovery',()=>{
 it('classifies a failed RemNote hook without exposing an upstream response or credential',()=>{
  expect(hookFailureCode(Error('remnote_read_note: MCP request timed out'))).toBe('remnote_timeout');
  expect(hookFailureCode(Error('RemNote knowledge base changed'))).toBe('remnote_knowledge_base_changed');
  expect(hookFailureCode(Error('HTTP response body credential-value'))).toBe('hook_failed');
  expect(hookFailureCode(Error('some_private_value'))).toBe('hook_failed');
 });
 it('does not scan a stale ready record again after its source already has a publication receipt',async()=>{
  const o=await fixture();o.nodes.get('root').parentRemId='doc';o.nodes.get('root').title='%Original title';
  o.state.drafts=[{source:o.state.receipts[0].source,draftId:'123',status:'ready',reviewMode:'automatic'}];
  const result=await auditControlled(o);expect(result.checked).toBe(1);expect(result.issues).toBe(0);
 });
 it('keeps an external source tag route in the frozen revision snapshot',async()=>{
  const o=await fixture();const route={triggerTagRemId:'doc',publishedTagRemId:'done'};o.state.receipts[0].source.tagTrigger=route;
  await auditControlled(o);expect(o.sync.revisions['123'].source.tagTrigger).toEqual(route);
 });
 it('stages a revision under a separate preview identity and reuses it on another audit',async()=>{
  const o=await fixture();await auditControlled(o);const r=o.sync.revisions['123'];
  expect(r.stage).toBe('approved');expect(r.previewId).not.toBe('123');expect(r.firstPublishedAt).toBe('2026.01.02 12:00');expect(r.seriesLabel).toBe('第3 篇 | day 2');
  expect(o.calls.update).toBe(0);expect(o.sync.articles['123'].sourceBaseline.fingerprint).not.toBe(r.source.fingerprint);
  await auditControlled(o);expect(o.calls.create).toBe(1);expect(o.calls.write).toBe(1);
 });
 it('updates the original article only in its approved slot without a RemNote reader',async()=>{
  const o=await fixture();await auditControlled(o);
  o.reader=new Proxy({},{get:()=>{throw Error('RemNote must not be used during publication');}});
  expect((await publishControlled(o)).updated).toBe(1);expect(o.calls.update).toBe(1);
  expect(o.sync.revisions['123'].stage).toBe('completed');expect(o.state.receipts[0].articleId).toBe('123');expect(o.state.receipts[0].slot).toBe('initial');
  expect(o.sync.articles['123'].sourceBaseline.fingerprint).toBe(o.sync.revisions['123'].source.fingerprint);
  expect((await publishControlled(o)).updated).toBe(0);expect(o.calls.update).toBe(1);
 });
 it('does not repeat an unknown publication result even at a later slot',async()=>{
  const o=await fixture();await auditControlled(o);o.publisher.updatePublished=async()=>{o.calls.update++;throw Error('timeout');};
  await publishControlled(o);expect(o.sync.revisions['123'].stage).toBe('submitting');expect(o.state.syncFeedback.issues).toBe(1);
  await publishControlled(o);o.slot='2026-01-03T22:30+08:00';await publishControlled(o);expect(o.calls.update).toBe(1);
 });
 it('adopts a verified successful timeout result without resubmitting and clears its issue',async()=>{
  const o=await fixture();await auditControlled(o);const real=o.publisher.updatePublished;
  o.publisher.updatePublished=async args=>{await real(args);throw Error('timeout after successful submission');};
  await publishControlled(o);expect(o.sync.revisions['123'].stage).toBe('submitting');
  await publishControlled(o);expect(o.calls.update).toBe(1);expect(o.sync.revisions['123'].stage).toBe('completed');expect(o.state.syncFeedback.issues).toBe(0);
 });
 it('keeps an author-edited preview and blocks the revision',async()=>{
  const o=await fixture();await auditControlled(o);o.drafts.get(o.sync.revisions['123'].previewId).text='An author edited this preview.';
  await publishControlled(o);expect(o.calls.update).toBe(0);expect(o.sync.revisions['123'].stage).toBe('blocked');expect(o.state.syncFeedback.issues).toBe(1);
 });
 it('does not update outside the reviewed slot or after a frozen-renderer mismatch',async()=>{
  const o=await fixture();await auditControlled(o);o.slot='2026-01-03T22:30+08:00';await publishControlled(o);expect(o.calls.update).toBe(0);
  o.slot=o.sync.revisions['123'].slot;o.publisher.prepare=async()=>({title:'changed',text:'changed',format:'changed',tableOfContents:false});
  await publishControlled(o);expect(o.calls.update).toBe(0);expect(o.state.syncFeedback.issues).toBe(1);
 });
 it('retains both ends on same-node conflicts without creating a preview',async()=>{
  const o=await fixture();o.decision={direction:'conflict',code:'sync_same_node_conflict',nodeIds:['body']};
  await auditControlled(o);expect(o.calls.create).toBe(0);expect(o.calls.apply).toBe(0);expect(o.state.syncFeedback.articles[0].issues).toEqual(['sync_same_node_conflict']);
  await publishControlled(o);expect(o.state.syncFeedback.issues).toBe(1);
 });
 it('fences native writes before execution and never silently retries a partial operation',async()=>{
  const o=await fixture();o.decision={direction:'remote',pullPlan:{changes:[]}};
  await auditControlled(o);expect(o.sync.operations['123'].stage).toBe('pulling');expect(o.calls.apply).toBe(1);
  await auditControlled(o);expect(o.calls.apply).toBe(1);expect(o.state.syncFeedback.articles[0].issues).toEqual(['sync_pending_operation_requires_review']);
 });
 it('cancels an obsolete staged revision when the local change is withdrawn before review',async()=>{
  const o=await fixture();await auditControlled(o);o.decision={direction:'none'};o.nodes.get('body').title='Original independently checked body.';
  await auditControlled(o);expect(o.sync.revisions['123'].stage).toBe('cancelled');await publishControlled(o);expect(o.calls.update).toBe(0);
 });
 it('does not bootstrap a common baseline from a cloud draft with unchecked author edits',async()=>{
  const o=await fixture();await auditControlled(o);const r=o.sync.revisions['123'],d=o.drafts.get(r.previewId);
  o.state.receipts=[];o.state.drafts=[{...r.prepared,draftId:r.previewId,status:'ready',source:r.source}];d.text='Unchecked edit';
  expect((await seedControlled(o)).seeded).toBe(0);expect(Object.keys(o.sync.drafts)).toHaveLength(0);
 });
 it('keeps an outstanding source archive separate from a verified public revision',async()=>{
  const o=await fixture();o.state.receipts[0].stage='verified';await auditControlled(o);await publishControlled(o);
  expect(o.calls.update).toBe(1);expect(o.state.receipts[0].stage).toBe('verified');
 });
 it('consumes the update slot durably even if a later audit replaces the revision record',async()=>{
  const o=await fixture();await auditControlled(o);await publishControlled(o);
  o.nodes.get('body').title='A further independently checked revision.';await auditControlled(o);await publishControlled(o);
  expect(o.calls.create).toBe(1);expect(o.calls.update).toBe(1);expect(o.sync.updatedSlots[o.slot].articleId).toBe('123');
 });
 it('verifies the remote atom while retaining a different local edit in the merged preview',async()=>{
  const o=await fixture();o.nodes.get('root').title='A local title edit';o.nodes.get('body').title='Original independently checked body.';
  const runs=[{text:'A remote independently checked body.'}];o.decision={direction:'merged',pullPlan:{changes:[{id:'body',runs}]}};
  o.apply=async()=>{o.calls.apply++;o.nodes.get('body').title=runs[0].text;};
  await auditControlled(o);const revision=o.sync.revisions['123'];
  expect(revision.stage).toBe('approved');expect(revision.prepared.title).toBe('A local title edit');expect(revision.prepared.text).toContain(runs[0].text);
  expect(o.sync.operations['123']).toBeUndefined();expect(o.calls.update).toBe(0);
 });
 it('blocks only the conflicting article while staging another mapped revision',async()=>{
  const o=await fixture();o.nodes.set('root2',{remId:'root2',title:'Second article',parentRemId:'done'});o.nodes.set('body2',{remId:'body2',title:'Another independently checked body.',parentRemId:'root2'});
  const baseline=await snapshotArticle(o.reader,'root2');const prepared=await o.publisher.prepare(baseline.nodes,'2026.01.02 12:00','第4 篇 | day 2');
  const remote={...o.remote,id:'456',title:prepared.title,content:prepared.html};
  o.state.receipts.push({...o.state.receipts[0],articleId:'456',source:baseline,...prepared});o.sync.articles['456']={sourceBaseline:baseline,publishedSnapshot:remote};o.nodes.get('body2').title='Another revised independently checked body.';
  const original=o.publisher.syncModel;o.publisher.syncModel=async(action,args)=>{
   if(action==='read-article'&&args.id==='456')return structuredClone(remote);
   if(action==='reconcile'&&args.source.remId==='root')return {direction:'conflict',code:'sync_same_node_conflict'};
   return original(action,args);
  };
  const result=await auditControlled(o);expect(result.issues).toBe(1);expect(o.sync.revisions['123']).toBeUndefined();expect(o.sync.revisions['456'].stage).toBe('approved');
 });
 it('returns a single human-readable conflict through the existing feedback shape',()=>{
  const state={receipts:[],reviews:[{sourceRemId:'r',title:'Title',slot:'2026-01-03T17:30+08:00',checkedAt:'2026-01-03T07:30:00Z',status:'blocked',issues:['duplicate report']}],syncFeedback:{updatedAt:'2026-01-03T07:30:00Z',articles:[{articleId:'123',sourceRemId:'r',title:'Title',status:'blocked',issues:['sync_same_node_conflict']}],issues:1}};
  const feedback=articleFeedback(state,new Date('2026-01-03T07:30:00Z'),'audit');expect(feedback.issues).toBe(1);expect(feedback.articles).toHaveLength(1);expect(feedback.articles[0].issues[0]).toContain('同一个节点');
 });
});
