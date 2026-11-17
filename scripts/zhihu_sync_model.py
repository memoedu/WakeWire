"""Conservative article-to-outline model: stable existing identities, additive changes only."""
import json,re,difflib
from collections import Counter
from html import unescape
from html.parser import HTMLParser
from zhihu_outline_overflow import OutlineTree,Element,serialize
from zhihu_article_format import equation,canonical_cards,canonical_link,native_html,normalize,format_structure

AI_TEX=r'\color{#7040a0}{\text{AI}}'
class Attrs(HTMLParser):
    def handle_starttag(self,tag,attrs):self.attrs=dict(attrs)
    handle_startendtag=handle_starttag
def attrs(n):
    p=Attrs();p.feed(n.start);return p.attrs
def merge_runs(runs):
    result=[]
    for run in runs:
        if 'text' in run and not run['text']:continue
        if result and 'text' in run and 'text' in result[-1] and {k:v for k,v in run.items() if k!='text'}=={k:v for k,v in result[-1].items() if k!='text'}:
            result[-1]['text']+=run['text']
        else:result.append(run)
    return result
def inline(parts,marks=None):
    marks=marks or {};result=[]
    for part in parts:
        if isinstance(part,str):result.append({'text':unescape(part),**marks});continue
        at=attrs(part);tag=part.tag
        if tag in ('ul','ol'):continue
        if tag=='br':result.append({'text':'\n',**marks});continue
        formula=equation(tag,list(at.items()))
        if formula:
            result.append({'type':'math','tex':formula[1],'display':formula[0]=='2'});continue
        if tag=='img':raise ValueError('sync_media_requires_explicit_support')
        if tag=='a':
            children=inline(part.children,marks)
            if any('text' not in r for r in children):raise ValueError('sync_complex_link_unsupported')
            if 'member_mention' in at.get('class','').split():
                # Mention identity is a platform binding; the source remains @name prose.
                result.extend(children)
            else:result.append({'type':'link','url':canonical_link(at.get('href','')),'children':children})
            continue
        next_marks={**marks}
        if tag in ('b','strong'):next_marks['bold']=True
        elif tag in ('i','em'):next_marks['italic']=True
        elif tag=='u':next_marks['underline']=True
        elif tag=='code':next_marks['code']=True
        elif tag not in ('span','p','div','h1','h2','h3','h4','h5','h6'):
            raise ValueError('sync_inline_element_unsupported:'+tag)
        result.extend(inline(part.children,next_marks))
    return merge_runs(result)
def text_key(runs):return normalize(native_html(runs,[]))
def signature(runs):return format_structure(native_html(merge_runs(runs),[]))
def urls(runs):return [r['url'] for r in runs if r.get('type')=='link']

def overflow_rows(runs,depth):
    """Reverse only the accepted fullwidth-space markers beyond native list level five."""
    result=[(depth,[])]
    for run in runs:
        if depth!=6 or 'text' not in run:
            result[-1][1].append(run);continue
        start=0
        for marker in re.finditer(r'\n(\u3000{2,})• ',run['text']):
            if len(marker[1])%2:raise ValueError('sync_overflow_indent_ambiguous')
            if marker.start()>start:result[-1][1].append({**run,'text':run['text'][start:marker.start()]})
            result.append((depth+len(marker[1])//2,[]));start=marker.end()
        if start<len(run['text']):result[-1][1].append({**run,'text':run['text'][start:]})
    return result

def rows_from_html(html):
    tree=OutlineTree();tree.feed(canonical_cards(html));tree.close()
    if len(tree.stack)!=1:raise ValueError('sync_unbalanced_html')
    def has_heading(n):return isinstance(n,Element) and (n.tag in ('h2','h3') or any(has_heading(c) for c in n.children))
    offset=1 if has_heading(tree.root) else 0
    rows=[];gaps=[]
    def add(n,depth,kind):
        runs=inline(n.children if kind!='card' else [n])
        for row_depth,row_runs in overflow_rows(runs,depth) if kind=='item' else [(depth,runs)]:
            add_runs(row_runs,row_depth,kind)
    def add_runs(runs,depth,kind):
        ai=False
        if runs and runs[0].get('type')=='math' and runs[0]['tex']==AI_TEX:
            runs=runs[1:];ai=True
            if runs and 'text' in runs[0]:runs[0]['text']=runs[0]['text'].lstrip(' ')
        runs=merge_runs(runs)
        if not text_key(runs):
            if not ai:gaps.append(len(rows))
            return
        row={'depth':depth,'runs':runs,'key':text_key(runs),'kind':kind,'aiPrefix':ai}
        if kind=='card' and rows and rows[-1]['kind']=='paragraph' and re.fullmatch(r'[^:：\n.!?。！？<>]{1,20}[:：]',rows[-1]['key']):
            label=rows.pop();row['runs']=merge_runs(label['runs']+runs);row['key']=text_key(row['runs'])
        rows.append(row)
    def visit(n,depth=0):
        if isinstance(n,str):
            if n.strip():raise ValueError('sync_text_outside_block')
            return
        if n.tag in ('ul','ol'):
            for c in n.children:visit(c,depth+1)
        elif n.tag=='li':
            add(n,depth+offset,'item')
            for c in n.children:
                if isinstance(c,Element) and c.tag in ('ul','ol'):visit(c,depth)
        elif n.tag in ('h2','h3'):add(n,1,'heading')
        elif n.tag=='p':add(n,0,'paragraph')
        elif n.tag=='a' and attrs(n).get('data-draft-type')=='link-card':add(n,0,'card')
        elif n.tag in ('root','div','section'):
            for c in n.children:visit(c,depth)
        else:raise ValueError('sync_block_unsupported:'+n.tag)
    visit(tree.root)
    return rows,gaps

def plan_article(source,remote_body):
    remote,gaps=rows_from_html(remote_body)
    if any('\ufffd' in row['key'] for row in remote):
        raise ValueError('sync_remote_replacement_character_requires_review')
    local=[n for n in source['nodes'][1:] if n['text'].strip()]
    oldkeys=[normalize(native_html(n['richText'],n.get('inlineRefs',[]))) for n in local]
    keys=[n['key'] for n in remote]
    matched={};used=set()
    matcher=difflib.SequenceMatcher(a=oldkeys,b=keys,autojunk=False)
    for match in matcher.get_matching_blocks():
        for k in range(match.size):matched[match.b+k]=match.a+k;used.add(match.a+k)
    # Changed labels/text may reuse an identity only with a clear unique match.
    for j,row in enumerate(remote):
        if j in matched:continue
        candidates=[]
        for i,node in enumerate(local):
            if i in used:continue
            same_urls=urls(row['runs']) and urls(row['runs'])==urls(node['richText'])
            score=1.0 if same_urls else difflib.SequenceMatcher(a=oldkeys[i],b=row['key'],autojunk=False).ratio()
            if score>=0.6:candidates.append((score,i))
        candidates.sort(reverse=True)
        if candidates and (len(candidates)==1 or candidates[0][0]-candidates[1][0]>=0.15):
            matched[j]=candidates[0][1];used.add(candidates[0][1])
    if len(used)!=len(local):raise ValueError('sync_remote_deletion_or_ambiguous_replacement')
    nodes=[];stack={0:source['remId']};changes=[]
    for j,row in enumerate(remote):
        old=local[matched[j]] if j in matched else None
        rem_id=old['remId'] if old else 'new:'+str(j)
        depth=row['depth']
        if row['kind']=='card':
            if not old:raise ValueError('sync_new_lifted_card_parent_unknown')
            depth=old['depth'];parent=old['parentRemId']
        else:
            parent=stack.get(depth-1)
            if parent is None:
                if old and old['depth']==depth:parent=old['parentRemId']
                else:raise ValueError('sync_parent_ambiguous')
        if depth<1:raise ValueError('sync_paragraph_parent_ambiguous')
        stack={d:v for d,v in stack.items() if d<depth};stack[depth]=rem_id
        # Unchanged source atoms (including internal references) stay byte-preserved.
        content_changed=old is not None and signature(row['runs'])!=signature(old['richText'])
        item={**row,'depth':depth,'id':rem_id,'parentId':parent,'oldId':old['remId'] if old else None,
              'oldParentId':old['parentRemId'] if old else None,'oldContent':old['richText'] if old else None,
              'contentChanged':content_changed,'parentChanged':old is not None and parent!=old['parentRemId']}
        if not old or content_changed or item['parentChanged']:changes.append(item)
        nodes.append(item)
    blank_intents=[]
    original=source['nodes']
    for gap_at,gap_count in Counter(gaps).items():
        if gap_at>=len(nodes):continue
        anchor=nodes[gap_at]
        if not anchor['oldId']:continue
        candidates=[]
        for i,n in enumerate(original[1:],1):
            if n['text'].strip():continue
            following=next((a for a in original[i+1:] if a['text'].strip()),None)
            if following and following['remId']==anchor['oldId'] and n['parentRemId']==anchor['oldParentId']:
                candidates.append(n)
        # Leading/trailing editor padding is not a remote separator. Only explicit remote gaps count.
        if len(candidates)!=gap_count:
            raise ValueError('sync_blank_anchor_ambiguous')
        for index,blank in enumerate(candidates):
            following=candidates[index+1]['remId'] if index+1<len(candidates) else anchor['id']
            blank_intents.append({'id':blank['remId'],'parentId':blank['parentRemId'],'beforeId':following})
    return {'sourceId':source['remId'],'fingerprint':source['fingerprint'],'nodes':nodes,'changes':changes,'remoteGaps':gaps,'blankIntents':blank_intents,'retainedIds':len(local),'deletedIds':0}
