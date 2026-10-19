#!/usr/bin/env python3
"""Serve GitHub Galaxy locally: static web client plus a read-only GitHub proxy."""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import github_galaxy_data as galaxy

WEB = Path(__file__).resolve().parent / "web"
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8"}


def resolve_owner(explicit: str | None) -> str:
    owner = explicit or os.environ.get("GITHUB_OWNER") or galaxy.viewer_login()
    if not owner:
        raise SystemExit("Set --owner or GITHUB_OWNER (or provide a token so the owner can be detected).")
    if not galaxy.NAME.fullmatch(owner):
        raise SystemExit(f"Invalid GitHub owner: {owner}")
    return owner


class Handler(BaseHTTPRequestHandler):
    owner = ""
    server_version = "GitHubGalaxy"

    def respond(self, content: bytes, content_type: str, status: int = HTTPStatus.OK, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        self.respond(json.dumps(payload, ensure_ascii=False).encode(), "application/json; charset=utf-8", status)

    def do_GET(self) -> None:
        request = urlsplit(self.path)
        query = parse_qs(request.query)
        name = query.get("name", [""])[0]
        try:
            if request.path == "/api/github-galaxy":
                return self.json(galaxy.summary(self.owner))
            if request.path == "/api/github-galaxy/repo":
                return self.json(galaxy.detail(self.owner, name))
            if request.path == "/api/github-galaxy/head":
                return self.json(galaxy.head(self.owner, name))
        except ValueError as exc:
            return self.json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except galaxy.GitHubUnavailable as exc:  # Messages are authored in github_galaxy_data and safe to show.
            return self.json({"error": str(exc)}, HTTPStatus.BAD_GATEWAY)
        except Exception:  # Internals stay in the server log, never in the response.
            traceback.print_exc()
            return self.json({"error": "Internal server error"}, HTTPStatus.INTERNAL_SERVER_ERROR)
        self.static(request.path)

    def static(self, path: str) -> None:
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB / relative).resolve()
        if WEB not in target.parents or not target.is_file() or target.suffix not in TYPES:
            return self.respond(b"Not found", "text/plain; charset=utf-8", HTTPStatus.NOT_FOUND)
        self.respond(target.read_bytes(), TYPES.get(target.suffix) or mimetypes.guess_type(target.name)[0], cache="no-cache")

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write("galaxy %s\n" % (format % args))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", help="GitHub user or organization to render (default: GITHUB_OWNER or the token's account)")
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="port to listen on (default: 8765)")
    args = parser.parse_args(argv)
    Handler.owner = resolve_owner(args.owner)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    mode = "token" if galaxy._token() else "public API"
    print(f"GitHub Galaxy for {Handler.owner} ({mode}) at http://{args.host}:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
