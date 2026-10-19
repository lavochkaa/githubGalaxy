"""Static site build: client copied, snapshot written, private repositories kept out."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_site


def repo(name, private=False):
    return {"name": name, "private": private, "commits": 3, "overviewCommits": []}


INVENTORY = {
    "owner": "octocat",
    "displayName": "Octo Cat",
    "repositories": [repo("hello-world"), repo("secret-plans", private=True)],
    "source": "github-graphql",
    "simulated": False,
    "stale": True,
    "cacheAgeSeconds": 40,
    "updatedAt": "2026-10-20T00:00:00+00:00",
}


class BuildSiteTests(unittest.TestCase):
    def build(self, inventory=INVENTORY, include_private=False):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        out = Path(folder.name) / "site"
        with patch.object(build_site.galaxy, "summary", return_value=inventory), \
             patch.object(build_site.galaxy, "detail", side_effect=lambda owner, name: {"repository": {"name": name}, "commits": []}), \
             patch.object(build_site.galaxy, "head", side_effect=lambda owner, name: {"lastCommit": name}):
            result = build_site.build("octocat", out, include_private)
        return out, result

    def test_snapshot_is_written_next_to_a_static_client(self):
        out, result = self.build()
        self.assertEqual(result["repositories"], 1)
        page = (out / "index.html").read_text()
        self.assertIn(build_site.STATIC_META, page)
        self.assertIn('src="./galaxy.js"', page, "relative script path works under a project subpath")
        self.assertTrue((out / "galaxy.js").is_file() and (out / ".nojekyll").is_file())
        snapshot = json.loads((out / "data/galaxy.json").read_text())
        self.assertTrue(snapshot["snapshot"])
        self.assertNotIn("stale", snapshot)
        self.assertEqual(json.loads((out / "data/repos/hello-world.json").read_text())["repository"]["name"], "hello-world")
        self.assertEqual(json.loads((out / "data/heads/hello-world.json").read_text())["lastCommit"], "hello-world")

    def test_private_repositories_are_not_published_by_default(self):
        out, _ = self.build()
        snapshot = (out / "data/galaxy.json").read_text()
        self.assertNotIn("secret-plans", snapshot)
        self.assertFalse((out / "data/repos/secret-plans.json").exists())
        out, result = self.build(include_private=True)
        self.assertEqual(result["repositories"], 2)
        self.assertTrue((out / "data/repos/secret-plans.json").exists())

    def test_simulated_data_is_never_published(self):
        with self.assertRaises(SystemExit):
            self.build({**INVENTORY, "simulated": True, "reason": "rate limited"})


if __name__ == "__main__":
    unittest.main()
