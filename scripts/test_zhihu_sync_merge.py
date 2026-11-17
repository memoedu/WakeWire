import copy,unittest
from zhihu_sync import main

def fixture():
    rows=[{'remId':'root','parentRemId':'done','depth':0,'text':'Original title','richText':[{'text':'Original title'}]},
          {'remId':'a','parentRemId':'root','depth':1,'text':'Attention has an opportunity cost.','richText':[{'text':'Attention has an opportunity cost.'}]},
          {'remId':'b','parentRemId':'root','depth':1,'text':'The stopping rule limits comparison.','richText':[{'text':'The stopping rule limits comparison.'}]}]
    base={'remId':'root','parentRemId':'done','fingerprint':'baseline','nodes':rows}
    article={'id':'123','title':'Original title','content':'<ul><li>Attention has an opportunity cost.</li><li>The stopping rule limits comparison.</li></ul><p><br/></p><p>第3 篇 | day 2</p><p>首次发布时间：2026.01.02 12:00</p>'}
    return {'action':'reconcile','baselineSource':base,'source':copy.deepcopy(base),'baselineArticle':article,'article':copy.deepcopy(article)}

def local_edit(r,rid,text,bold=False):
    n=next(n for n in r['source']['nodes'] if n['remId']==rid);n['text']=text;n['richText']=[{'text':text,**({'bold':True} if bold else {})}]
    r['source']['fingerprint']='edited'

class MergeTests(unittest.TestCase):
    def test_disjoint_node_edits_merge_without_overwriting_local_atom(self):
        r=fixture();local_edit(r,'a','Attention has a substantial opportunity cost.')
        r['article']['content']=r['article']['content'].replace('limits comparison','limits repeated comparison')
        frozen=copy.deepcopy(r);result=main(r)
        self.assertEqual(result['direction'],'merged')
        self.assertEqual([n['id'] for n in result['pullPlan']['changes']],['b'])
        self.assertEqual(result['pullPlan']['fingerprint'],'edited');self.assertEqual(r,frozen)
    def test_same_node_conflict_stops_before_any_plan(self):
        r=fixture();local_edit(r,'a','Attention has a small opportunity cost.')
        r['article']['content']=r['article']['content'].replace('an opportunity','a large opportunity')
        self.assertEqual(main(r),{'direction':'conflict','code':'sync_same_node_conflict','nodeIds':['a']})
    def test_identical_concurrent_changes_converge(self):
        r=fixture();text='Attention has a substantial opportunity cost.';local_edit(r,'a',text)
        r['article']['content']=r['article']['content'].replace('Attention has an opportunity cost.',text)
        self.assertEqual(main(r)['direction'],'converged')
    def test_local_only_format_change_is_outgoing(self):
        r=fixture();local_edit(r,'a',r['source']['nodes'][1]['text'],True)
        self.assertEqual(main(r)['direction'],'local')
    def test_different_format_and_text_nodes_merge(self):
        r=fixture();local_edit(r,'a',r['source']['nodes'][1]['text'],True)
        r['article']['content']=r['article']['content'].replace('limits comparison','limits repeated comparison')
        self.assertEqual(main(r)['direction'],'merged')
    def test_format_and_text_on_same_node_conflict(self):
        r=fixture();local_edit(r,'a',r['source']['nodes'][1]['text'],True)
        r['article']['content']=r['article']['content'].replace('an opportunity','a substantial opportunity')
        self.assertEqual(main(r)['code'],'sync_same_node_conflict')
    def test_local_addition_survives_unrelated_remote_edit(self):
        r=fixture();r['source']['nodes'].append({'remId':'new-local','parentRemId':'root','depth':1,'text':'New local paragraph','richText':[{'text':'New local paragraph'}]})
        r['article']['content']=r['article']['content'].replace('limits comparison','limits repeated comparison')
        result=main(r);self.assertEqual(result['direction'],'merged')
        self.assertIn('new-local',[n['id'] for n in result['pullPlan']['nodes']])
    def test_local_title_and_remote_body_merge(self):
        r=fixture();local_edit(r,'root','A clearer title')
        r['article']['content']=r['article']['content'].replace('limits comparison','limits repeated comparison')
        self.assertEqual(main(r)['direction'],'merged')
    def test_local_and_remote_title_conflict(self):
        r=fixture();local_edit(r,'root','Local title');r['article']['title']='Remote title'
        self.assertEqual(main(r)['nodeIds'],['root'])
    def test_deletion_is_never_automatic(self):
        r=fixture();r['source']['nodes'].pop()
        self.assertEqual(main(r)['code'],'sync_source_deletion_requires_review')
        r=fixture();r['article']['content']=r['article']['content'].replace('<li>The stopping rule limits comparison.</li>','')
        self.assertEqual(main(r)['direction'],'conflict')
    def test_remote_structure_and_local_change_require_review(self):
        r=fixture();local_edit(r,'a','Attention has a substantial opportunity cost.')
        r['article']['content']=r['article']['content'].replace('<li>The stopping rule','<ul><li>The stopping rule').replace('</li></ul>','</li></ul></ul>')
        self.assertEqual(main(r)['direction'],'conflict')
    def test_generated_footer_change_is_not_authored_change(self):
        r=fixture();r['article']['content']=r['article']['content'].replace('day 2','day 20')
        self.assertEqual(main(r)['direction'],'none')
    def test_archive_root_placement_is_not_a_text_change(self):
        r=fixture();r['source']['nodes'][0]['parentRemId']='another-container'
        self.assertEqual(main(r)['direction'],'none')
    def test_signature_does_not_mutate_adjacent_native_runs(self):
        r=fixture();r['baselineSource']['nodes'][1]['richText']=[{'text':'Attention has '},{'text':'an opportunity cost.'}]
        r['source']=copy.deepcopy(r['baselineSource'])
        r['article']['content']=r['article']['content'].replace('limits comparison','limits repeated comparison')
        frozen=copy.deepcopy(r);main(r);self.assertEqual(r,frozen)
    def test_equal_text_edits_do_not_discard_a_local_blank_addition(self):
        r=fixture();text='Attention has a substantial opportunity cost.';local_edit(r,'a',text)
        r['article']['content']=r['article']['content'].replace('Attention has an opportunity cost.',text)
        r['source']['nodes'].insert(2,{'remId':'gap','parentRemId':'root','depth':1,'text':'','richText':[]})
        self.assertEqual(main(r)['direction'],'local')
    def test_removed_remote_blank_is_an_explicit_conflict(self):
        r=fixture();r['baselineArticle']['content']=r['baselineArticle']['content'].replace('</li><li>','</li></ul><p><br/></p><ul><li>')
        self.assertEqual(main(r)['code'],'sync_blank_structure_requires_review')

if __name__=='__main__':unittest.main()
