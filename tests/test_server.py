"""Local server contract: static files stay inside web/, API routes reach the data layer."""
import io
import json
import unittest
from unittest.mock import patch

import server


class Client(server.Handler):
    def __init__(self, path):
        self.path = path
        self.wfile = io.BytesIO()
        self.status = None
        self.headers_sent = {}
        self.owner = "octocat"

    def send_response(self, code, message=None):
        self.status = int(code)

    def send_header(self, name, value):
        self.headers_sent[name] = value

    def end_headers(self):
        pass


def get(path):
    client = Client(path)
    client.do_GET()
    return client


class ServerTests(unittest.TestCase):
    def test_index_and_modules_are_served_with_their_types(self):
        page = get("/")
        self.assertEqual(page.status, 200)
        self.assertIn(b"GitHub Galaxy", page.wfile.getvalue())
        module = get("/galaxy.js")
        self.assertEqual(module.headers_sent["Content-Type"], "text/javascript; charset=utf-8")

    def test_paths_outside_web_are_refused(self):
        for path in ("/../server.py", "/%2e%2e/server.py", "/../../etc/passwd", "/github_galaxy_data.py"):
            self.assertEqual(get(path).status, 404, path)

    def test_api_routes_use_the_configured_owner(self):
        with patch.object(server.galaxy, "summary", return_value={"owner": "octocat"}) as summary, \
             patch.object(server.galaxy, "detail", return_value={"commits": []}) as detail:
            response = get("/api/github-galaxy")
            self.assertEqual(json.loads(response.wfile.getvalue()), {"owner": "octocat"})
            self.assertEqual(response.headers_sent["Cache-Control"], "no-store")
            get("/api/github-galaxy/repo?name=hello-world")
        summary.assert_called_once_with("octocat")
        detail.assert_called_once_with("octocat", "hello-world")

    def test_invalid_repository_names_are_bad_requests(self):
        with patch.object(server.galaxy, "detail", side_effect=ValueError("Invalid repository")):
            self.assertEqual(get("/api/github-galaxy/repo?name=../x").status, 400)

    def test_internal_errors_are_not_leaked_to_the_client(self):
        with patch.object(server.galaxy, "summary", side_effect=RuntimeError("secret path /home/x")), \
             patch.object(server.traceback, "print_exc"):
            response = get("/api/github-galaxy")
        self.assertEqual(response.status, 500)
        self.assertNotIn(b"secret", response.wfile.getvalue())

    def test_github_unavailable_is_a_bad_gateway_with_its_message(self):
        with patch.object(server.galaxy, "detail", side_effect=server.galaxy.GitHubUnavailable("GitHub API is unreachable")):
            response = get("/api/github-galaxy/repo?name=x")
        self.assertEqual(response.status, 502)
        self.assertIn(b"unreachable", response.wfile.getvalue())

    def test_owner_falls_back_from_flag_to_environment_to_token_account(self):
        self.assertEqual(server.resolve_owner("octocat"), "octocat")
        with patch.dict("os.environ", {"GITHUB_OWNER": "hubot"}):
            self.assertEqual(server.resolve_owner(None), "hubot")
        with patch.dict("os.environ", {}, clear=True), patch.object(server.galaxy, "viewer_login", return_value="monalisa"):
            self.assertEqual(server.resolve_owner(None), "monalisa")
        with patch.dict("os.environ", {}, clear=True), patch.object(server.galaxy, "viewer_login", return_value=None):
            with self.assertRaises(SystemExit):
                server.resolve_owner(None)


if __name__ == "__main__":
    unittest.main()
