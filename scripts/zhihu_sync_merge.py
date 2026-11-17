"""Three-way article reconciliation. Node identity is authoritative; no semantic rewriting."""
from zhihu_sync_model import signature,rows_from_html
from zhihu_article_format import normalize,format_structure,prepare as prepare_layout

def atom(node,root=False,ai_tag=None):
    return {'text':node['text'],'runs':None if root else node.get('richText'),
            'refs':node.get('inlineRefs',[]),'ai':any(t['tagRemId']==ai_tag for t in node.get('tags',[])) if ai_tag else False}

def reconcile(request,project,body):
    base,local,remote=request['baselineSource'],request['source'],request['article']
    before=request['baselineArticle']
    baseline={n['remId']:n for n in base['nodes']};actual={n['remId']:n for n in local['nodes']}
    def conflict(code,ids=None):return {'direction':'conflict','code':code,'nodeIds':ids or []}
    missing=sorted(set(baseline)-set(actual))
    if missing:return conflict('sync_source_deletion_requires_review',missing)
    changed={rid for rid,n in actual.items() if rid not in baseline or atom(n,rid==local['remId'],local.get('aiGeneratedTagRemId'))!=atom(baseline[rid],rid==base['remId'],base.get('aiGeneratedTagRemId'))}
    shape=lambda source:[(n['remId'],n.get('parentRemId') if n['depth'] else None,n['depth']) for n in source['nodes']]
    local_changed=bool(changed) or shape(base)!=shape(local)
    old_html,_=body(before);html,_=body(remote)
    remote_changed=before['title']!=remote['title'] or normalize(old_html)!=normalize(html) or format_structure(old_html)!=format_structure(html)
    if not remote_changed:return {'direction':'local' if local_changed else 'none','changedNodeIds':sorted(changed)}
    try:remote_plan=project(base,remote)
    except ValueError as error:return conflict(str(error))
    _,old_gaps=rows_from_html(old_html)
    if not remote_plan['changes'] and old_gaps!=remote_plan['remoteGaps']:
        return conflict('sync_blank_structure_requires_review')
    if not local_changed:
        plan=project(local,remote)
        return {'direction':'remote','pullPlan':plan,'changedNodeIds':[n['id'] for n in plan['changes']]}
    if any(not row['oldId'] or row['parentChanged'] for row in remote_plan['changes']):
        return conflict('sync_concurrent_structure_requires_review',[n['id'] for n in remote_plan['changes']])
    if old_gaps!=remote_plan['remoteGaps']:return conflict('sync_concurrent_blank_structure_requires_review')
    updates=[];conflicts=[]
    for row in remote_plan['changes']:
        rid=row['id'];node=actual.get(rid)
        if not node:return conflict('sync_missing_merge_identity',[rid])
        same=(remote['title']==node['text']) if rid==local['remId'] else signature(row['runs'])==signature(node['richText'])
        if same:continue
        if rid in changed:conflicts.append(rid);continue
        updates.append({**row,'oldContent':node['richText'],'oldParentId':node['parentRemId'],
                        'parentId':node['parentRemId'],'parentChanged':False})
    if conflicts:return conflict('sync_same_node_conflict',conflicts)
    if not updates:
        # Both ends may have converged, or only local edits remain to push.
        try:
            current_plan=project(local,remote)
            _,local_gaps=rows_from_html(prepare_layout(local['nodes'],ai_generated_tag_rem_id=local.get('aiGeneratedTagRemId'))['html'])
            ai_changed=any(atom(n,rid==local['remId'],local.get('aiGeneratedTagRemId'))['ai']!=atom(baseline[rid],rid==base['remId'],base.get('aiGeneratedTagRemId'))['ai'] for rid,n in actual.items() if rid in baseline)
            equal=not current_plan['changes'] and local_gaps==current_plan['remoteGaps'] and not ai_changed
        except ValueError:equal=False
        return {'direction':'converged' if equal else 'local','changedNodeIds':sorted(changed)}
    plan={**remote_plan,'fingerprint':local['fingerprint'],'sourceId':local['remId'],
          'tagTrigger':local.get('tagTrigger',False),'changes':updates,'blankIntents':[],
          'nodes':[{'id':n['remId'],'oldId':n['remId'],'parentId':n['parentRemId']} for n in local['nodes'][1:] if n['text'].strip()]}
    return {'direction':'merged','pullPlan':plan,'changedNodeIds':sorted(changed|{n['id'] for n in updates})}
