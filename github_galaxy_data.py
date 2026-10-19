"""Server-only GitHub discovery and bounded galaxy detail reads."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

API = "https://api.github.com"
GRAPHQL = API + "/graphql"
NAME = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
CACHE: dict[str, tuple[float, dict]] = {}
LOCK = threading.Lock()
REFRESHING: set[str] = set()
# Survives service restarts so a reload never spends the GitHub rate limit on data we already have.
CACHE_FILE: Path | None = Path(os.environ.get("GITHUB_GALAXY_CACHE") or Path.home() / ".cache/github-galaxy/cache.json")
STALE_LIMIT = 7 * 24 * 3600
SUMMARY_TTL = 300
DETAIL_TTL = 90
OVERVIEW_TTL = 3600
OVERVIEW_COMMITS = 32


def _token() -> str | None:
    direct = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if direct:
        return direct.strip()
    path = os.environ.get("GITHUB_TOKEN_FILE")
    if path:
        file = Path(path).expanduser()
        if file.stat().st_mode & 0o077:
            raise GitHubUnavailable("GitHub token file must have mode 0600")
        return file.read_text(encoding="utf-8").strip() or None
    return None

SUMMARY_QUERY = """query($owner:String!,$cursor:String){
  user(login:$owner){name login repositories(first:100,after:$cursor,ownerAffiliations:OWNER,
  orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}
  nodes{name nameWithOwner url description isPrivate isFork isArchived stargazerCount pushedAt
  primaryLanguage{name color} defaultBranchRef{name target{... on Commit{oid committedDate messageHeadline
  history(first:32){totalCount nodes{oid messageHeadline committedDate additions deletions author{name} parents(first:2){nodes{oid}}}}}}}}}}
  rateLimit{remaining resetAt}
}"""
DETAIL_QUERY = """query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){nameWithOwner url defaultBranchRef{name}
  refs(refPrefix:"refs/heads/",first:25){nodes{name target{... on Commit{oid
  history(first:100){nodes{oid messageHeadline committedDate additions deletions
  author{name} parents(first:2){nodes{oid}}}}}}}}
  pullRequests(first:30,states:[OPEN,MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){
  nodes{number title state headRefName baseRefName mergedAt url}}}
  rateLimit{remaining resetAt}
}"""


class GitHubUnavailable(RuntimeError):
    pass


def _request(url: str, token: str | None = None, payload: dict | None = None) -> tuple[dict | list, dict]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "github-galaxy",
               "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(payload).encode() if payload is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    try:
        with urlopen(Request(url, data=data, headers=headers), timeout=9) as response:
            body = json.load(response)
            meta = {"remaining": response.headers.get("X-RateLimit-Remaining"),
                    "reset": response.headers.get("X-RateLimit-Reset")}
    except HTTPError as exc:
        if exc.code in (403, 429):
            raise GitHubUnavailable("GitHub rate limit or access denied") from exc
        raise GitHubUnavailable(f"GitHub returned HTTP {exc.code}") from exc
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        raise GitHubUnavailable("GitHub API is unreachable") from exc
    return body, meta


def _graphql(query: str, variables: dict, token: str) -> dict:
    body, _ = _request(GRAPHQL, token, {"query": query, "variables": variables})
    if not isinstance(body, dict) or body.get("errors"):
        raise GitHubUnavailable("GitHub GraphQL query failed or token lacks access")
    return body.get("data") or {}


def viewer_login() -> str | None:
    """The account behind the configured token, used when no owner is given."""
    token = _token()
    if not token:
        return None
    try:
        return (_graphql("query{viewer{login}}", {}, token).get("viewer") or {}).get("login")
    except GitHubUnavailable:
        return None


def _rest_pages(path: str, token: str | None, maximum: int = 1000) -> list:
    rows = []
    for page in range(1, maximum // 100 + 2):
        delimiter = "&" if "?" in path else "?"
        body, meta = _request(API + path + delimiter + urlencode({"per_page": 100, "page": page}), token)
        if not isinstance(body, list):
            raise GitHubUnavailable("GitHub returned unexpected repository data")
        rows.extend(body)
        if len(body) < 100 or len(rows) >= maximum:
            return rows[:maximum]
        if meta.get("remaining") == "0":
            raise GitHubUnavailable("GitHub API rate limit reached")
    return rows[:maximum]


def _load_cache() -> None:
    if not CACHE_FILE or not CACHE_FILE.exists():
        return
    try:
        saved = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        now = time.time()
        CACHE.update({key: (float(at), value) for key, (at, value) in saved.items() if now - float(at) < STALE_LIMIT})
    except (OSError, ValueError, TypeError):
        pass


def _save_cache() -> None:
    if not CACHE_FILE:
        return
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOCK:
            payload = json.dumps(CACHE, ensure_ascii=False)
        temporary = CACHE_FILE.with_suffix(".tmp")
        temporary.write_text(payload, encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, CACHE_FILE)
    except OSError:
        pass


def _store(key: str, result: dict) -> dict:
    with LOCK:
        CACHE[key] = (time.time(), result)
    _save_cache()
    return result


def _refresh(key: str, producer) -> None:
    try:
        _store(key, producer())
    except Exception:
        pass
    finally:
        with LOCK:
            REFRESHING.discard(key)


def _cache(key: str, ttl: int, producer) -> dict:
    """Fresh hits return directly; expired hits return at once and refresh in the background."""
    with LOCK:
        saved = CACHE.get(key)
        if saved and time.time() - saved[0] < ttl:
            return saved[1]
        if saved:
            if key not in REFRESHING:
                REFRESHING.add(key)
                threading.Thread(target=_refresh, args=(key, producer), daemon=True).start()
            return {**saved[1], "stale": True}
    try:
        result = producer()
    except GitHubUnavailable:
        if saved:
            return {**saved[1], "stale": True}
        raise
    return _store(key, result)


_load_cache()


def _repo(node: dict) -> dict:
    branch = node.get("defaultBranchRef") or {}
    target = branch.get("target") or {}
    return {"name": node.get("name") or "", "fullName": node.get("nameWithOwner") or "",
            "url": node.get("url"), "description": node.get("description") or "",
            "private": bool(node.get("isPrivate")), "fork": bool(node.get("isFork")),
            "archived": bool(node.get("isArchived")),
            "stars": node.get("stargazerCount") or 0, "pushedAt": node.get("pushedAt"),
            "language": (node.get("primaryLanguage") or {}).get("name") or "Unknown",
            "languageColor": (node.get("primaryLanguage") or {}).get("color"),
            "defaultBranch": branch.get("name") or "main",
            "commits": (target.get("history") or {}).get("totalCount") or 0,
            "overviewCommits": [_commit(commit, branch.get("name") or "main")
                                for commit in (target.get("history") or {}).get("nodes") or []],
            "lastCommit": target.get("oid"), "lastCommitDate": target.get("committedDate"),
            "lastCommitSubject": target.get("messageHeadline")}


def _mock(owner: str, reason: str) -> dict:
    languages = ["Swift", "TypeScript", "Python", "C++", "JavaScript", "Rust"]
    repos = [{"name": f"simulated-{i:02d}", "fullName": f"{owner}/simulated-{i:02d}",
              "url": None, "description": "Generated offline fallback", "private": False,
              "fork": False, "archived": False, "stars": (i * 11) % 63, "pushedAt": None,
              "language": languages[i % len(languages)], "languageColor": None,
              "defaultBranch": "main", "commits": 15 + i * 9, "overviewCommits": [], "lastCommit": None}
             for i in range(1, 25)]
    return {"owner": owner, "displayName": owner, "repositories": repos,
            "source": "simulated", "simulated": True, "reason": reason,
            "updatedAt": datetime.now(timezone.utc).isoformat()}


def summary(owner: str) -> dict:
    if not NAME.fullmatch(owner):
        raise ValueError("Invalid GitHub owner")
    token = _token()
    def produce():
        if token:
            try:
                nodes, cursor, display = [], None, owner
                while True:
                    data = _graphql(SUMMARY_QUERY, {"owner": owner, "cursor": cursor}, token)
                    user = data.get("user")
                    if not user:
                        raise GitHubUnavailable("GitHub account was not found")
                    display = user.get("name") or display
                    connection = user["repositories"]
                    nodes.extend(connection.get("nodes") or [])
                    if not connection["pageInfo"]["hasNextPage"]:
                        break
                    cursor = connection["pageInfo"]["endCursor"]
                    if not cursor:
                        raise GitHubUnavailable("GitHub pagination ended unexpectedly")
                repos = [_repo(node) for node in nodes if node]
                source = "github-graphql"
            except GitHubUnavailable:
                repos = None
        else:
            repos = None
        if repos is None:
            raw = _rest_pages("/users/" + quote(owner) + "/repos?type=owner&sort=updated", None, 10000)
            repos = [{"name": row["name"], "fullName": row["full_name"], "url": row.get("html_url"),
                      "description": row.get("description") or "", "private": False,
                      "fork": bool(row.get("fork")), "archived": bool(row.get("archived")), "stars": row.get("stargazers_count") or 0,
                      "pushedAt": row.get("pushed_at"), "language": row.get("language") or "Unknown",
                      "languageColor": None, "defaultBranch": row.get("default_branch") or "main",
                      "commits": 0, "overviewCommits": [], "lastCommit": None, "lastCommitDate": None,
                      "lastCommitSubject": None} for row in raw]
            _add_public_overview(owner, repos)
            display = owner
            source = "github-rest-public"
        return {"owner": owner, "displayName": display, "repositories": repos,
                "source": source, "simulated": False,
                "updatedAt": datetime.now(timezone.utc).isoformat()}
    try:
        identity = sha256(token.encode()).hexdigest()[:12] if token else "public"
        result = _cache("summary:" + owner + ":" + identity, SUMMARY_TTL, produce)
        updated = datetime.fromisoformat(result["updatedAt"].replace("Z", "+00:00"))
        return {**result, "cacheAgeSeconds": max(0, int((datetime.now(timezone.utc) - updated).total_seconds()))}
    except GitHubUnavailable as exc:
        return _mock(owner, str(exc))


def _rest_overview_commit(node: dict, branch: str) -> dict:
    commit = node.get("commit") or {}
    author = commit.get("author") or commit.get("committer") or {}
    return {"oid": node.get("sha") or "", "subject": (commit.get("message") or "").split("\n", 1)[0],
            "date": author.get("date"), "author": author.get("name") or "Unknown",
            "parents": [parent.get("sha") for parent in node.get("parents") or [] if parent.get("sha")],
            "additions": 0, "deletions": 0, "branch": branch}


def _overview_history(owner: str, name: str, branch: str, token: str | None) -> list[dict]:
    identity = sha256(token.encode()).hexdigest()[:12] if token else "public"
    key = f"overview:{owner}:{name}:{branch}:{identity}"
    def produce():
        prefix = "/repos/" + quote(owner) + "/" + quote(name)
        rows = _rest_pages(prefix + "/commits?sha=" + quote(branch, safe=""), token, OVERVIEW_COMMITS)
        return [_rest_overview_commit(row, branch) for row in rows[:OVERVIEW_COMMITS] if row.get("sha")]
    return _cache(key, OVERVIEW_TTL, produce)


def _add_public_overview(owner: str, repositories: list[dict]) -> None:
    """Populate each overview arm from a bounded, hour-cached real commit sample."""
    if not repositories:
        return
    with ThreadPoolExecutor(max_workers=min(8, len(repositories))) as pool:
        futures = {pool.submit(_overview_history, owner, repo["name"], repo["defaultBranch"], None): repo
                   for repo in repositories}
        for future in as_completed(futures):
            repo = futures[future]
            try:
                history = future.result()
            except GitHubUnavailable:
                history = []
                repo["overviewUnavailable"] = True
            repo["overviewCommits"] = history
            repo["commits"] = max(repo["commits"], len(history))
            if history:
                repo["lastCommit"] = history[0]["oid"]
                repo["lastCommitDate"] = history[0]["date"]
                repo["lastCommitSubject"] = history[0]["subject"]


def _commit(node: dict, branch: str) -> dict:
    return {"oid": node["oid"], "subject": node.get("messageHeadline") or "",
            "date": node.get("committedDate"), "author": (node.get("author") or {}).get("name") or "Unknown",
            "parents": [parent["oid"] for parent in (node.get("parents") or {}).get("nodes") or []],
            "additions": node.get("additions") or 0, "deletions": node.get("deletions") or 0,
            "branch": branch}


def head(owner: str, name: str) -> dict:
    if not NAME.fullmatch(owner) or not NAME.fullmatch(name):
        raise ValueError("Invalid repository")
    inventory = summary(owner)
    listed = next((r for r in inventory["repositories"] if r["name"].lower() == name.lower()), None)
    if not listed:
        raise ValueError("Repository not in account inventory")
    if inventory["simulated"]:
        return {"simulated": True, "lastCommit": None, "status": "simulated"}
    token = _token() if inventory["source"] == "github-graphql" else None
    def produce():
        prefix = API + "/repos/" + quote(owner) + "/" + quote(name)
        result = {"lastCommit": listed.get("lastCommit"), "date": listed.get("lastCommitDate"),
                  "subject": listed.get("lastCommitSubject"), "simulated": False}
        if not result["lastCommit"]:
            try:
                body, _ = _request(prefix + "/commits?per_page=1", token)
                latest = body[0] if isinstance(body, list) and body else None
            except (GitHubUnavailable, IndexError, KeyError):
                latest = None
            if latest:
                result.update({"lastCommit": latest["sha"],
                               "date": latest["commit"]["committer"]["date"],
                               "subject": latest["commit"]["message"].splitlines()[0]})
        try:
            body, _ = _request(prefix + "/actions/runs?per_page=1", token)
            run = (body.get("workflow_runs") or [None])[0]
            result["status"] = (run.get("conclusion") or run.get("status")) if run else "no runs"
        except GitHubUnavailable:
            result["status"] = "unavailable"
        return result
    identity = sha256(token.encode()).hexdigest()[:12] if token else "public"
    return _cache("head:" + owner + "/" + name + ":" + identity, SUMMARY_TTL, produce)


def detail(owner: str, name: str) -> dict:
    if not NAME.fullmatch(owner) or not NAME.fullmatch(name):
        raise ValueError("Invalid repository")
    inventory = summary(owner)
    listed = next((r for r in inventory["repositories"] if r["name"].lower() == name.lower()), None)
    if not listed:
        raise ValueError("Repository not in account inventory")
    if inventory["simulated"]:
        return {"repository": listed, "branches": [], "commits": [], "pullRequests": [], "actions": [],
                "simulated": True}
    token = _token() if inventory["source"] == "github-graphql" else None
    def produce():
        commits, branches, pulls = {}, [], []
        repo = None
        effective_token = token
        if token:
            try:
                data = _graphql(DETAIL_QUERY, {"owner": owner, "name": name}, token)
                repo = data.get("repository")
                if not repo:
                    raise GitHubUnavailable("Repository detail unavailable")
            except GitHubUnavailable:
                if listed["private"]:
                    raise
                effective_token = None
        if repo:
            for ref in (repo.get("refs") or {}).get("nodes") or []:
                if not ref:
                    continue
                branch = ref["name"]
                branches.append({"name": branch, "head": (ref.get("target") or {}).get("oid")})
                for node in ((ref.get("target") or {}).get("history") or {}).get("nodes") or []:
                    commits.setdefault(node["oid"], _commit(node, branch))
            pulls = [{"number": p["number"], "title": p["title"], "state": p["state"],
                      "head": p.get("headRefName"), "base": p.get("baseRefName"),
                      "mergedAt": p.get("mergedAt"), "url": p.get("url")}
                     for p in (repo.get("pullRequests") or {}).get("nodes") or []]
        else:
            prefix = "/repos/" + quote(owner) + "/" + quote(name)
            raw_branches = _rest_pages(prefix + "/branches", None, 100)
            branches = [{"name": b["name"], "head": b["commit"]["sha"]} for b in raw_branches[:25]]
            branch_heads = sorted(branches, key=lambda b: b["name"] != listed["defaultBranch"])[:8]
            for branch in branch_heads:
                path = prefix + "/commits?sha=" + quote(branch["name"], safe="")
                for node in _rest_pages(path, effective_token, 200):
                    commits.setdefault(node["sha"], {"oid": node["sha"],
                        "subject": node["commit"]["message"].splitlines()[0],
                        "date": node["commit"]["author"]["date"],
                        "author": node["commit"]["author"]["name"],
                        "parents": [p["sha"] for p in node.get("parents", [])],
                        "additions": 0, "deletions": 0, "branch": branch["name"]})
            raw_pulls = _rest_pages(prefix + "/pulls?state=all&sort=updated&direction=desc", None, 30)
            pulls = [{"number": p["number"], "title": p["title"], "state": "MERGED" if p.get("merged_at") else p["state"].upper(),
                      "head": p["head"]["ref"], "base": p["base"]["ref"],
                      "mergedAt": p.get("merged_at"), "url": p.get("html_url")} for p in raw_pulls]
        ordered = sorted(commits.values(), key=lambda c: c.get("date") or "", reverse=True)[:200]
        prefix = "/repos/" + quote(owner) + "/" + quote(name)
        try:
            body, _ = _request(API + prefix + "/actions/runs?per_page=20", effective_token)
            actions = [{"id": run["id"], "name": run.get("name") or "Workflow", "status": run.get("status"),
                        "conclusion": run.get("conclusion"), "branch": run.get("head_branch"),
                        "head": run.get("head_sha"), "createdAt": run.get("created_at"),
                        "url": run.get("html_url")} for run in body.get("workflow_runs", [])]
        except GitHubUnavailable:
            actions = []
        return {"repository": listed, "branches": branches, "commits": ordered,
                "pullRequests": pulls, "actions": actions, "simulated": False,
                "updatedAt": datetime.now(timezone.utc).isoformat()}
    identity = sha256(token.encode()).hexdigest()[:12] if token else "public"
    try:
        return _cache("detail:" + owner + "/" + name + ":" + identity, DETAIL_TTL, produce)
    except GitHubUnavailable as exc:
        return {"repository": listed, "branches": [], "commits": [], "pullRequests": [], "actions": [],
                "simulated": False, "unavailable": True, "reason": str(exc),
                "updatedAt": datetime.now(timezone.utc).isoformat()}
