import sys,unittest
from pathlib import Path
from zhihu_sync_model import plan_article,rows_from_html

def source(rows):
    return {'remId':'root','fingerprint':'frozen','nodes':[{'remId':'root','text':'Title','depth':0}]+[{'remId':rid,'parentRemId':parent,'depth':depth,'text':text,'richText':[{'text':text}]} for rid,parent,depth,text in rows]}

class SyncModelTests(unittest.TestCase):
    def test_blank_separator_is_anchored_to_following_sibling_after_parent_insertion(self):
        old=source([('a','root',1,'Parent'),('b','a',2,'Detailed explanation'),('x','b',3,'Child detail'),('gap','a',2,''),('c','a',2,'Tail item')])
        html='<ul><li>Parent</li><ul><li>New group</li><ul><li>Detailed explanation</li><li>Child detail</li></ul></ul></ul><p><br/></p><ul><ul><li>Tail item</li></ul></ul>'
        plan=plan_article(old,html)
        self.assertEqual(plan['blankIntents'],[{'id':'gap','parentId':'a','beforeId':'c'}])
    def test_two_consecutive_blanks_have_distinct_stable_anchors(self):
        old=source([('a','root',1,'First item'),('gap1','root',1,''),('gap2','root',1,''),('b','root',1,'Last item')])
        plan=plan_article(old,'<ul><li>First item</li></ul><p><br/></p><p><br/></p><ul><li>Last item</li></ul>')
        self.assertEqual(plan['blankIntents'],[{'id':'gap1','parentId':'root','beforeId':'gap2'},{'id':'gap2','parentId':'root','beforeId':'b'}])
    def test_additive_parent_insertion_keeps_existing_child_identities(self):
        old=source([('a','root',1,'Parent'),('b','a',2,'Detailed explanation.'),('c','b',3,'Child detail'),('d','a',2,'Tail item')])
        html='<ul><li>Parent</li><ul><li>New group</li><ul><li>Detailed explanation</li><li>Child detail</li></ul><li>Tail item</li></ul></ul>'
        plan=plan_article(old,html)
        self.assertEqual(plan['deletedIds'],0)
        self.assertEqual(plan['retainedIds'],4)
        mapped={n['id']:n for n in plan['nodes']}
        self.assertEqual(mapped['b']['parentId'],'new:1')
        self.assertEqual(mapped['c']['parentId'],'new:1')
        self.assertTrue(mapped['b']['contentChanged'])
    def test_deletion_or_ambiguous_replacement_is_not_applied(self):
        old=source([('a','root',1,'First important clause'),('b','root',1,'Second important clause')])
        with self.assertRaisesRegex(ValueError,'deletion_or_ambiguous'):
            plan_article(old,'<ul><li>First important clause</li></ul>')
    def test_links_math_marks_and_linebreaks_are_kept(self):
        rows,_=rows_from_html('<ul><li><b>Strong</b><br/><a href="https://example.org">Reference</a><img eeimg="1" src="" alt="x^2"/></li></ul>')
        self.assertEqual(rows[0]['runs'],[{'text':'Strong','bold':True},{'text':'\n'},{'type':'link','url':'https://example.org','children':[{'text':'Reference'}]},{'type':'math','tex':'x^2','display':False}])
    def test_lifted_card_recovers_existing_parent_and_updates_only_label(self):
        old=source([('a','root',1,'Parent')])
        old['nodes'].append({'remId':'b','parentRemId':'a','depth':2,'text':'Reference: old','richText':[{'text':'Reference:'},{'type':'link','url':'https://example.org','children':[{'text':'Old title'}]}]})
        html='<ul><li>Parent</li></ul><p>Reference:</p><a data-draft-node="block" data-draft-type="link-card" data-draft-title="New title" href="https://example.org">New title</a>'
        plan=plan_article(old,html)
        self.assertEqual(plan['nodes'][1]['id'],'b')
        self.assertEqual(plan['nodes'][1]['parentId'],'a')
        self.assertTrue(plan['nodes'][1]['contentChanged'])
    def test_unhandled_media_fails_before_any_write(self):
        with self.assertRaisesRegex(ValueError,'media'):
            rows_from_html('<ul><li>Text<img src="https://example.org/photo.png"/></li></ul>')
    def test_generated_article_ai_badge_is_not_an_authored_blank(self):
        rows,gaps=rows_from_html('<p><img eeimg="1" src="" alt="\\color{#7040a0}{\\text{AI}}"/></p><ul><li>Author text</li></ul>')
        self.assertEqual(gaps,[])
        self.assertEqual(len(rows),1)
    def test_decoding_damage_never_becomes_a_source_update(self):
        old=source([('a','root',1,'继续投入生产')])
        with self.assertRaisesRegex(ValueError,'replacement_character'):
            plan_article(old,'<ul><li>��续投入生产</li></ul>')


if __name__=='__main__':unittest.main()
