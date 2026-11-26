"""Render standalone RemNote Mermaid nodes for the Zhihu article editor."""

import hashlib
import json
import os
import re
import subprocess
from html import escape
from pathlib import Path
from urllib.parse import urlsplit


DIAGRAM_START = re.compile(
    r"^(?:(?:flowchart|graph)(?:\s+(?:TB|TD|BT|RL|LR))?|sequenceDiagram|classDiagram(?:-v2)?|"
    r"stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie(?:\s+showData)?|quadrantChart|"
    r"requirementDiagram|gitGraph|mindmap|timeline|sankey-beta|xychart(?:-beta)?|"
    r"block(?:-beta)?|packet(?:-beta)?|kanban|architecture-beta|radar-beta|treemap(?:-beta)?)\b"
)
FENCED = re.compile(r"\A```mermaid[ \t]*\n(.*?)\n[ \t]*```[ \t]*\Z", re.I | re.S)
IMAGE_FILENAME = re.compile(r"\A((?:v2-)?[a-f0-9]{32})(?:_(?:[0-9]+w|[a-z]+|[0-9]+x[0-9]+)|~resize:[0-9]+:q[0-9]+)?\.[a-z0-9]+\Z")
DIAGRAM_LAYOUT_VERSION = 2


def diagram_source(node):
    runs = node.get("richText")
    source = node["text"] if runs is None else "".join(run.get("text", "") for run in runs if "text" in run)
    source = source.replace("\r\n", "\n").replace("\r", "\n").strip()
    fenced = FENCED.fullmatch(source)
    if fenced:
        source = fenced[1].strip()
    if runs and len(runs) > 1 and runs[0] == {"text": "-", "code": True}:
        source = re.sub(r"\A-mermaid[ \t]*\n", "", source, count=1).strip()
    if fenced or (DIAGRAM_START.fullmatch(source.split("\n", 1)[0].strip()) and "\n" in source):
        if runs and any(set(run) - {"text", "code"} for run in runs):
            raise ValueError("article_mermaid_mixed_format_unsupported")
        return source
    if re.search(r"(?im)^\s*```mermaid\b", source):
        raise ValueError("article_mermaid_mixed_format_unsupported")
    return None


def image_identity(url):
    parsed = urlsplit(url)
    basename = parsed.path.rsplit("/", 1)[-1]
    if parsed.scheme == "file" and not parsed.netloc and re.fullmatch(r"[a-f0-9]{64}\.png", basename):
        return basename
    if parsed.scheme != "https" or (parsed.netloc != "pic-private.zhihu.com" and not re.fullmatch(r"pic[a-z0-9]*\.zhimg\.com", parsed.netloc)):
        raise ValueError("article_image_host_unsupported")
    key = IMAGE_FILENAME.fullmatch(basename)
    if not key:
        raise ValueError("article_image_identity_invalid")
    return key[1]


def image_html(info):
    image_identity(info["src"])
    attributes = {"src": info["src"], "alt": "Mermaid 图", "data-size": "normal", "data-caption": ""}
    for key, native in (("width", "data-rawwidth"), ("height", "data-rawheight")):
        if info.get(key):
            attributes[native] = str(int(info[key]))
    for key, native in (("original_src", "data-original-src"), ("watermark_src", "data-watermark-src")):
        if info.get(key):
            image_identity(info[key])
            attributes[native] = info[key]
    if info.get("watermark"):
        attributes["data-watermark"] = str(info["watermark"])
    return "<figure><img " + " ".join(f'{key}="{escape(value, quote=True)}"' for key, value in attributes.items()) + "/></figure>"


def diagram_images(nodes, runtime, mode, upload, read):
    sources = [(node["remId"], source) for node in nodes[1:] if (source := diagram_source(node)) is not None]
    if not sources:
        return {}
    if not runtime:
        raise ValueError("article_mermaid_renderer_not_configured")
    if len(sources) > 30 or any(not source or len(source) > 16000 for _, source in sources):
        raise ValueError("article_mermaid_size_unsupported")
    cache = Path(runtime["cache"])
    cache.mkdir(parents=True, exist_ok=True)
    result = {}
    versions = [runtime["mermaidVersion"], runtime["playwrightVersion"]]
    for rem_id, diagram in sources:
        key = hashlib.sha256(json.dumps([DIAGRAM_LAYOUT_VERSION, versions, diagram], ensure_ascii=False).encode()).hexdigest()
        png = cache / (key + ".png")
        metadata = cache / (key + ".json")
        if mode != "local" and metadata.is_file():
            saved = json.loads(metadata.read_text(encoding="utf-8"))
            info = read(saved["imageId"])
            if image_identity(info["src"]) != saved["identity"]:
                raise ValueError("article_image_identity_changed")
            result[rem_id] = image_html({**info, "width": saved["width"], "height": saved["height"]})
            continue
        if mode == "cache":
            raise ValueError("article_mermaid_media_not_frozen")
        if not png.is_file():
            temp = cache / (key + f".{os.getpid()}.png")
            try:
                request = {**runtime, "diagram": diagram, "output": str(temp)}
                subprocess.run([runtime["node"], str(Path(__file__).with_name("zhihu-diagram-render.mjs"))],
                               input=json.dumps(request).encode(), stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=40, check=True,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                temp.replace(png)
            except (OSError, subprocess.SubprocessError) as error:
                raise ValueError("article_mermaid_render_failed") from error
            finally:
                temp.unlink(missing_ok=True)
        if mode == "local":
            info = {"src": png.as_uri()}
        else:
            info = upload(str(png))
            image_html(info)  # Cache only verified media identities.
            saved = {k: info[k] for k in ("imageId", "width", "height")}
            saved["identity"] = image_identity(info["src"])
            temp = cache / (key + f".{os.getpid()}.json")
            temp.write_text(json.dumps(saved), encoding="utf-8")
            temp.replace(metadata)
        result[rem_id] = image_html(info)
    return result
