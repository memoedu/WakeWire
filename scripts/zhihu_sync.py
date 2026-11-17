"""JSON-only directional synchronization helpers; credentials never leave the local client."""
import importlib.util,json,re,sys
from pathlib import Path
from zhihu_sync_model import plan_article
from zhihu_article_format import normalize,format_structure

spec=importlib.util.spec_from_file_location('sync_adapter',Path(__file__).with_name('zhihu-client.py'))
adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
FOOTER=re.compile(r'(<p(?:\s[^>]*)?>\s*<br\s*/?>\s*</p>)(<p(?:\s[^>]*)?>第\d+\s*篇\s*\|\s*day\s*\d+</p>)?<p(?:\s[^>]*)?>首次发布时间：\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}</p>\s*$')

def body(article):
    match=FOOTER.search(article['content'])
    if not match:raise ValueError('sync_publication_footer_unrecognized')
    return article['content'][:match.start()],article['content'][match.start():]

def article_plan(source,article):
    html,footer=body(article)
    plan=plan_article(source,html)
    root=source['nodes'][0]
    title=article['title']
    if not title or '\n' in title or '\ufffd' in title:raise ValueError('sync_remote_title_invalid')
    if title!=root['text']:
        plan['changes'].insert(0,{'id':root['remId'],'oldId':root['remId'],'parentId':root['parentRemId'],'oldParentId':root['parentRemId'],
            'runs':[{'text':title}],'oldContent':root['richText'],'contentChanged':True,'parentChanged':False})
    return {**plan,'tagTrigger':source.get('tagTrigger',False),'articleId':str(article['id']),'publicationFooter':footer}

def main(request):
    action=request['action']
    if action=='assert-published':
        before,article=request['before'],request['article']
        if not article or before['title']!=article['title'] or normalize(before['content'])!=normalize(article['content']) or format_structure(before['content'])!=format_structure(article['content']):
            raise ValueError('sync_published_changed_during_planning')
        return {'unchanged':True}
    if action=='plan':
        source,baseline=request['source'],request['baseline']
        old={n['remId']:n for n in baseline['nodes']}
        if source['fingerprint']!=baseline['fingerprint'] or [n['remId'] for n in source['nodes']]!=[n['remId'] for n in baseline['nodes']] or len(source['nodes'])!=len(old) or any(n['remId'] not in old or n['text']!=old[n['remId']]['text'] or
            n.get('richText')!=old[n['remId']].get('richText') or n.get('inlineRefs',[])!=old[n['remId']].get('inlineRefs',[]) or
            (n['depth'] and n['parentRemId']!=old[n['remId']]['parentRemId']) for n in source['nodes']):
            raise ValueError('sync_local_changes_require_reconciliation')
        return article_plan(source,request['article'])
    if action=='verify':
        source,before=request['source'],request['before']
        if not {n['remId'] for n in before['nodes']}.issubset(n['remId'] for n in source['nodes']):
            raise ValueError('sync_original_identity_lost')
        plan=article_plan(source,request['article'])
        if plan['changes']:raise ValueError('sync_readback_content_or_hierarchy_mismatch')
        for gap in plan['blankIntents']:
            siblings=[n['remId'] for n in source['nodes'] if n.get('parentRemId')==gap['parentId']]
            if siblings.index(gap['id'])!=siblings.index(gap['beforeId'])-1:raise ValueError('sync_readback_blank_position_mismatch')
        return {'verified':True,'nodes':len(source['nodes']),'visibleNodes':len(plan['nodes']),'publicationFooter':plan['publicationFooter'],'retainedOriginalNodes':len(before['nodes'])}
    cfg=json.loads(Path(request['configFile']).read_text(encoding='utf-8-sig'))
    with adapter.load_client(cfg['cookieSnapshot']) as client:
        if client.get_self_info()['id']!=cfg['accountId']:raise ValueError('sync_account_changed')
        if action=='read-published':
            ids=request['ids']
            if not ids or len(ids)>100 or len(set(ids))!=len(ids):raise ValueError('sync_invalid_article_scope')
            result=[]
            for article_id in ids:
                if not re.fullmatch(r'\d+',article_id):raise ValueError('sync_invalid_article_id')
                article=client._get(f'https://zhuanlan.zhihu.com/api/articles/{article_id}')
                if str(article.get('id'))!=article_id or article.get('author',{}).get('id')!=cfg['accountId'] or article.get('state')!='published' or article.get('content_need_truncated'):
                    raise ValueError('sync_published_identity_or_content_changed')
                result.append(article)
            return result
        if action=='read-draft':
            article_id=request['id']
            if not re.fullmatch(r'\d+',article_id):raise ValueError('sync_invalid_draft_id')
            article=client._get(f'https://zhuanlan.zhihu.com/api/articles/{article_id}/draft')
            if str(article.get('id'))!=article_id or article.get('author',{}).get('id')!=cfg['accountId'] or article.get('state')!='draft':raise ValueError('sync_draft_identity_changed')
            return article
    raise ValueError('sync_unknown_action')

if __name__=='__main__':
    try:print(json.dumps({'ok':True,'data':main(json.load(sys.stdin))},ensure_ascii=True))
    except Exception as error:
        message=str(error) if isinstance(error,ValueError) and re.fullmatch('[A-Za-z_]+',str(error)) else type(error).__name__
        print(json.dumps({'ok':False,'error':message}));sys.exit(1)
