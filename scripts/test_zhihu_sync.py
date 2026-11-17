"""Conflicts and publication metadata must not become silent source overwrites."""
import copy,unittest
from zhihu_sync import main

def fixture():
    root={'remId':'root','text':'Title','parentRemId':'document','depth':0,'richText':[{'text':'Title'}]}
    child={'remId':'body','text':'Body','parentRemId':'root','depth':1,'richText':[{'text':'Body'}]}
    source={'remId':'root','fingerprint':'frozen','nodes':[root,child]}
    article={'id':'123','title':'Title','content':'<ul><li>Body</li></ul><p><br/></p><p>第2 篇 | day 1</p><p>首次发布时间：2026.01.01 12:00</p>'}
    return source,article

class SyncHelperTests(unittest.TestCase):
    def test_unchanged_author_body_ignores_generated_footer(self):
        source,article=fixture()
        plan=main({'action':'plan','source':source,'baseline':source,'article':article})
        self.assertEqual(plan['changes'],[])
        self.assertIn('首次发布时间',plan['publicationFooter'])
    def test_local_format_change_blocks_pull_even_when_plain_text_is_unchanged(self):
        baseline,article=fixture();source=copy.deepcopy(baseline)
        source['nodes'][1]['richText'][0]['bold']=True
        with self.assertRaisesRegex(ValueError,'local_changes'):
            main({'action':'plan','source':source,'baseline':baseline,'article':article})
    def test_remote_title_change_reuses_root_identity(self):
        source,article=fixture();article['title']='Changed title'
        plan=main({'action':'plan','source':source,'baseline':source,'article':article})
        self.assertEqual(len(plan['changes']),1)
        self.assertEqual(plan['changes'][0]['id'],'root')
        self.assertEqual(plan['changes'][0]['runs'],[{'text':'Changed title'}])
    def test_remote_edit_since_capture_blocks_apply(self):
        _,article=fixture();changed=copy.deepcopy(article);changed['content']=changed['content'].replace('Body','Author edit')
        with self.assertRaisesRegex(ValueError,'changed_during_planning'):
            main({'action':'assert-published','before':article,'article':changed})
    def test_removed_visible_blank_is_not_a_successful_readback(self):
        source,article=fixture()
        source['nodes'][1].update(text='An independently checked body',richText=[{'text':'An independently checked body'}])
        article['content']=article['content'].replace('Body','An independently checked body')
        source['nodes'] += [{'remId':'gap','parentRemId':'root','depth':1,'text':'','richText':[]},
            {'remId':'tail','parentRemId':'root','depth':1,'text':'Tail','richText':[{'text':'Tail'}]}]
        article['content']=article['content'].replace('</li>','</li><li>Tail</li>',1)
        with self.assertRaisesRegex(ValueError,'blank_render'):
            main({'action':'verify','source':source,'before':source,'article':article})

if __name__=='__main__':unittest.main()
