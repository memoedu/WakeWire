"""Lossless outline layout for Zhihu articles, independent of live account data."""

import json
import re
from html import escape
from html.parser import HTMLParser
from urllib.parse import quote, parse_qs, urlparse

from markdown_it import MarkdownIt
from markdown_it.token import Token


def compact(text):
    return re.sub(r"[ \t\r\n\f\v]+", "", text)


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        formula = equation(tag, attrs)
        if formula:
            self.parts.append("$" + formula[1] + "$")


def equation(tag, attrs):
    """Read the first-party equation image, including LaTeX in text validation."""
    attrs = dict(attrs)
    if tag != "img" or attrs.get("eeimg") not in ("1", "2"):
        return None
    # The persisted draft endpoint sanitizes equation src to an empty string.
    # The editor still constructs the native formula entity from eeimg + alt
    # and renders it as MathJax SVG. LaTeX remains part of the comparison.
    if not attrs.get("src"):
        if not attrs.get("alt"):
            raise ValueError("article_equation_latex_missing")
        return attrs["eeimg"], attrs["alt"]
    src = urlparse(attrs.get("src", ""))
    if src.scheme not in ("", "https") or src.hostname != "www.zhihu.com" or src.path != "/equation":
        raise ValueError("article_equation_source_invalid")
    tex = parse_qs(src.query).get("tex", [None])[0]
    if not tex or attrs.get("alt") != tex:
        raise ValueError("article_equation_latex_mismatch")
    return attrs["eeimg"], tex


def math_inline(state, silent):
    start = state.pos
    if state.src[start] != "$":
        return False
    delimiter = "$$" if state.src.startswith("$$", start) else "$"
    content_start = start + len(delimiter)
    if content_start >= state.posMax or state.src[content_start].isspace():
        return False
    end = content_start
    while True:
        end = state.src.find(delimiter, end)
        if end < 0:
            return False
        slashes = len(state.src[:end]) - len(state.src[:end].rstrip("\\"))
        if slashes % 2 == 0:
            break
        end += len(delimiter)
    tex = state.src[content_start:end]
    if not tex or tex[-1].isspace() or (delimiter == "$" and "\n" in tex):
        return False
    if not silent:
        token = state.push("zhihu_math", "", 0)
        token.content = tex
        token.meta = {"mode": "2" if delimiter == "$$" else "1"}
    state.pos = end + len(delimiter)
    return True


def render_math(tokens, idx, options, env):
    token = tokens[idx]
    return ('<img eeimg="' + token.meta["mode"] + '" src="//www.zhihu.com/equation?tex='
            + quote(token.content, safe="") + '" alt="' + escape(token.content, quote=True) + '"/>')


def normalize(html):
    parser = VisibleText()
    parser.feed(html)
    return compact("".join(parser.parts))


class ArticleLayout(HTMLParser):
    """Compare visible layout, accepting both valid nested lists and Zhihu's list DOM."""
    INLINE = {"strong", "em", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.events = []
        self.lists = []
        self.items = []
        self.paragraphs = []
        self.styles = []
        self.links = []
        self.visible_offset = 0
        self.pre_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = {"b": "strong", "i": "em"}.get(tag, tag)
        formula = equation(tag, attrs)
        if formula:
            self.styles.append(["math", formula[0], formula[1], self.visible_offset])
            self.handle_data("$" + formula[1] + "$")
            return
        if tag in ("ul", "ol"):
            self.lists.append(tag)
        elif tag == "li":
            item = {"kind": "item", "depth": len(self.lists), "list": self.lists[-1] if self.lists else "none", "text": ""}
            self.events.append(item)
            self.items.append(item)
        elif tag == "p":
            self.paragraphs.append({"parts": [], "target": self.items[-1] if self.items else None, "depth": len(self.lists)})
        elif tag == "br":
            if self.paragraphs:
                self.paragraphs[-1]["parts"].append("\n")
            elif self.items:
                self.items[-1]["text"] += "\n"
            else:
                self.events.append({"kind": "gap", "depth": len(self.lists)})
        if tag in self.INLINE:
            self.styles.append(["+" + tag, self.visible_offset])
        if tag == "pre":
            self.pre_depth += 1
        if tag == "a":
            href = dict(attrs).get("href", "")
            self.links.append(href)
            self.styles.append(["+a", href, self.visible_offset])

    def handle_endtag(self, tag):
        tag = {"b": "strong", "i": "em"}.get(tag, tag)
        if tag in ("ul", "ol") and self.lists:
            self.lists.pop()
        elif tag == "li" and self.items:
            self.items.pop()
        elif tag == "p" and self.paragraphs:
            paragraph = self.paragraphs.pop()
            value = "".join(paragraph["parts"])
            if not value.strip("\n"):
                self.events.append({"kind": "gap", "depth": paragraph["depth"]})
            elif paragraph["target"] is not None:
                target = paragraph["target"]
                if target["text"]:
                    target["text"] += "\n\n"
                target["text"] += value
            else:
                self.events.append({"kind": "paragraph", "depth": paragraph["depth"], "text": value})
        if tag in self.INLINE:
            self.styles.append(["-" + tag, self.visible_offset])
        if tag == "pre":
            self.pre_depth -= 1
        if tag == "a":
            self.styles.append(["-a", self.visible_offset])

    def handle_data(self, data):
        # Formatting whitespace in HTML is not a visible newline; <br> is.
        value = data if self.pre_depth else compact(data)
        self.visible_offset += len(compact(data))
        if not value:
            return
        if self.paragraphs:
            self.paragraphs[-1]["parts"].append(value)
        elif self.items:
            self.items[-1]["text"] += value
        elif self.events and self.events[-1]["kind"] == "paragraph":
            self.events[-1]["text"] += value
        else:
            self.events.append({"kind": "paragraph", "depth": len(self.lists), "text": value})


def format_structure(html):
    parser = ArticleLayout()
    parser.feed(html)
    return json.dumps({"version": 2, "blocks": parser.events, "styles": parser.styles}, ensure_ascii=False)


def prepare(nodes, first_published_at=None, ai_generated_tag_rem_id=None):
    """Blank Rems are paragraph separators; real Rems are list items; LF stays LF."""
    md = MarkdownIt("commonmark", {"html": False, "breaks": True})
    md.inline.ruler.before("escape", "zhihu_math", math_inline)
    md.renderer.rules["zhihu_math"] = render_math
    root_text = nodes[0]["text"]
    if "\n" in root_text or "\r" in root_text:
        raise ValueError("article_title_multiline")
    parser = VisibleText()
    parser.feed(md.renderInline(root_text))
    title = "".join(parser.parts)
    if not title.strip() or len(title) > 100:
        raise ValueError("article_title_length")
    def tagged(node):
        return bool(ai_generated_tag_rem_id) and any(tag.get("tagRemId") == ai_generated_tag_rem_id for tag in node.get("tags", []))

    root = {"text": root_text, "children": [], "ai": tagged(nodes[0])}
    stack = [root]
    for node in nodes[1:]:
        depth = node["depth"]
        if not 1 <= depth <= len(stack):
            raise ValueError("article_outline_depth")
        del stack[depth:]
        ai = tagged(node)
        current = {"text": node["text"], "children": [], "ai": ai or stack[-1]["ai"], "ai_start": ai and not stack[-1]["ai"]}
        stack[-1]["children"].append(current)
        stack.append(current)

    def inline_or_blocks(text, ai=False):
        tokens = md.parse(text)
        if all(token.type in ("paragraph_open", "inline", "paragraph_close") for token in tokens):
            html = md.renderInline(text)
            return "<em>" + html + "</em>" if ai else html
        if ai:
            for token in tokens:
                if token.type == "inline":
                    token.children = [Token("em_open", "em", 1), *(token.children or []), Token("em_close", "em", -1)]
        return md.renderer.render(tokens, md.options, {})

    def ai_badge():
        # A short native formula marks the range; prose remains editable text.
        return md.renderInline(r"$\color{#7040a0}{\text{AI}}$") + " "

    def render_level(children):
        def visible(node):
            return bool(node["text"].strip()) or any(visible(child) for child in node["children"])

        # Empty editor placeholders at a sibling group's edges are not section separators.
        children = list(children)
        while children and not visible(children[0]):
            children.pop(0)
        while children and not visible(children[-1]):
            children.pop()
        result, items = [], []

        def flush():
            if items:
                result.append("<ul>" + "".join(items) + "</ul>")
                items.clear()

        for node in children:
            if not node["text"].strip():
                flush()
                if node["children"]:
                    # Preserve a blank structural container's depth, with no phantom bullet.
                    if node["ai_start"]:
                        result.append("<p>" + ai_badge() + "</p>")
                    result.append("<ul>" + render_level(node["children"]) + "</ul>")
                else:
                    result.append('<p class="ztext-empty-paragraph"><br/></p>')
                continue
            # Zhihu's Draft.js importer synthesizes an empty block for every
            # closing parent <li> around a child list. Its native serializer
            # places the child <ul> after the closed <li>, at the same level.
            # Emit that representation so a hierarchy return is not a blank Rem.
            badge = ai_badge() if node["ai_start"] else ""
            items.append("<li>" + badge + inline_or_blocks(node["text"], node["ai"]) + "</li>" + render_level(node["children"]))
        flush()
        return "".join(result)

    html = ("<p>" + ai_badge() + "</p>" if root["ai"] else "") + render_level(root["children"])
    text = normalize(html)
    if not 9 <= len(text) <= 100000:
        raise ValueError("article_body_length")
    if first_published_at is not None:
        if first_published_at != "待发布" and not re.fullmatch(r"\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}", first_published_at):
            raise ValueError("article_publication_time_invalid")
        html += '<p class="ztext-empty-paragraph"><br/></p><p>首次发布时间：' + first_published_at + '</p>'
        text = normalize(html)
        if len(text) > 100000:
            raise ValueError("article_body_length")
    return {"title": title, "html": html, "text": text, "format": format_structure(html)}
