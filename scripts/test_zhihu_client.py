"""Offline regression tests for the narrow client adapter (no real credentials)."""

import importlib.util
import json
import re
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch
from zhihu_cli.client import ZhihuClient
from zhihu_outline_overflow import overflow_spaces

spec = importlib.util.spec_from_file_location("zhihu_adapter", Path(__file__).with_name("zhihu-client.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def test_series_metadata_stays_in_footer_with_plain_title_and_original_body(self):
        nodes=[{'text':'A plain title','depth':0},{'text':'Original body','depth':1}]
        prepared=adapter.prepare(nodes,'待发布',series_label='第12 篇 | day 5')
        self.assertEqual(prepared['title'],'A plain title')
        self.assertTrue(prepared['html'].endswith('<p class="ztext-empty-paragraph"><br/></p><p>第12 篇 | day 5</p><p>首次发布时间：待发布</p>'))
        self.assertEqual(prepared['seriesLabel'],'第12 篇 | day 5')
        for invalid in ('第1 篇 | day 0','<script>bad</script>','第0 篇 | day 1'):
            with self.assertRaisesRegex(ValueError,'series_footer_invalid'):
                adapter.prepare(nodes,'待发布',series_label=invalid)
    def test_catalog_uses_nonempty_native_headings_without_promoting_plain_text(self):
        self.assertTrue(adapter.has_catalog_headings('<h2>Only chapter</h2><p>Body</p>'))
        self.assertTrue(adapter.has_catalog_headings('<h3>Nested chapter</h3>'))
        for html in ('<h2><br/></h2>', '<p><b>Bold prose</b></p>',
                     '<pre>&lt;h2&gt;Code example&lt;/h2&gt;</pre>', '<h4>Unsupported heading</h4>'):
            self.assertFalse(adapter.has_catalog_headings(html))

    def test_catalog_setting_is_submitted_only_for_eligible_articles(self):
        for body, expected in (('<h2>Chapter</h2><ul><li>Body</li></ul>', True),
                               ('<ul><li>Plain article</li></ul>', False)):
            client = MagicMock()
            client._content_publish.return_value = {'publish': {'id': '666'}}
            with patch.object(adapter, 'check_column'):
                adapter.publish_article_content(client, '666', 'Title', body, 'column')
            payload = client._content_publish.call_args.args[0]['data']
            self.assertEqual(payload['contentsTables'], {'table_of_contents_enabled': expected})
            self.assertEqual(payload['hybrid']['html'], body)

    def test_catalog_draft_save_and_missing_setting_readback(self):
        html = '<h2>Catalog chapter</h2><p>Complete body</p>'
        before = {'id': '666', 'authorId': 'me', 'state': 'draft', 'title': 'Old', 'text': 'Old body', 'format': 'old'}
        saved = {**before, 'title': 'Title', 'text': adapter.normalize(html), 'format': adapter.format_structure(html), 'tableOfContents': True}
        for persisted in (True, False):
            client = MagicMock()
            client._session.patch.return_value.status_code = 200
            with patch.object(adapter, 'read_draft', side_effect=[before, {**saved, 'tableOfContents': persisted}]):
                if persisted:
                    self.assertTrue(adapter.write_draft(client, '666', 'Title', html, 'me', before)['tableOfContents'])
                else:
                    with self.assertRaisesRegex(ValueError, 'table_of_contents_readback_mismatch'):
                        adapter.write_draft(client, '666', 'Title', html, 'me', before)
            self.assertTrue(client._session.patch.call_args.kwargs['json']['table_of_contents'])

    def test_overflow_keeps_all_extra_levels_marks_and_native_sibling_return(self):
        nodes = [{"text": "Independent deep outline", "depth": 0}, {"text": "Outer chapter", "depth": 1}]
        nodes += [{"text": "Native level " + str(depth), "depth": depth} for depth in range(2, 7)]
        nodes += [{"text": "Child link", "depth": 7, "richText": [{"type": "link", "url": "https://example.org/reference", "children": [{"text": "Child link", "underline": True}]}]},
                  {"text": "Grandchild", "depth": 8, "richText": [{"text": "Grandchild", "bold": True}]},
                  {"text": "$x^2$\nNext line", "depth": 9},
                  {"text": "Overflow sibling", "depth": 7},
                  {"text": "Native sibling", "depth": 6}]
        result = adapter.prepare(nodes, "待发布")
        self.assertEqual(result['hierarchyMode'], 'overflow-spaces')
        self.assertIn('<br/>　　• <a href="https://example.org/reference"><u>Child link</u></a>', result['html'])
        self.assertIn('<br/>　　　　• <strong>Grandchild</strong>', result['html'])
        self.assertIn('<br/>　　　　　　• <img ', result['html'])
        self.assertRegex(result['html'], r'<br\s*/>\s*Next line<br/>　　• Overflow sibling</li><li>Native sibling</li>')
        layout = json.loads(result['format'])
        self.assertEqual(max(b['depth'] for b in layout['blocks']), 5)
        self.assertEqual(sum(s[0] == 'math' for s in layout['styles']), 1)
        self.assertEqual(layout['blocks'][-3]['text'], 'Nativesibling')

    def test_overflow_indent_spaces_bullets_and_breaks_are_part_of_readback(self):
        nodes = [{"text": "Overflow comparison", "depth": 0}]
        nodes += [{"text": "Level " + str(depth), "depth": depth} for depth in range(1, 8)]
        result = adapter.prepare(nodes)
        for changed in (result['html'].replace('　　• ', '• '),
                        result['html'].replace('　　• ', '　• '),
                        result['html'].replace('　　• ', '　　◦ '),
                        result['html'].replace('<br/>　　• ', '　　• ')):
            self.assertNotEqual(adapter.format_structure(changed), result['format'])
        self.assertNotEqual(adapter.normalize(result['html'].replace('　　• ', '• ')), result['text'])

    def test_overflow_transform_leaves_shallow_html_byte_identical(self):
        html = '<h2>A &amp; B</h2><ul><li><b>Normal</b><br/>line</li><ul><li><u>Detail</u></li></ul></ul><p><br/></p>'
        self.assertEqual(overflow_spaces(html), html)

    def test_overflow_transform_supports_conventional_nested_li(self):
        html = '<ul><li>A<ul><li>B<ul><li><u>C</u></li></ul></li></ul></li></ul>'
        self.assertIn('<li>B<br/>　　• <u>C</u></li>', overflow_spaces(html, limit=2))

    def test_overflow_orphan_and_unbalanced_structures_stay_blocked(self):
        with self.assertRaisesRegex(ValueError, 'hierarchy_overflow_parent_missing'):
            overflow_spaces('<ul><li>A</li><ul><ul><li>C</li></ul></ul></ul>', limit=2)
        with self.assertRaisesRegex(ValueError, 'hierarchy_overflow_unbalanced'):
            overflow_spaces('<ul><li>A</ul>')

    def test_native_underline_preserves_exact_ranges_and_composes_with_existing_marks(self):
        nodes = [{"text": "Underline fixture", "depth": 0}, {"text": "Before marked text after", "depth": 1,
                 "richText": [{"text": "Before "}, {"text": "marked text", "underline": True, "bold": True}, {"text": " after"}]}]
        result = adapter.prepare(nodes, "待发布")
        self.assertIn('Before <u><strong>marked text</strong></u> after', result['html'])
        self.assertEqual(result['text'], 'Beforemarkedtextafter首次发布时间：待发布')
        self.assertIn(['+u', 6], json.loads(result['format'])['styles'])
        without = result['html'].replace('<u>', '').replace('</u>', '')
        self.assertEqual(adapter.normalize(without), result['text'])
        self.assertNotEqual(adapter.format_structure(without), result['format'])
        moved = result['html'].replace('Before <u><strong>marked text</strong></u> after', '<u>Before </u><strong>marked text</strong> after')
        self.assertNotEqual(adapter.format_structure(moved), result['format'])

    def test_explicitly_underlined_link_does_not_lose_its_mark_in_a_card_title(self):
        result = adapter.prepare([{"text": "Underlined link", "depth": 0}, {"text": "Independent underlined reference", "depth": 1,
            "richText": [{"type": "link", "url": "https://example.org/ref", "children": [{"text": "Independent underlined reference", "underline": True}]}]}])
        self.assertIn('<a href="https://example.org/ref"><u>Independent underlined reference</u></a>', result['html'])
        self.assertNotIn('data-draft-type="link-card"', result['html'])

    def test_cloud_readback_rejects_lost_underline_even_when_all_text_matches(self):
        client = MagicMock()
        html = '<p>Before <u>underlined words</u> after</p>'
        expected = {'id': '915', 'authorId': 'author', 'title': 'Fixture', 'text': 'Oldbody', 'format': 'old', 'state': 'draft'}
        saved = {**expected, 'text': adapter.normalize(html), 'format': adapter.format_structure(html.replace('<u>', '').replace('</u>', '')), 'tableOfContents': False}
        client._session.patch.return_value.status_code = 200
        with patch.object(adapter, 'read_draft', side_effect=[expected, saved]):
            with self.assertRaisesRegex(ValueError, 'draft_readback_mismatch'):
                adapter.write_draft(client, '915', 'Fixture', html, 'author', expected)
        client._content_publish.assert_not_called()

    def test_plain_underscores_are_not_reinterpreted_as_native_underline(self):
        result = adapter.prepare([{'text': 'Literal underscore fixture', 'depth': 0},
            {'text': 'snake_case and ordinary values remain plain', 'depth': 1, 'richText': [{'text': 'snake_case and ordinary values remain plain'}]}])
        self.assertNotIn('<u>', result['html'])
        self.assertNotIn('underline', result['html'])

    def test_standalone_reference_leaves_become_cards_but_prose_links_stay_inline(self):
        result = adapter.prepare([
            {"text": "Reference example", "depth": 0},
            {"text": "Read [the guide](https://example.com/guide) before continuing.", "depth": 1},
            {"text": "References", "depth": 1},
            {"text": "原文：[Original guide](https://example.org/original?q=1&lang=en)", "depth": 2},
            {"text": "译文：[Translated guide](https://example.net/translation)", "depth": 2},
            {"text": "Ordinary sibling after the citations", "depth": 2},
            {"text": "Final independent paragraph", "depth": 1},
        ], "待发布")
        html = result["html"]
        self.assertEqual(html.count('data-draft-type="link-card"'), 2)
        self.assertIn('<li>Read <a href="https://example.com/guide">the guide</a> before continuing.</li>', html)
        self.assertIn('<p>原文：</p><a ', html)
        blocks = json.loads(result["format"])["blocks"]
        cards = [b for b in blocks if b["kind"] == "card"]
        self.assertEqual([b["depth"] for b in cards], [0, 0])
        self.assertEqual(cards[0]["href"], "https://example.org/original?q=1&lang=en")
        self.assertEqual(next(b["depth"] for b in blocks if b.get("text") == "Ordinarysiblingafterthecitations"), 2)
        self.assertEqual(blocks[-2]["kind"], "gap")
        self.assertEqual(blocks[-1]["text"], "首次发布时间：待发布")
        self.assertNotIn('data-outline-card', html)

    def test_native_rich_reference_preserves_label_bold_and_ordinary_native_link(self):
        link = {"type": "link", "url": "https://example.org/reference", "children": [{"text": "Reference title", "bold": True}]}
        result = adapter.prepare([
            {"text": "Native links", "depth": 0},
            {"text": "原文：Reference title", "depth": 1, "richText": [{"text": "原文：", "bold": True}, link]},
            {"text": "Compare Reference title with the original argument.", "depth": 1,
             "richText": [{"text": "Compare "}, link, {"text": " with the original argument."}]},
        ])
        self.assertEqual(result["html"].count('data-draft-type="link-card"'), 1)
        self.assertIn('<p><strong>原文：</strong></p>', result["html"])
        self.assertIn('Compare <a href="https://example.org/reference"><strong>Reference title</strong></a> with the original argument.', result["html"])

    def test_bare_url_and_single_link_are_independent_references(self):
        for text in ("https://example.org/path?q=1&x=2", "资料：https://example.org/path", "[Standalone reference](https://example.org/path)"):
            with self.subTest(text=text):
                result = adapter.prepare([{"text": "Bare references", "depth": 0}, {"text": text, "depth": 1}])
                self.assertEqual(result["html"].count('data-draft-type="link-card"'), 1)

    def test_multiline_multiple_links_parent_nodes_and_code_are_not_cards(self):
        samples = [
            [{"text": "[Reference one](https://example.org/one)\nmore explanation", "depth": 1}],
            [{"text": "[First reference](https://example.org/one) and [second](https://example.org/two)", "depth": 1}],
            [{"text": "[Parent reference](https://example.org/one)", "depth": 1}, {"text": "Child explanation remains subordinate", "depth": 2}],
            [{"text": "`https://example.org/code` is literal code", "depth": 1}],
            [{"text": "A sentence: consider [the reference](https://example.org/one) carefully", "depth": 1}],
        ]
        for nodes in samples:
            with self.subTest(nodes=nodes):
                self.assertNotIn('data-draft-type="link-card"', adapter.prepare([{"text": "Ordinary hyperlinks", "depth": 0}, *nodes])["html"])

    def test_card_leaf_with_ai_badge_keeps_one_badge_and_five_level_siblings(self):
        nodes = [{"text": "Deep card fixture", "depth": 0}, {"text": "Section heading", "depth": 1}]
        nodes += [{"text": "Nested level " + str(depth), "depth": depth} for depth in range(2, 7)]
        nodes += [{"text": "[Generated reference](https://example.org/ref)", "depth": 6, "tags": [{"tagRemId": "ai"}]},
                  {"text": "Another deepest sibling", "depth": 6}]
        result = adapter.prepare(nodes, "待发布", "ai")
        self.assertEqual(result["html"].count('alt="\\color{#7040a0}{\\text{AI}}"'), 1)
        blocks = json.loads(result["format"])["blocks"]
        self.assertEqual(next(b["depth"] for b in blocks if b["kind"] == "card"), 0)
        self.assertEqual(next(b["depth"] for b in blocks if b.get("text") == "Anotherdeepestsibling"), 5)

    def test_card_readback_ignores_platform_metadata_but_detects_type_title_target_and_depth_changes(self):
        expected = '<a href="https://example.org/ref" data-draft-node="block" data-draft-type="link-card" data-text="Original reference" data-draft-title="Original reference">Original reference</a>'
        hydrated = '<a class="LinkCard new" href="https://link.zhihu.com/?target=https%3A%2F%2Fexample.org%2Fref" data-text="Original reference" data-draft-title="Platform title"><span class="LinkCard-image"><img src="https://pic.example.org/cover.png"/></span><span>Platform title</span><span>100 votes <a class="tag">Article</a></span></a>'
        self.assertEqual(adapter.normalize(expected), "Originalreference")
        self.assertEqual(adapter.normalize(hydrated), adapter.normalize(expected))
        self.assertEqual(adapter.format_structure(expected), adapter.format_structure(hydrated))
        for edited in (expected.replace('link-card', 'ordinary-link'), expected.replace('example.org/ref', 'example.org/changed'), expected.replace('Original reference', 'Different reference')):
            self.assertNotEqual(adapter.format_structure(expected), adapter.format_structure(edited))
        with self.assertRaisesRegex(ValueError, 'link_card_block_invalid'):
            adapter.format_structure('<ul><li>' + expected + '</li></ul>')
        with self.assertRaisesRegex(ValueError, 'link_card_target_invalid'):
            adapter.format_structure(expected.replace('https://example.org/ref', 'javascript:alert(1)'))
        with self.assertRaisesRegex(ValueError, 'link_card_incomplete'):
            adapter.format_structure(expected.removesuffix('</a>'))

    def test_draft_roundtrip_blocks_sanitized_card_downgrade_without_publishing(self):
        client = MagicMock()
        expected = {"id": "711", "authorId": "author", "title": "Fixture", "text": "Oldbody", "format": "old", "state": "draft"}
        html = adapter.prepare([{"text": "Reference fixture", "depth": 0}, {"text": "[Standalone reference](https://example.org/ref)", "depth": 1}])["html"]
        saved = {**expected, "text": adapter.normalize(html), "format": adapter.format_structure(html.replace('link-card', 'ordinary-link')), "tableOfContents": False}
        client._session.patch.return_value.status_code = 200
        with patch.object(adapter, 'read_draft', side_effect=[expected, saved]):
            with self.assertRaisesRegex(ValueError, 'link_card_readback_mismatch'):
                adapter.write_draft(client, '711', 'Fixture', html, 'author', expected)
        client._content_publish.assert_not_called()

    def test_mentions_split_across_style_runs_cannot_silently_remain_plain(self):
        html = '<p>来自@<strong>Example</strong> 的观点</p>'
        self.assertEqual(adapter.mention_names(html), ["Example"])
        with self.assertRaisesRegex(ValueError, "split_format_unsupported"):
            adapter.apply_mentions(html, [{"name": "Example", "id": "a" * 32}])
        self.assertEqual(adapter.mention_names('<p>person<strong>@example.com</strong></p>'), [])

    def test_native_member_mention_preserves_prose_and_validates_identity(self):
        nodes = [{"text": "Mention example", "depth": 0}, {"text": "来自@示例老师 的课程与观点", "depth": 1}]
        result = adapter.prepare(nodes, mention_bindings=[{"name": "示例老师", "id": "a" * 32}])
        self.assertIn('class="member_mention"', result["html"])
        self.assertIn('data-hash="' + "a" * 32 + '"', result["html"])
        self.assertEqual(result["text"], "来自@示例老师的课程与观点")
        self.assertIn(["mention", "a" * 32, 2], json.loads(result["format"])["styles"])
        ordinary = result["html"].replace('class="member_mention"', '')
        self.assertNotEqual(adapter.format_structure(ordinary), result["format"])
        self.assertEqual(adapter.format_structure(result["html"].replace('https://www.zhihu.com/people/', 'http://www.zhihu.com/people/')), result["format"])
        self.assertEqual(adapter.format_structure(result["html"].replace('https://www.zhihu.com/people/', '//www.zhihu.com/people/')), result["format"])
        with self.assertRaisesRegex(ValueError, "mention_identity_invalid"):
            adapter.format_structure(result["html"].replace('/people/' + 'a' * 32, '/people/' + 'b' * 32))
        with self.assertRaisesRegex(ValueError, "mention_unresolved"):
            adapter.prepare(nodes)

    def test_email_code_math_and_existing_links_are_not_reinterpreted_as_mentions(self):
        result = adapter.prepare([{"text": "Literal contexts", "depth": 0},
                                  {"text": "Contact person@example.com; `@decorator` and $x@ y$ plus [@link](https://example.com/)", "depth": 1}])
        self.assertNotIn('member_mention', result["html"])
        self.assertEqual(result["mentionBindings"], [])

    def test_authenticated_binding_is_reused_and_profile_mismatch_blocks(self):
        client = MagicMock()
        identity = {"name": "示例老师", "id": "a" * 32}
        client._get.return_value = dict(identity)
        self.assertEqual(adapter.resolve_mentions(client, ["示例老师"], [identity]), [identity])
        client.search.assert_not_called()
        client._get.return_value = {"name": "Different person", "id": "a" * 32}
        with self.assertRaisesRegex(ValueError, "profile_changed"):
            adapter.resolve_mentions(client, ["示例老师"], [identity])
        client._session.post.assert_not_called()

    def test_people_resolution_requires_complete_unique_exact_results(self):
        client = MagicMock()
        person = {"type": "people", "name": "<em>Example</em>", "id": "b" * 32}
        client.search.side_effect = [{"data": [{"object": person}], "paging": {"is_end": False}}, {"data": [], "paging": {"is_end": True}}]
        client._get.return_value = {"name": "Example", "id": "b" * 32}
        self.assertEqual(adapter.resolve_mentions(client, ["Example"], []), [{"name": "Example", "id": "b" * 32}])
        client.search.side_effect = None
        client.search.return_value = {"data": [{"object": person}, {"object": {**person, "id": "c" * 32}}], "paging": {"is_end": True}}
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            adapter.resolve_mentions(client, ["Example"], [])
        client.search.return_value = {"data": [{"object": person}], "paging": {"is_end": False}}
        with self.assertRaisesRegex(ValueError, "incomplete"):
            adapter.resolve_mentions(client, ["Example"], [])

    def test_ai_ranges_have_one_parent_badge_without_automatic_italics(self):
        ai = [{"tagRemId": "ai-native", "name": "AI Generated"}]
        result = adapter.prepare([
            {"text": "Independent AI example", "depth": 0},
            {"text": "Human introduction", "depth": 1},
            {"text": "**Generated parent**", "depth": 1, "tags": ai},
            {"text": "Child [reference](https://example.com/)", "depth": 2},
            {"text": "Nested tagged grandchild $x^2$", "depth": 3, "tags": ai},
            {"text": "Human closing", "depth": 1},
        ], "待发布", "ai-native")
        html = result["html"]
        self.assertEqual(html.count('alt="\\color{#7040a0}{\\text{AI}}"'), 1)
        self.assertIn('<strong>Generated parent</strong>', html)
        self.assertIn('Child <a href="https://example.com/">reference</a>', html)
        self.assertNotIn('<em>', html)
        self.assertIn('<li>Human closing</li>', html)
        self.assertIn('<p>首次发布时间：待发布</p>', html)
        self.assertEqual(sum(s[0] == "math" for s in json.loads(result["format"])["styles"]), 2)

    def test_ai_binding_is_by_exact_tag_id_and_root_range_is_labeled_once(self):
        nodes = [{"text": "Whole article", "depth": 0, "tags": [{"tagRemId": "ai-root", "name": "renamed tag"}]},
                 {"text": "Whole article generated body", "depth": 1},
                 {"text": "Nested generated detail", "depth": 2, "tags": [{"tagRemId": "ai-root", "name": "renamed tag"}]}]
        result = adapter.prepare(nodes, None, "ai-root")
        self.assertEqual(result["html"].count('alt="\\color{#7040a0}{\\text{AI}}"'), 1)
        self.assertIn('<li>Nested generated detail</li>', result["html"])
        self.assertNotIn('eeimg=', adapter.prepare(nodes, None, "different-id")["html"])

    def test_native_bold_trailing_space_never_becomes_literal_markdown(self):
        nodes = [{"text": "Native emphasis", "depth": 0},
                 {"text": "**Native bold ** and literal stars", "depth": 1,
                  "richText": [{"text": "Native bold ", "bold": True}, {"text": "and literal **stars**\nnext line"}]}]
        html = adapter.prepare(nodes)["html"]
        self.assertIn('<strong>Native bold </strong>', html)
        self.assertIn('literal **stars**<br/>next line', html)

    def test_section_headings_preserve_six_source_levels_and_global_blank_blocks(self):
        nodes = [{"text": "Deep independent article", "depth": 0},
                 {"text": "Outer section", "depth": 1}]
        nodes += [{"text": f"Child level {depth}", "depth": depth} for depth in range(2, 7)]
        nodes += [{"text": "", "depth": 4}, {"text": "Second branch", "depth": 4},
                  {"text": "Grandchild", "depth": 5}, {"text": "Deepest sibling", "depth": 6}]
        prepared = adapter.prepare(nodes)
        self.assertEqual(prepared["hierarchyMode"], "section-headings")
        self.assertIn('<h2>Outer section</h2>', prepared["html"])
        blocks = json.loads(prepared["format"])["blocks"]
        self.assertEqual([b["depth"] for b in blocks if b["kind"] == "item"], [1, 2, 3, 4, 5, 3, 4, 5])
        self.assertEqual([b for b in blocks if b["kind"] == "gap"], [{"kind": "gap", "depth": 0}])

    def test_native_math_keeps_latex_links_and_linebreaks(self):
        latex = r'\frac{x_1}{2} + \text{A & B}'
        result = adapter.prepare([
            {"text": "Independent formula title", "depth": 0},
            {"text": f"Inline ${latex}$ and [reference](https://example.com/a?x=1&y=2)\nnext line", "depth": 1},
            {"text": r"$$\sum_{k=1}^{n} k$$", "depth": 2},
        ])
        self.assertIn('eeimg="1"', result["html"])
        self.assertIn('eeimg="2"', result["html"])
        self.assertIn('<br', result["html"])
        layout = json.loads(result["format"])
        formulas = [s for s in layout["styles"] if s[0] == "math"]
        self.assertEqual([f[2] for f in formulas], [latex, r'\sum_{k=1}^{n} k'])
        self.assertEqual([s[1] for s in layout["styles"] if s[0] == "+a"], ["https://example.com/a?x=1&y=2"])
        self.assertNotEqual(result["format"], adapter.format_structure(re.sub(r'<img[^>]+>', '', result["html"])))
        self.assertIn(adapter.normalize(f'<p>${latex}$</p>'), result["text"])

    def test_code_and_escaped_dollar_are_not_formulas(self):
        result = adapter.prepare([{"text": "Code example", "depth": 0},
                                  {"text": r'Literal \$x\$ and `$x$` plus $y^2$', "depth": 1}])
        self.assertEqual(result["html"].count('<img '), 1)
        self.assertIn('<code>$x$</code>', result["html"])
        with self.assertRaisesRegex(ValueError, "latex_mismatch"):
            adapter.format_structure('<img eeimg="1" src="https://www.zhihu.com/equation?tex=x" alt="y"/>')
        native = '<img eeimg="1" src="" alt="x^2"/>'
        authored = '<img eeimg="1" src="//www.zhihu.com/equation?tex=x%5E2" alt="x^2"/>'
        self.assertEqual(adapter.format_structure(native), adapter.format_structure(authored))
        self.assertEqual(adapter.normalize(native), "$x^2$")

    def test_publication_footer_is_one_gap_and_draft_has_no_invented_time(self):
        nodes = [{"text": "Footer example", "depth": 0}, {"text": "Independent body content", "depth": 1}]
        for stamp in ("待发布", "2026.11.19 22:30"):
            result = adapter.prepare(nodes, stamp)
            blocks = json.loads(result["format"])["blocks"]
            self.assertEqual(blocks[-2], {"kind": "gap", "depth": 0})
            self.assertEqual(blocks[-1], {"kind": "paragraph", "depth": 0, "text": "首次发布时间：" + stamp.replace(" ", "")})
            self.assertEqual(sum(b["kind"] == "gap" for b in blocks), 1)
        with self.assertRaisesRegex(ValueError, "publication_time_invalid"):
            adapter.prepare(nodes, "tomorrow")

    def snapshot(self, age=0):
        return json.dumps({
            "schema": "local.chrome-cookie-snapshot", "schemaVersion": 1,
            "generatedAt": datetime.fromtimestamp(time.time() - age, timezone.utc).isoformat(),
            "cookies": [
                {"name": name, "value": "synthetic", "domain": ".zhihu.com", "path": "/"}
                for name in ("z_c0", "_xsrf", "d_c0")
            ] + [{"name": "private", "value": "never-send", "domain": ".example.com", "path": "/"}],
        })

    def test_independent_outline_keeps_nested_lists_links_and_multiline(self):
        prepared = adapter.prepare([
            {"text": "A & B", "depth": 0},
            {"text": "**First** [source](https://example.com)", "depth": 1},
            {"text": "Nested detail\nsecond line", "depth": 2},
            {"text": "Last", "depth": 1},
        ])
        self.assertEqual(prepared["title"], "A & B")
        self.assertEqual(prepared["html"].count("<ul>"), 2)
        self.assertIn("<strong>First</strong>", prepared["html"])
        self.assertIn('href="https://example.com"', prepared["html"])
        self.assertEqual(prepared["text"], "FirstsourceNesteddetailsecondlineLast")
        self.assertIn("+strong", prepared["format"])

    def test_source_html_never_becomes_executable(self):
        html = adapter.prepare([{"text": "A title", "depth": 0}, {"text": '<script>alert("test")</script>', "depth": 1}])["html"]
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_only_matching_cookie_domains_are_loaded_and_redirects_are_disabled(self):
        with patch.object(Path, "read_text", return_value=self.snapshot()):
            client = adapter.load_client("synthetic.json")
        self.assertNotIn("private", [cookie.name for cookie in client._session.cookies])
        with self.assertRaisesRegex(ValueError, "host_blocked"):
            client._session.request("GET", "https://example.com/")
        client.close()

    def test_stale_snapshot_cannot_reuse_logged_out_or_disconnected_auth(self):
        with patch.object(Path, "read_text", return_value=self.snapshot(age=1000)):
            with self.assertRaisesRegex(ValueError, "stale"):
                adapter.load_client("synthetic.json")

    def test_empty_snapshot_cannot_reuse_old_cookies(self):
        snapshot = json.loads(self.snapshot())
        snapshot["cookies"] = []
        with patch.object(Path, "read_text", return_value=json.dumps(snapshot)):
            with self.assertRaisesRegex(ValueError, "missing"):
                adapter.load_client("synthetic.json")

    def test_account_switch_prevents_post(self):
        client = MagicMock()
        client.__enter__.return_value = client
        client.get_self_info.return_value = {"id": "new", "url_token": "new"}
        with patch.object(adapter, "load_client", return_value=client):
            with self.assertRaisesRegex(ValueError, "account_changed"):
                adapter.main({"action": "publish", "snapshotPath": "synthetic", "expectedAccountId": "old", "title": "A title", "html": "body"})
        client.create_article.assert_not_called()

    def test_article_id_requires_a_concrete_id(self):
        self.assertEqual(adapter.article_id_from_result({"id": "123"}), "123")
        self.assertEqual(adapter.article_id_from_result({"url": "https://zhuanlan.zhihu.com/p/456"}), "456")
        with self.assertRaisesRegex(ValueError, "missing"):
            adapter.article_id_from_result({"code": 0})

    def test_public_readback_contains_author_and_visible_text(self):
        client = MagicMock()
        client._get.return_value = {"id": "123", "title": "A title", "state": "published", "author": {"id": "me"}, "content": "<p>One &amp; two</p>"}
        result = adapter.read_article(client, "123")
        self.assertEqual(result["text"], "One&two")
        self.assertEqual(result["authorId"], "me")
        self.assertEqual(result["columnIds"], [])
        self.assertEqual(json.loads(result["format"])["blocks"], [{"kind": "paragraph", "depth": 0, "text": "One&two"}])
        client._get.return_value["state"] = "draft"
        with patch.object(adapter.time, "sleep"), self.assertRaisesRegex(ValueError, "not_published"):
            adapter.read_article(client, "123")

    def test_platform_link_wrapper_preserves_exact_target_and_cannot_hide_changed_links(self):
        direct = '<p><a href="https://example.com/page?q=1&amp;x=2">Reference</a></p>'
        wrapped = '<p><a href="https://link.zhihu.com/?target=https%3A%2F%2Fexample.com%2Fpage%3Fq%3D1%26x%3D2">Reference</a></p>'
        self.assertEqual(adapter.format_structure(direct), adapter.format_structure(wrapped))
        self.assertNotEqual(adapter.format_structure(direct), adapter.format_structure(wrapped.replace('example.com', 'different.example')))

    def test_public_visibility_retry_is_read_only(self):
        client = MagicMock()
        client._get.side_effect = [{"state": "draft"}, {"id": "123", "state": "published", "content": "<p>Independent public body</p>"}]
        with patch.object(adapter.time, "sleep") as sleep:
            self.assertEqual(adapter.read_article(client, "123")["id"], "123")
        sleep.assert_called_once_with(2)
        self.assertEqual(client._get.call_count, 2)
        client._session.post.assert_not_called()

    def test_title_and_body_limits_never_truncate_or_generate_content(self):
        for nodes in (
            [{"text": "Title\nother line", "depth": 0}, {"text": "Long enough body", "depth": 1}],
            [{"text": "Title", "depth": 0}],
            [{"text": "Title", "depth": 0}, {"text": "Short", "depth": 1}],
            [{"text": "T" * 101, "depth": 0}, {"text": "Long enough body", "depth": 1}],
        ):
            with self.assertRaises(ValueError):
                adapter.prepare(nodes)

    def test_format_comparison_preserves_hierarchy_and_links(self):
        nested = "<ul><li>A<ul><li>B</li></ul></li></ul>"
        flat = "<ul><li>A</li><li>B</li></ul>"
        self.assertNotEqual(adapter.format_structure(nested), adapter.format_structure(flat))
        self.assertEqual(adapter.format_structure("<b>Strong</b>"), adapter.format_structure("<strong>Strong</strong>"))
        self.assertNotEqual(adapter.format_structure('<a href="https://one.example">link</a>'), adapter.format_structure('<a href="https://two.example">link</a>'))
        with self.assertRaisesRegex(ValueError, "link_unsupported"):
            adapter.prepare([{"text": "A title", "depth": 0}, {"text": "A relative [source](../local.md) with text", "depth": 1}])

    def test_pinned_upstream_article_client_full_sequence_without_network(self):
        client = ZhihuClient({})
        calls = []
        cloud = {"id": "789", "state": "draft", "author": {"id": "me"}, "title": "", "content": ""}

        def respond(method, url, **kwargs):
            calls.append((method.upper(), url))
            if url.endswith("/me"):
                data = {"id": "me", "url_token": "synthetic"}
            elif "/columns/" in url:
                data = {"id": "synthetic-column", "url_token": "synthetic-column", "can_manage": True}
            elif url.endswith("/articles/drafts"):
                data = {"id": "789"}
            elif url.endswith("/articles/789"):
                data = dict(cloud)
            elif url.endswith("/draft") and method.upper() == "PATCH":
                self.assertEqual(kwargs["json"], {"title": "A title", "content": "<p>Independent body</p>", "table_of_contents": False})
                cloud.update(kwargs["json"])
                data = dict(cloud)
            elif url.endswith("/draft"):
                data = dict(cloud)
            elif url.endswith("/content/publish"):
                self.assertEqual(method.upper(), "POST")
                self.assertEqual(kwargs["json"]["action"], "article")
                payload = kwargs["json"]["data"]
                self.assertEqual(payload["column"], {"column": ["synthetic-column"]})
                self.assertEqual(payload["draft"], {"disabled": 1, "id": "789", "isPublished": False})
                self.assertEqual(payload["hybrid"]["html"], "<p>Independent body</p>")
                data = {"code": 0, "data": {"result": json.dumps({"publish": {"id": "789"}})}}
            else:
                self.fail("unexpected upstream request")
            result = MagicMock()
            result.status_code = 200
            result.json.return_value = data
            return result

        with patch.object(adapter, "load_client", return_value=client), patch.object(client._session, "request", side_effect=respond):
            result = adapter.main({"action": "publish", "snapshotPath": "synthetic", "expectedAccountId": "me", "title": "A title", "html": "<p>Independent body</p>", "columnId": "synthetic-column"})
        self.assertEqual(result, {"id": "789"})
        self.assertEqual([method for method, _ in calls if method != "GET"], ["POST", "PATCH", "POST"])
        self.assertEqual(sum(url.endswith('/articles/drafts') for _, url in calls), 1)
        self.assertNotIn("PUT", [method for method, _ in calls])
        self.assertTrue(all("/pin" not in url for _, url in calls))

    def test_only_accepted_columns_count_as_membership(self):
        client = MagicMock()
        client._get.return_value = {"id": "12", "title": "Title", "state": "published", "content": "<p>Published body</p>",
            "contributions": [{"state": "accepted", "column": {"url_token": "accepted-column"}}, {"state": "pending", "column": {"url_token": "pending-column"}}]}
        self.assertEqual(adapter.read_article(client, "12")["columnIds"], ["accepted-column"])

    def test_unmanageable_column_blocks_all_article_mutations(self):
        client = MagicMock()
        client._get.return_value = {"url_token": "column", "can_manage": False}
        with self.assertRaisesRegex(ValueError, "not_manageable"):
            adapter.publish_in_column(client, "Title", "<p>Body text</p>", "column")
        client.create_article.assert_not_called()

    def test_series_stats_uses_published_column_members_not_drafts(self):
        client = MagicMock()
        client._get.side_effect = [
            {"url_token": "column", "can_manage": True}, {"articles_count": 2},
            [{"id": "1", "title": "First（第1 篇 | day 1）"}, {"id": "2", "title": "Latest（第4 篇 | day 2）"}],
        ]
        self.assertEqual(adapter.series_stats(client, "column"), {"publishedCount": 2, "maxOrdinal": 4})

    def test_cloud_draft_roundtrip_only_creates_and_saves_never_publishes(self):
        client = ZhihuClient({})
        cloud = {"id": "666", "state": "draft", "author": {"id": "me"}, "title": "", "content": ""}
        methods = []

        def request(method, url, **kwargs):
            methods.append(method.upper())
            response = MagicMock()
            response.status_code = 200
            if method.upper() == "POST":
                self.assertTrue(url.endswith("/articles/drafts"))
                data = {"id": "666"}
            elif method.upper() == "PATCH":
                self.assertTrue(url.endswith("/666/draft"))
                cloud.update(kwargs["json"])
                cloud["content"] = kwargs["json"]["content"]
                data = dict(cloud)
            elif method.upper() == "GET":
                data = dict(cloud)
            else:
                self.fail("draft verification must not publish")
            response.json.return_value = data
            return response

        with patch.object(client._session, "request", side_effect=request):
            self.assertEqual(adapter.create_draft(client), {"id": "666"})
            before = adapter.read_draft(client, "666")
            saved = adapter.write_draft(client, "666", "Draft（第2 篇 | day 2）", "<ul><li>Complete draft content</li></ul>", "me", before)
            self.assertEqual(saved["state"], "draft")
            self.assertEqual(saved["title"], "Draft（第2 篇 | day 2）")
            self.assertEqual(saved["editorUrl"], "https://zhuanlan.zhihu.com/p/666/edit")
            cloud["content"] = "<p>Author edited this</p>"
            with self.assertRaisesRegex(ValueError, "cloud_draft_edited"):
                adapter.write_draft(client, "666", "Overwrite", "<p>Other content</p>", "me", saved)
        self.assertEqual(methods.count("POST"), 1)
        self.assertEqual(methods.count("PATCH"), 1)
        self.assertNotIn("PUT", methods)

    def test_persisted_draft_route_precedes_public_fallback(self):
        client = MagicMock()
        client._session.get.return_value.status_code = 404
        client._get.return_value = {"id": "666", "state": "draft", "author": {"id": "me"}, "title": "", "content": ""}
        self.assertEqual(adapter.read_draft(client, "666")["state"], "draft")
        client._session.get.assert_called_once_with("https://zhuanlan.zhihu.com/api/articles/666/draft", timeout=15)
        client._get.assert_called_once_with("https://zhuanlan.zhihu.com/api/articles/666")

    def test_approved_saved_draft_reuses_identity_and_publishes_in_column(self):
        client = ZhihuClient({})
        cloud = {"id": "666", "state": "draft", "author": {"id": "me"}, "title": "Earlier title", "content": "<p>Complete old body</p>"}
        calls = []

        def request(method, url, **kwargs):
            calls.append((method.upper(), url))
            response = MagicMock()
            response.status_code = 200
            if "/columns/" in url:
                data = {"url_token": "column", "can_manage": True}
            elif method.upper() == "PATCH":
                self.assertTrue(url.endswith("/666/draft"))
                cloud.update(kwargs["json"])
                data = dict(cloud)
            elif method.upper() == "POST":
                self.assertTrue(url.endswith("/api/v4/content/publish"))
                self.assertEqual(kwargs["json"]["data"]["column"], {"column": ["column"]})
                self.assertEqual(kwargs["json"]["data"]["draft"]["id"], "666")
                data = {"code": 0, "data": {"result": json.dumps({"publish": {"id": "666"}})}}
            elif method.upper() == "GET":
                data = dict(cloud)
            else:
                self.fail("must reuse approved draft without creating a second draft")
            response.json.return_value = data
            return response

        with patch.object(client._session, "request", side_effect=request):
            before = adapter.read_draft(client, "666")
            result = adapter.publish_saved_draft(client, "666", "Final title", "<ul><li>Complete new body</li></ul>", "column", "me", before)
        self.assertEqual(result, {"id": "666"})
        self.assertFalse(any(url.endswith('/articles/drafts') for _, url in calls))
        self.assertEqual(sum(method == "POST" for method, _ in calls), 1)
        self.assertFalse(any(method == "PUT" for method, _ in calls))


class LayoutTests(unittest.TestCase):
    def prepare(self, rows):
        return adapter.prepare([{"depth": 0, "text": "Independent title"}] + [{"depth": depth, "text": text} for depth, text in rows])

    def blocks(self, result):
        return json.loads(result["format"])["blocks"]

    def test_empty_editor_edges_are_omitted_and_inner_blank_is_a_paragraph(self):
        result = self.prepare([(1, ""), (1, "First section"), (1, ""), (1, "Second section"), (1, ""), (1, " ")])
        self.assertEqual([block["kind"] for block in self.blocks(result)], ["item", "gap", "item"])
        self.assertEqual(result["html"].count('class="ztext-empty-paragraph"'), 1)
        self.assertNotIn("<li></li>", result["html"])

    def test_consecutive_authored_blank_nodes_remain_separate(self):
        result = self.prepare([(1, "First section"), (1, ""), (1, ""), (1, "Next section")])
        self.assertEqual([block["kind"] for block in self.blocks(result)], ["item", "gap", "gap", "item"])

    def test_nested_separator_keeps_the_children_at_the_original_depth(self):
        result = self.prepare([(1, "Parent item"), (2, "First detail"), (2, ""), (2, "Second detail"), (1, "Sibling item")])
        self.assertEqual([(block["kind"], block["depth"]) for block in self.blocks(result)], [("item", 1), ("item", 2), ("gap", 0), ("item", 2), ("item", 1)])

    def test_node_internal_single_and_double_newlines_are_visible_breaks(self):
        result = self.prepare([(1, "First line\nSecond line\n\nThird line")])
        self.assertEqual(self.blocks(result)[0]["text"], "Firstline\nSecondline\n\nThirdline")
        self.assertEqual(len(re.findall(r"<br\s*/?>", result["html"])), 3)

    def test_readback_rejects_missing_newline_even_when_all_words_match(self):
        first = "<ul><li>First<br>Second text</li></ul>"
        second = "<ul><li>First Second text</li></ul>"
        self.assertEqual(adapter.normalize(first), adapter.normalize(second))
        self.assertNotEqual(adapter.format_structure(first), adapter.format_structure(second))

    def test_readback_accepts_zhihu_reparenting_lists_and_b_tag_normalization(self):
        valid = "<ul><li><p>Parent <strong>bold</strong></p><ul><li>Child detail</li></ul></li></ul>"
        native = '<ul><li data-pid="opaque">Parent <b>bold</b></li><ul><li>Child detail</li></ul></ul>'
        self.assertEqual(adapter.format_structure(valid), adapter.format_structure(native))

    def test_zhihu_importer_input_closes_each_item_before_its_child_list(self):
        # A conventional nested <li><ul> imports with phantom empty blocks in
        # the real editor. An outline return must close only the child <ul>.
        result = self.prepare([(1, "Parent section"), (2, "First child"), (3, "Deep detail"),
                               (2, "Second child"), (1, ""), (1, "Last section")])
        self.assertEqual(result["html"], '<ul><li>Parent section</li><ul><li>First child</li><ul><li>Deep detail</li></ul><li>Second child</li></ul></ul><p class="ztext-empty-paragraph"><br/></p><ul><li>Last section</li></ul>')
        self.assertEqual([(block["kind"], block["depth"]) for block in self.blocks(result)],
                         [("item", 1), ("item", 2), ("item", 3), ("item", 2), ("gap", 0), ("item", 1)])

    def test_style_offsets_are_visible_text_offsets_not_html_parser_columns(self):
        wrapped = "<ul>\n<li>Earlier text</li>\n<li><strong>Bold</strong></li></ul>"
        compact = "<ul><li>Earlier text</li><li><b>Bold</b></li></ul>"
        self.assertEqual(adapter.format_structure(wrapped), adapter.format_structure(compact))

    def test_blank_structural_container_keeps_descendants_without_empty_bullet(self):
        result = self.prepare([(1, ""), (2, "A complete nested detail")])
        self.assertEqual(self.blocks(result), [{"kind": "item", "depth": 2, "list": "ul", "text": "Acompletenesteddetail"}])
        self.assertNotIn("<li></li>", result["html"])

    def test_trailing_editor_padding_does_not_add_blank_lines(self):
        rows = [(1, "Parent section"), (2, "Last nested detail")]
        plain = self.prepare(rows)
        padded = self.prepare(rows + [(2, ""), (1, ""), (1, "")])
        self.assertEqual(plain, padded)
        self.assertEqual(self.blocks(plain)[-1]["text"], "Lastnesteddetail")
        self.assertFalse(any(block["kind"] == "gap" for block in self.blocks(plain)))
        self.assertNotIn('&nbsp;', plain["html"])
        self.assertEqual(adapter.normalize(plain["html"]), 'ParentsectionLastnesteddetail')

    def test_wrong_list_depth_and_wrong_blank_position_are_not_equivalent(self):
        one = '<ul><li>First</li></ul><p class="ztext-empty-paragraph"><br></p><ul><li>Second</li></ul>'
        two = '<ul><li>First</li><ul><li>Second</li></ul></ul><p><br></p>'
        self.assertEqual(adapter.normalize(one), adapter.normalize(two))
        self.assertNotEqual(adapter.format_structure(one), adapter.format_structure(two))


if __name__ == "__main__":
    unittest.main()
