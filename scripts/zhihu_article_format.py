"""Lossless outline layout for Zhihu articles, independent of live account data."""

import json
import re
from html import escape, unescape
from html.parser import HTMLParser
from urllib.parse import quote, parse_qs, urlparse

from markdown_it import MarkdownIt
from zhihu_outline_overflow import overflow_spaces


def compact(text):
    return re.sub(r"[ \t\r\n\f\v]+", "", text)


def canonical_link(href):
    url = urlparse(href)
    if url.scheme == "https" and url.hostname == "link.zhihu.com" and url.path in ("", "/") and not url.fragment:
        query = parse_qs(url.query)
        if set(query) == {"target"} and len(query["target"]) == 1:
            target = query["target"][0]
            parsed = urlparse(target)
            if parsed.scheme in ("http", "https") and parsed.hostname and not parsed.username and not parsed.password:
                return target
    return href


MENTION = re.compile(r"(?<![A-Za-z0-9_.+\-/])@([^\s@,，。！？!?、:：;；（）()\[\]<>“”\"'…]+)")


def mention_html(name, member_id):
    if not re.fullmatch(r"[a-f0-9]{32}", member_id):
        raise ValueError("mention_identity_invalid")
    return ('<a class="member_mention" href="https://www.zhihu.com/people/' + member_id
            + '" data-hash="' + member_id + '" data-hovercard="p$b$' + member_id + '">@'
            + escape(name) + '</a>')


class MentionText(HTMLParser):
    """Transform prose mentions only; never reinterpret links, code or math."""
    VOID = {"br", "img", "hr", "input", "meta", "link"}
    INLINE = {"strong", "b", "em", "i", "span", "u", "s", "del", "sub", "sup"}

    def __init__(self, bindings=None):
        super().__init__(convert_charrefs=True)
        self.parts, self.tags, self.names, self.prose = [], [], set(), []
        self.bindings = bindings

    def flush_prose(self):
        for match in MENTION.finditer("".join(self.prose)):
            name = match[1].rstrip('.')
            if name:
                self.names.add(name)
        self.prose = []

    def handle_starttag(self, tag, attrs):
        if tag not in self.INLINE:
            self.flush_prose()
        self.parts.append(self.get_starttag_text())
        if tag not in self.VOID:
            self.tags.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.flush_prose()
        self.parts.append(self.get_starttag_text())

    def handle_endtag(self, tag):
        if tag not in self.INLINE:
            self.flush_prose()
        self.parts.append('</' + tag + '>')
        if self.tags and self.tags[-1] == tag:
            self.tags.pop()

    def handle_data(self, data):
        if any(tag in ("a", "code", "pre", "script", "style") for tag in self.tags):
            self.parts.append(escape(data))
            return
        if self.bindings is None:
            self.prose.append(data)
            self.parts.append(escape(data))
            return
        start = 0
        for match in MENTION.finditer(data):
            name = match[1].rstrip('.')
            if not name:
                continue
            end = match.start(1) + len(name)
            self.names.add(name)
            self.parts.append(escape(data[start:match.start()]))
            member_id = self.bindings.get(name)
            if not member_id:
                raise ValueError("mention_unresolved")
            self.parts.append(mention_html(name, member_id))
            start = end
        self.parts.append(escape(data[start:]))


def mention_names(html):
    parser = MentionText()
    parser.feed(html)
    parser.flush_prose()
    return sorted(parser.names)


def apply_mentions(html, bindings):
    parser = MentionText({item["name"]: item["id"] for item in bindings})
    parser.feed(html)
    result = "".join(parser.parts)
    if mention_names(result):
        raise ValueError("mention_split_format_unsupported")
    return result


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
    return equation_html(token.content, token.meta["mode"])


def equation_html(tex, mode):
    return ('<img eeimg="' + mode + '" src="//www.zhihu.com/equation?tex='
            + quote(tex, safe="") + '" alt="' + escape(tex, quote=True) + '"/>')


def native_html(runs, refs):
    result = []
    for run in runs:
        if "text" in run:
            text = run["text"]
            for ref in refs:
                text = text.replace("[[" + ref["text"] + "]]", ref["text"])
            if re.search(r"\[\[[^\]]+\]\]", text):
                raise ValueError("article_native_reference_unresolved")
            html = escape(text).replace("\r\n", "\n").replace("\n", "<br/>")
            for mark, tag in (("code", "code"), ("italic", "em"), ("bold", "strong"), ("underline", "u")):
                if run.get(mark):
                    html = "<" + tag + ">" + html + "</" + tag + ">"
            result.append(html)
        elif run.get("type") == "math":
            result.append(equation_html(run["tex"], "2" if run["display"] else "1"))
        elif run.get("type") == "link":
            result.append('<a href="' + escape(run["url"], quote=True) + '">' + native_html(run["children"], refs) + '</a>')
        else:
            raise ValueError("article_native_element_unsupported")
    return "".join(result)


def card_url(href):
    parsed = urlparse(canonical_link(href))
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("article_link_card_target_invalid")
    return canonical_link(href)


def card_html(href, title):
    return ('<a href="' + escape(card_url(href), quote=True)
            + '" data-draft-node="block" data-draft-type="link-card" data-text="'
            + escape(title, quote=True) + '" data-draft-title="' + escape(title, quote=True)
            + '" data-draft-cover="">' + escape(title) + '</a>')


class StandaloneLink(HTMLParser):
    """Only a leaf with one whole link and an optional short colon label qualifies."""
    def __init__(self):
        super().__init__()
        self.stack, self.before, self.title, self.after = [], [], [], []
        self.href = None
        self.inside = False
        self.valid = True

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag not in ("a", "strong", "b", "em", "i", "span", "u", "s", "del"):
            self.valid = False
        if tag == "a":
            if self.href is not None or self.stack or "member_mention" in attributes.get("class", "").split():
                self.valid = False
            self.href, self.inside = attributes.get("href", ""), True
        if tag == "u" and self.inside:
            # Card titles cannot retain an explicit underline; preserve the original link instead.
            self.valid = False
        self.stack.append(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack.pop() != tag:
            self.valid = False
        if tag == "a":
            self.inside = False

    def handle_data(self, data):
        (self.title if self.inside else self.before if self.href is None else self.after).append(data)


def standalone_card(body):
    parser = StandaloneLink()
    parser.feed(body)
    if not parser.valid or parser.stack:
        return None
    label = "".join(parser.before).strip()
    if parser.href is None:
        # Plain URLs are not autolinked by CommonMark. Do not reinterpret code or rich blocks.
        match = re.fullmatch(r"(?:(?P<label>[^:：\r\n.!?。！？<>]{1,20}[:：])\s*)?(?P<url>https?://[^\s<>]+)", unescape(body).strip())
        if not match:
            return None
        href, title, label = match["url"], match["url"], match["label"] or ""
        prefix = escape(label)
    else:
        if "".join(parser.after).strip() or (label and not re.fullmatch(r"[^:：\r\n.!?。！？<>]{1,20}[:：]", label)):
            return None
        href, title = parser.href, "".join(parser.title).strip()
        prefix = body[:body.index("<a")].strip()
    if not title:
        return None
    try:
        href = card_url(href)
    except ValueError:
        return None
    return ("<p>" + prefix + "</p>" if label else "") + card_html(href, title)


class CanonicalCards(HTMLParser):
    """Ignore hydrated card metadata, but retain the source title, target and native type."""
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.parts, self.card = [], None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if self.card is not None:
            self.card["rich"] = True
            if tag == "a":
                self.card["depth"] += 1
            return
        if attributes.get("data-draft-type") == "link-card" or "LinkCard" in attributes.get("class", "").split():
            if tag != "a" or (attributes.get("data-draft-node") != "block" and "LinkCard" not in attributes.get("class", "").split()):
                raise ValueError("article_link_card_block_invalid")
            self.card = {"attrs": attributes, "text": [], "depth": 1, "rich": False}
            return
        self.parts.append(self.get_starttag_text())

    def handle_endtag(self, tag):
        if self.card is not None:
            if tag == "a":
                self.card["depth"] -= 1
                if self.card["depth"] == 0:
                    attributes = self.card["attrs"]
                    title = attributes.get("data-text") or ("".join(self.card["text"]) if not self.card["rich"] else attributes.get("data-draft-title"))
                    if not title or not title.strip():
                        raise ValueError("article_link_card_title_missing")
                    self.parts.append(card_html(attributes.get("href", ""), title.strip()))
                    self.card = None
            return
        self.parts.append("</" + tag + ">")

    def handle_startendtag(self, tag, attrs):
        if self.card is not None:
            self.card["rich"] = True
        else:
            self.parts.append(self.get_starttag_text())

    def handle_data(self, data):
        (self.card["text"] if self.card is not None else self.parts).append(data)

    def handle_entityref(self, name):
        self.handle_data(unescape("&" + name + ";") if self.card is not None else "&" + name + ";")

    def handle_charref(self, name):
        self.handle_data(unescape("&#" + name + ";") if self.card is not None else "&#" + name + ";")


def canonical_cards(html):
    parser = CanonicalCards()
    parser.feed(html)
    if parser.card is not None:
        raise ValueError("article_link_card_incomplete")
    return "".join(parser.parts)


class LiftGaps(HTMLParser):
    """Native gaps and standalone cards must be outside every list container."""
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.parts, self.lists, self.in_gap, self.in_card = [], [], False, False

    def handle_starttag(self, tag, attrs):
        if tag == "div" and dict(attrs).get("data-outline-card") == "1":
            self.parts.extend("</" + item + ">" for item in reversed(self.lists))
            self.in_card = True
            return
        if tag == "p" and "ztext-empty-paragraph" in dict(attrs).get("class", ""):
            self.parts.extend("</" + item + ">" for item in reversed(self.lists))
            self.in_gap = True
        self.parts.append(self.get_starttag_text())
        if tag in ("ul", "ol"):
            self.lists.append(tag)

    def handle_endtag(self, tag):
        if tag == "div" and self.in_card:
            self.parts.extend("<" + item + ">" for item in self.lists)
            self.in_card = False
            return
        self.parts.append("</" + tag + ">")
        if tag in ("ul", "ol"):
            self.lists.pop()
        if tag == "p" and self.in_gap:
            self.parts.extend("<" + item + ">" for item in self.lists)
            self.in_gap = False

    def handle_startendtag(self, tag, attrs):
        self.parts.append(self.get_starttag_text())

    def handle_data(self, data):
        self.parts.append(data)

    def handle_entityref(self, name):
        self.parts.append("&" + name + ";")

    def handle_charref(self, name):
        self.parts.append("&#" + name + ";")


def normalize(html):
    parser = VisibleText()
    parser.feed(canonical_cards(html))
    return compact("".join(parser.parts))


class ArticleLayout(HTMLParser):
    """Compare visible layout, accepting both valid nested lists and Zhihu's list DOM."""
    INLINE = {"strong", "em", "u", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6"}

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
        self.card = None

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
        elif tag in ("p", "h1", "h2", "h3", "h4", "h5", "h6"):
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
            attributes = dict(attrs)
            href = canonical_link(attributes.get("href", ""))
            if attributes.get("data-draft-type") == "link-card":
                if self.lists or any(p["parts"] for p in self.paragraphs):
                    raise ValueError("article_link_card_block_invalid")
                self.card = {"kind": "card", "depth": 0, "href": card_url(href), "text": ""}
                self.events.append(self.card)
                self.styles.append(["card", href, self.visible_offset])
                for paragraph in self.paragraphs:
                    paragraph["card"] = True
            if "member_mention" in attributes.get("class", "").split():
                member_id = attributes.get("data-hash", "")
                parsed = urlparse(href)
                if not re.fullmatch(r"[a-f0-9]{32}", member_id) or parsed.scheme not in ("", "http", "https") or parsed.hostname != "www.zhihu.com" or parsed.username or parsed.password or parsed.path.rstrip('/') != "/people/" + member_id:
                    raise ValueError("mention_identity_invalid")
                href = "https://www.zhihu.com/people/" + member_id
                self.styles.append(["mention", member_id, self.visible_offset])
            self.links.append(href)
            self.styles.append(["+a", href, self.visible_offset])

    def handle_endtag(self, tag):
        tag = {"b": "strong", "i": "em"}.get(tag, tag)
        if tag in ("ul", "ol") and self.lists:
            self.lists.pop()
        elif tag == "li" and self.items:
            self.items.pop()
        elif tag in ("p", "h1", "h2", "h3", "h4", "h5", "h6") and self.paragraphs:
            paragraph = self.paragraphs.pop()
            value = "".join(paragraph["parts"])
            if paragraph.get("card") and not value:
                pass
            elif not value.strip("\n"):
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
            self.card = None

    def handle_data(self, data):
        # Formatting whitespace in HTML is not a visible newline; <br> is.
        value = data if self.pre_depth else compact(data)
        self.visible_offset += len(compact(data))
        if not value:
            return
        if self.card is not None:
            self.card["text"] += value
        elif self.paragraphs:
            self.paragraphs[-1]["parts"].append(value)
        elif self.items:
            self.items[-1]["text"] += value
        elif self.events and self.events[-1]["kind"] == "paragraph":
            self.events[-1]["text"] += value
        else:
            self.events.append({"kind": "paragraph", "depth": len(self.lists), "text": value})


def format_structure(html):
    parser = ArticleLayout()
    parser.feed(canonical_cards(html))
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
    parser.feed(native_html(nodes[0]["richText"], nodes[0].get("inlineRefs", [])) if "richText" in nodes[0] else md.renderInline(root_text))
    title = "".join(parser.parts)
    if "richText" in nodes[0]:
        title = re.sub(r"^\s*%(?!%)\s?", "", title, count=1)
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
        current = {"text": node["text"], "children": [], "ai": ai or stack[-1]["ai"], "ai_start": ai and not stack[-1]["ai"], "native": node.get("richText"), "refs": node.get("inlineRefs", [])}
        stack[-1]["children"].append(current)
        stack.append(current)

    def inline_or_blocks(text):
        tokens = md.parse(text)
        if all(token.type in ("paragraph_open", "inline", "paragraph_close") for token in tokens):
            html = md.renderInline(text)
            return html
        return md.renderer.render(tokens, md.options, {})

    def ai_badge():
        # A short native formula marks the range; prose remains editable text.
        return md.renderInline(r"$\color{#7040a0}{\text{AI}}$") + " "

    def render_level(children, headings=False):
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
                    result.append(("" if headings else "<ul>") + render_level(node["children"]) + ("" if headings else "</ul>"))
                else:
                    result.append('<p class="ztext-empty-paragraph"><br/></p>')
                continue
            # Zhihu's Draft.js importer synthesizes an empty block for every
            # closing parent <li> around a child list. Its native serializer
            # places the child <ul> after the closed <li>, at the same level.
            # Emit that representation so a hierarchy return is not a blank Rem.
            badge = ai_badge() if node["ai_start"] else ""
            body = native_html(node["native"], node["refs"]) if node["native"] is not None else inline_or_blocks(node["text"])
            card = standalone_card(body) if not node["children"] and "\n" not in node["text"] and "\r" not in node["text"] else None
            if card:
                flush()
                result.append('<div data-outline-card="1">' + ("<p>" + badge + "</p>" if badge else "") + card + '</div>')
                continue
            if headings:
                flush()
                result.append("<h2>" + badge + body + "</h2>" + render_level(node["children"]))
            else:
                items.append("<li>" + badge + body + "</li>" + render_level(node["children"]))
        flush()
        return "".join(result)

    max_depth = max(node["depth"] for node in nodes if node["text"].strip())
    headings = max_depth > 5
    html = ("<p>" + ai_badge() + "</p>" if root["ai"] else "") + render_level(root["children"], headings)
    gaps = LiftGaps()
    gaps.feed(html)
    html = "".join(gaps.parts)
    while re.search(r"<(ul|ol)>\s*</\1>", html):
        html = re.sub(r"<(ul|ol)>\s*</\1>", "", html)
    if max_depth > 6:
        html = overflow_spaces(html)
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
    return {"title": title, "html": html, "text": text, "format": format_structure(html), "hierarchyMode": "overflow-spaces" if max_depth > 6 else "section-headings" if headings else "lists"}
