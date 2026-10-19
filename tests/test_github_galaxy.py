"""GitHub inventory and lazy detail contract checks with a deterministic API stub."""
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import github_galaxy_data as galaxy


class GitHubGalaxyTests(unittest.TestCase):
    def setUp(self):
        galaxy.CACHE.clear()
        galaxy.CACHE_FILE = None

    def test_cache_persists_to_disk_and_refreshes_expired_entries_in_background(self):
        with tempfile.TemporaryDirectory() as folder:
            galaxy.CACHE_FILE = Path(folder) / "cache.json"
            calls = []
            def produce():
                calls.append(1)
                return {"value": len(calls)}
            self.assertEqual(galaxy._cache("k", 60, produce), {"value": 1})
            self.assertEqual(oct(galaxy.CACHE_FILE.stat().st_mode & 0o777), "0o600")
            galaxy.CACHE.clear()
            galaxy._load_cache()
            self.assertEqual(galaxy._cache("k", 60, produce), {"value": 1}, "restart reuses the disk cache")
            galaxy.CACHE["k"] = (time.time() - 120, {"value": 1})
            self.assertEqual(galaxy._cache("k", 60, produce), {"value": 1, "stale": True}, "expired hit answers at once")
            for _ in range(100):
                if galaxy.CACHE["k"][1] == {"value": 2}:
                    break
                time.sleep(.01)
            self.assertEqual(galaxy.CACHE["k"][1], {"value": 2}, "background refresh replaces the entry")

    def test_graphql_paginates_all_owned_repositories_and_keeps_token_server_side(self):
        token = "test-private-token"
        seen = []
        def query(_query, variables, _token):
            seen.append(variables["cursor"])
            page = 1 if variables["cursor"] is None else 2
            node = {"name": f"repo-{page}", "nameWithOwner": f"space/repo-{page}",
                    "isPrivate": page == 2, "stargazerCount": 4, "pushedAt": None,
                    "primaryLanguage": {"name": "Swift", "color": "#fff"},
                    "defaultBranchRef": {"name": "main", "target": {"oid": "abc", "history": {"totalCount": 42}}}}
            return {"user": {"name": "Octo Cat", "repositories": {
                "nodes": [node], "pageInfo": {"hasNextPage": page == 1,
                                               "endCursor": "page-2" if page == 1 else None}}}}
        with patch.dict(os.environ, {"GITHUB_TOKEN": token}, clear=True), patch.object(galaxy, "_graphql", side_effect=query):
            result = galaxy.summary("space")
            second = galaxy.summary("space")
        self.assertEqual([None, "page-2"], seen)
        self.assertEqual(2, len(result["repositories"]))
        self.assertTrue(result["repositories"][1]["private"])
        self.assertEqual("github-graphql", result["source"])
        self.assertEqual(result, second)
        self.assertNotIn(token, str(result))

    def test_public_rest_paginates_and_detail_includes_merges_prs_and_actions(self):
        self.assertIn("history(first:100)", galaxy.DETAIL_QUERY)
        listing = [{"name": "repo", "full_name": "space/repo", "stargazers_count": 8,
                    "default_branch": "main", "language": "Python", "pushed_at": "2026-10-18T10:00:00Z"}]
        commit = {"sha": "a" * 40, "commit": {"message": "Merge feature", "author": {"date": "2026-10-18T10:00:00Z", "name": "Space"}},
                  "parents": [{"sha": "b" * 40}, {"sha": "c" * 40}]}
        maximums = []
        def pages(path, _token, _maximum=1000):
            maximums.append((path, _maximum))
            if path.startswith("/users/"):
                return listing
            if path.endswith("/branches"):
                return [{"name": "main", "commit": {"sha": commit["sha"]}}]
            if "/commits?" in path:
                return [commit]
            if "/pulls?" in path:
                return [{"number": 1, "title": "Feature", "state": "closed",
                         "head": {"ref": "feature"}, "base": {"ref": "main"},
                         "merged_at": "2026-10-18T10:00:00Z", "html_url": "https://github.com/space/repo/pull/1"}]
            raise AssertionError(path)
        actions = {"workflow_runs": [{"id": 9, "name": "Tests", "status": "completed", "conclusion": "success",
                                      "head_branch": "main", "head_sha": commit["sha"], "created_at": "2026-10-18T10:00:00Z"}]}
        with patch.dict(os.environ, {}, clear=True), patch.object(galaxy, "_rest_pages", side_effect=pages), \
             patch.object(galaxy, "_request", return_value=(actions, {})):
            result = galaxy.summary("space")
            detail = galaxy.detail("space", "repo")
        self.assertEqual("github-rest-public", result["source"])
        self.assertEqual(1, len(detail["branches"]))
        self.assertEqual(2, len(detail["commits"][0]["parents"]))
        self.assertEqual("MERGED", detail["pullRequests"][0]["state"] if detail["pullRequests"][0]["mergedAt"] else "OPEN")
        self.assertEqual("success", detail["actions"][0]["conclusion"])
        self.assertIn(200, [maximum for path, maximum in maximums if "/commits?" in path])

    def test_public_summary_adds_real_cached_history_for_every_repository(self):
        listing = [
            {"name": "fresh", "full_name": "space/fresh", "default_branch": "main",
             "fork": True, "archived": False, "pushed_at": "2026-10-18T10:00:00Z"},
            {"name": "archive", "full_name": "space/archive", "default_branch": "trunk",
             "fork": False, "archived": True, "pushed_at": "2025-01-01T10:00:00Z"},
        ]
        histories = {
            "fresh": [{"oid": "a" * 40, "subject": "Ship", "date": "2026-10-18T10:00:00Z",
                       "author": "Space", "parents": [], "additions": 4, "deletions": 1}],
            "archive": [],
        }
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(galaxy, "_rest_pages", return_value=listing), \
             patch.object(galaxy, "_overview_history", side_effect=lambda _owner, repo, _branch, _token: histories[repo]):
            result = galaxy.summary("space")
        self.assertEqual(["fresh", "archive"], [repo["name"] for repo in result["repositories"]])
        self.assertTrue(result["repositories"][0]["fork"])
        self.assertTrue(result["repositories"][1]["archived"])
        self.assertEqual("Ship", result["repositories"][0]["overviewCommits"][0]["subject"])
        self.assertEqual([], result["repositories"][1]["overviewCommits"])

    def test_api_failure_is_explicitly_simulated(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(galaxy, "_rest_pages", side_effect=galaxy.GitHubUnavailable("offline")):
            result = galaxy.summary("space")
        self.assertTrue(result["simulated"])
        self.assertEqual("simulated", result["source"])
        self.assertEqual(24, len(result["repositories"]))

    def test_detail_returns_an_unavailable_payload_when_the_api_is_rate_limited(self):
        inventory = {"source": "github-rest-public", "simulated": False, "repositories": [{
            "name": "repo", "defaultBranch": "main", "private": False}], "owner": "space"}
        with patch.dict(os.environ, {}, clear=True), patch.object(galaxy, "summary", return_value=inventory), \
             patch.object(galaxy, "_rest_pages", side_effect=galaxy.GitHubUnavailable("GitHub rate limit or access denied")):
            result = galaxy.detail("space", "repo")
        self.assertTrue(result["unavailable"])
        self.assertEqual([], result["commits"])
        self.assertFalse(result["simulated"])

    def test_hover_head_returns_latest_real_commit_and_caches_it(self):
        listing = [{"name": "repo", "full_name": "space/repo", "default_branch": "main"}]
        latest = [{"sha": "a" * 40, "commit": {"message": "Fix tests\n\nDetail",
                   "committer": {"date": "2026-10-18T10:00:00Z"}}}]
        def request(url, _token):
            return (latest if "/commits?" in url else {"workflow_runs": [{"conclusion": "success"}]}, {})
        with patch.dict(os.environ, {}, clear=True), patch.object(galaxy, "_rest_pages", return_value=listing), \
             patch.object(galaxy, "_request", side_effect=request) as get:
            first = galaxy.head("space", "repo")
            second = galaxy.head("space", "repo")
        self.assertEqual("a" * 40, first["lastCommit"])
        self.assertEqual("Fix tests", first["subject"])
        self.assertEqual("success", first["status"])
        self.assertEqual(first, second)
        self.assertEqual(2, get.call_count)

    def test_token_file_requires_private_permissions(self):
        with tempfile.NamedTemporaryFile(mode="w", delete=True) as secret:
            secret.write("example-token")
            secret.flush()
            os.chmod(secret.name, 0o644)
            with patch.dict(os.environ, {"GITHUB_TOKEN_FILE": secret.name}, clear=True):
                with self.assertRaises(galaxy.GitHubUnavailable):
                    galaxy._token()
                os.chmod(secret.name, 0o600)
                self.assertEqual("example-token", galaxy._token())


if __name__ == "__main__":
    unittest.main()
