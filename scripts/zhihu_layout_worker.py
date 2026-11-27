"""Compute Zhihu article layout from a frozen tree, locally or over trusted SSH."""
from functools import lru_cache
from importlib.metadata import version
from pathlib import Path, PurePosixPath
import hashlib
import json
import re
import shlex
import subprocess
import sys

from zhihu_article_format import prepare


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


@lru_cache(maxsize=1)
def formatter_id():
    directory = Path(__file__).parent
    names = ("zhihu_article_format.py", "zhihu_article_diagrams.py",
             "zhihu_outline_overflow.py", "zhihu_layout_worker.py")
    sources = [digest((directory / name).read_text(encoding="utf-8").encode()) for name in names]
    return digest(encoded([1, version("markdown-it-py"), version("mdurl"), *sources]))


def local_layout(payload):
    return prepare(payload["nodes"], payload["firstPublishedAt"],
                   payload["aiGeneratedTagRemId"], payload["diagrams"])


def serve(raw):
    payload = json.loads(raw)
    if set(payload) != {"nodes", "firstPublishedAt", "aiGeneratedTagRemId", "diagrams"}:
        raise ValueError("unexpected_layout_fields")
    layout = local_layout(payload)
    return {"inputSha256": digest(raw), "formatterId": formatter_id(),
            "layoutSha256": digest(encoded(layout)), "layout": layout}


def checked_command(worker):
    host = worker["host"]
    paths = (worker["python"], worker["script"])
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", host):
        raise ValueError("invalid_layout_host")
    if any(not PurePosixPath(p).is_absolute() or any(ord(c) < 32 for c in p) for p in paths):
        raise ValueError("invalid_layout_path")
    if PurePosixPath(worker["script"]).name != "zhihu_layout_worker.py":
        raise ValueError("invalid_layout_script")
    return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=6", host, shlex.join([paths[0], "-X", "utf8", paths[1]])]


def compute_layout(nodes, first_published_at, ai_tag, diagrams, worker=None):
    payload = {"nodes": nodes, "firstPublishedAt": first_published_at,
               "aiGeneratedTagRemId": ai_tag, "diagrams": diagrams}
    if worker is None:
        return local_layout(payload), None
    command = checked_command(worker)
    raw = encoded(payload)
    source = {"host": worker["host"], "inputSha256": digest(raw), "formatterId": formatter_id()}
    try:
        response = subprocess.run(command, input=raw, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  check=True, timeout=35, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return local_layout(payload), {**source, "mode": "local-fallback", "reason": "unavailable"}
    try:
        reply = json.loads(response.stdout)
        result = reply["layout"]
        valid = (reply["inputSha256"] == source["inputSha256"] and reply["formatterId"] == source["formatterId"]
                 and reply["layoutSha256"] == digest(encoded(result)) and isinstance(result, dict)
                 and set(result) == {"title", "html", "text", "format", "hierarchyMode"}
                 and all(isinstance(result.get(k), str) for k in ("title", "html", "text", "format"))
                 and result.get("hierarchyMode") in ("lists", "section-headings", "overflow-spaces"))
    except (ValueError, KeyError, TypeError, UnicodeError):
        valid = False
    if not valid:
        return local_layout(payload), {**source, "mode": "local-fallback", "reason": "unverified"}
    return result, {**source, "mode": "ssh"}


if __name__ == "__main__":
    sys.stdout.buffer.write(encoded(serve(sys.stdin.buffer.read())))
