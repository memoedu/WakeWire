import json
from pathlib import Path
import struct
import subprocess
from tempfile import TemporaryDirectory
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import zlib

import zhihu_layout_worker as worker


class LayoutWorkerTests(unittest.TestCase):
    def setUp(self):
        self.nodes = [{"text": "Frozen outline", "depth": 0},
                      {"text": "Use the original hierarchy and $x^2$.", "depth": 1}]
        self.remote = {"host": "layout-test", "python": "/tooling/bin/python",
                       "script": "/repo with spaces/scripts/zhihu_layout_worker.py"}

    def compute(self):
        return worker.compute_layout(self.nodes, None, None, {}, self.remote)

    def test_remote_uses_only_frozen_layout_fields(self):
        def transport(command, *, input, **kwargs):
            self.assertIn("StrictHostKeyChecking=yes", command)
            self.assertEqual(set(json.loads(input)), {"nodes", "firstPublishedAt", "aiGeneratedTagRemId", "diagrams"})
            return SimpleNamespace(stdout=worker.encoded(worker.serve(input)))
        with patch.object(subprocess, "run", side_effect=transport):
            layout, execution = self.compute()
        local, default_execution = worker.compute_layout(self.nodes, None, None, {})
        self.assertEqual(layout, local)
        self.assertIsNone(default_execution)
        self.assertEqual(execution["mode"], "ssh")

    def test_worker_rejects_unrelated_fields(self):
        with self.assertRaisesRegex(ValueError, "unexpected_layout_fields"):
            worker.serve(worker.encoded({"nodes": self.nodes, "accountId": "unused"}))

    def test_unknown_response_or_other_revision_recomputes_once_locally(self):
        local, _ = worker.compute_layout(self.nodes, None, None, {})
        for field in ("inputSha256", "formatterId", "layoutSha256"):
            def transport(command, *, input, **kwargs):
                return SimpleNamespace(stdout=worker.encoded({**worker.serve(input), field: "another value"}))
            with self.subTest(field=field), patch.object(subprocess, "run", side_effect=transport) as runner:
                result, execution = self.compute()
                self.assertEqual(execution["reason"], "unverified")
                self.assertEqual(result, local)
                runner.assert_called_once()

    def test_unreachable_host_keeps_layout_and_rejects_invalid_configuration(self):
        with patch.object(subprocess, "run", side_effect=OSError()):
            _, execution = self.compute()
            self.assertEqual(execution["reason"], "unavailable")
        for changes in ({"host": "-V"}, {"script": "/tmp/something-else"}, {"python": "relative"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                worker.checked_command({**self.remote, **changes})

    def test_diagram_bindings_and_invalid_response_preserve_local_fallback(self):
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

        png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1440, 80, 8, 0, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(bytes(1441 * 80))) + chunk(b"IEND", b""))
        runtime = {"mermaidVersion": "11.17.2", "playwrightVersion": "1.63.0", "cache": "never transferred"}
        remote = {**self.remote, "diagramRenderer": {
            "node": "/tooling/bin/node", "modules": "/modules", "browserExecutable": "/Chrome executable",
        }}
        diagram = "flowchart LR\na --> b"

        def transport(command, *, input, **kwargs):
            self.assertIn("StrictHostKeyChecking=yes", command)
            self.assertTrue(command[-1].endswith(" --diagram"))
            payload = json.loads(input)
            self.assertEqual(set(payload), {"diagram", "runtime", "rendererId"})
            self.assertEqual(set(payload["runtime"]),
                             {"node", "modules", "browserExecutable", "mermaidVersion", "playwrightVersion"})
            with patch.object(worker, "run_diagram_renderer", side_effect=lambda runtime, diagram, output: output.write_bytes(png)):
                return worker.serve_diagram(input)

        with TemporaryDirectory() as directory:
            output = Path(directory) / "verified.png"
            with patch.object(subprocess, "run",
                              side_effect=lambda *args, **kwargs: SimpleNamespace(stdout=transport(*args, **kwargs))):
                self.assertTrue(worker.render_worker_diagram(remote, runtime, diagram, output))
            self.assertEqual(output.read_bytes(), png)
            for method in ("hash", "truncated"):
                def unverified(command, **kwargs):
                    data = transport(command, **kwargs)
                    return SimpleNamespace(stdout=data[:-1] if method == "truncated" else
                                           data.replace(worker.digest(png).encode(), b"0" * 64, 1))
                with self.subTest(method=method), patch.object(subprocess, "run", side_effect=unverified):
                    self.assertFalse(worker.render_worker_diagram(remote, runtime, diagram, output))
                    self.assertEqual(output.read_bytes(), png)
            with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 35)):
                self.assertFalse(worker.render_worker_diagram(remote, runtime, diagram, output))
