import json
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

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
