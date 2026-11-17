"""Keep native lists within the editor limit; represent deeper children as indented lines."""

from dataclasses import dataclass, field
from html.parser import HTMLParser


VOID = {"br", "img", "hr", "input", "meta", "link", "wbr", "source", "area", "base", "embed", "param", "track", "col"}


@dataclass
class Element:
    tag: str
    start: str = ""
    children: list = field(default_factory=list)


class OutlineTree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.root = Element("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Element(tag, self.get_starttag_text())
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Element(tag, self.get_starttag_text()))

    def handle_endtag(self, tag):
        if len(self.stack) <= 1 or self.stack[-1].tag != tag:
            raise ValueError("article_hierarchy_overflow_unbalanced")
        self.stack.pop()

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def handle_entityref(self, name):
        self.stack[-1].children.append("&" + name + ";")

    def handle_charref(self, name):
        self.stack[-1].children.append("&#" + name + ";")


def serialize(node):
    if isinstance(node, str):
        return node
    content = "".join(map(serialize, node.children))
    if node.tag == "root":
        return content
    return node.start + content + ("" if node.tag in VOID else "</" + node.tag + ">")


def overflow_spaces(source_html, limit=5):
    """Only overflow lines change; inline markup remains native and byte-preserved.

    Each extra level starts with two ideographic spaces and a solid bullet.
    Automatic wrapped lines intentionally return to the native parent indent.
    Unsupported orphan/block arrangements remain blocked instead of losing data.
    """
    parser = OutlineTree()
    parser.feed(source_html)
    parser.close()
    if len(parser.stack) != 1:
        raise ValueError("article_hierarchy_overflow_unbalanced")

    def overflow(group, extra):
        result = []
        for item in group.children:
            if isinstance(item, str):
                if item.strip():
                    raise ValueError("article_hierarchy_overflow_text_outside_item")
                continue
            if item.tag in ("ul", "ol"):
                result.extend(overflow(item, extra + 1))
                continue
            if item.tag != "li":
                raise ValueError("article_hierarchy_overflow_block_unsupported")
            body, nested = [], []
            for part in item.children:
                if isinstance(part, Element) and part.tag in ("ul", "ol"):
                    nested.extend(overflow(part, extra + 1))
                else:
                    if nested:
                        raise ValueError("article_hierarchy_overflow_text_after_children")
                    body.append(part)
            result.extend([Element("br", "<br/>"), "\u3000" * (2 * extra) + "• ", *body, *nested])
        return result

    def walk(container, depth):
        result = []
        for node in container.children:
            if isinstance(node, str):
                result.append(node)
                continue
            next_depth = depth + (1 if node.tag in ("ul", "ol") else 0)
            if node.tag in ("ul", "ol") and next_depth > limit:
                if container.tag == "li":
                    result.extend(overflow(node, 1))
                elif result and isinstance(result[-1], Element) and result[-1].tag == "li":
                    result[-1].children.extend(overflow(node, 1))
                else:
                    raise ValueError("article_hierarchy_overflow_parent_missing")
            else:
                walk(node, next_depth)
                result.append(node)
        container.children = result

    walk(parser.root, 0)
    return serialize(parser.root)
