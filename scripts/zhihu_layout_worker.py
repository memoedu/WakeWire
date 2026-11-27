"""Compute Zhihu article layout from a frozen tree, locally or over trusted SSH."""
from functools import lru_cache
from importlib.metadata import version
from pathlib import Path, PurePosixPath
import hashlib
import json
import re
import shlex
import struct
import subprocess
import sys
from tempfile import TemporaryDirectory

from zhihu_article_diagrams import DIAGRAM_LAYOUT_VERSION, run_diagram_renderer
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


def checked_command(worker, *, diagram=False):
    host = worker["host"]
    paths = (worker["python"], worker["script"])
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", host):
        raise ValueError("invalid_layout_host")
    if any(not PurePosixPath(p).is_absolute() or any(ord(c) < 32 for c in p) for p in paths):
        raise ValueError("invalid_layout_path")
    if PurePosixPath(worker["script"]).name != "zhihu_layout_worker.py":
        raise ValueError("invalid_layout_script")
    arguments = [paths[0], "-X", "utf8", paths[1]]
    if diagram:
        arguments.append("--diagram")
    return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=6", host, shlex.join(arguments)]


@lru_cache(maxsize=1)
def diagram_renderer_id():
    renderer = Path(__file__).with_name("zhihu-diagram-render.mjs")
    return digest(encoded([DIAGRAM_LAYOUT_VERSION, renderer.read_text(encoding="utf-8")]))


def checked_png(png):
    if not 45 <= len(png) <= 24 * 1024 * 1024:
        return False
    if not (png.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR") and
            png.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82")):
        return False
    width, height = struct.unpack(">II", png[16:24])
    return width == 1440 and 64 < height <= 3664 and height % 2 == 0


def serve_diagram(raw):
    payload = json.loads(raw)
    if set(payload) != {"diagram", "runtime", "rendererId"} or payload["rendererId"] != diagram_renderer_id():
        raise ValueError("diagram_renderer_mismatch")
    diagram = payload["diagram"]
    runtime = payload["runtime"]
    if not isinstance(diagram, str) or not 0 < len(diagram) <= 16000:
        raise ValueError("invalid_diagram")
    paths = ("node", "modules", "browserExecutable")
    if set(runtime) != {*paths, "mermaidVersion", "playwrightVersion"} or any(
        not isinstance(runtime[key], str) or not PurePosixPath(runtime[key]).is_absolute()
        or any(ord(c) < 32 for c in runtime[key]) for key in paths
    ):
        raise ValueError("invalid_diagram_runtime")
    with TemporaryDirectory(prefix="wakewire-zhihu-diagram-") as directory:
        output = Path(directory) / "diagram.png"
        run_diagram_renderer(runtime, diagram, output)
        png = output.read_bytes()
    if not checked_png(png):
        raise ValueError("invalid_diagram_image")
    return encoded({"inputSha256": digest(raw), "pngSha256": digest(png),
                    "rendererId": diagram_renderer_id()}) + b"\n" + png


def render_worker_diagram(worker, runtime, diagram, output):
    command = checked_command(worker, diagram=True)
    settings = worker["diagramRenderer"]
    remote = {key: settings[key] for key in ("node", "modules", "browserExecutable")}
    remote.update({key: runtime[key] for key in ("mermaidVersion", "playwrightVersion")})
    renderer_id = diagram_renderer_id()
    raw = encoded({"diagram": diagram, "runtime": remote, "rendererId": renderer_id})
    try:
        response = subprocess.run(command, input=raw, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  check=True, timeout=35, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        header, delimiter, png = response.stdout.partition(b"\n")
        if not delimiter or len(header) > 512 or not checked_png(png):
            return False
        expected = {"inputSha256": digest(raw), "pngSha256": digest(png), "rendererId": renderer_id}
        if json.loads(header) != expected:
            return False
    except (ValueError, OSError, subprocess.SubprocessError):
        return False
    output.write_bytes(png)
    return True


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
    if sys.argv[1:] == ["--diagram"]:
        try:
            sys.stdout.buffer.write(serve_diagram(sys.stdin.buffer.read()))
        except (OSError, TypeError, ValueError, KeyError, subprocess.SubprocessError):
            raise SystemExit("Zhihu diagram worker failed") from None
    else:
        sys.stdout.buffer.write(encoded(serve(sys.stdin.buffer.read())))
