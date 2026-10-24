#!/usr/bin/env python3
"""Build a static GitHub Galaxy site: the web client plus a JSON snapshot of one account."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import github_galaxy_data as galaxy
from server import WEB, resolve_owner

STATIC_META = '<meta name="galaxy-source" content="static">'


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def build(owner: str, out: Path, include_private: bool = False) -> dict:
    inventory = galaxy.summary(owner)
    if inventory.get("simulated"):
        # Never publish the offline mock over a good deployment; failing keeps the previous site live.
        raise SystemExit(f"GitHub is unavailable, not publishing a snapshot: {inventory.get('reason')}")
    # A published snapshot is public, so private repositories are left out unless explicitly requested.
    repos = [repo for repo in inventory["repositories"] if include_private or not repo["private"]]
    snapshot = {key: value for key, value in inventory.items() if key not in ("stale", "cacheAgeSeconds")}
    snapshot.update(repositories=repos, snapshot=True)
    asset_version = hashlib.sha256(b"".join((WEB / name).read_bytes() for name in
                                    ("galaxy.js", "galaxy_gpu.js", "space_renderer.js"))).hexdigest()[:12]
    snapshot_version = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()[:12]

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(WEB, out)
    page = out / "index.html"
    html = page.read_text(encoding="utf-8")
    if STATIC_META not in html:
        html = html.replace('<meta charset="utf-8">',
                            '<meta charset="utf-8">\n' + STATIC_META +
                            f'\n<meta name="galaxy-snapshot-version" content="{snapshot_version}">', 1)
    html = html.replace('src="./galaxy.js"', f'src="./galaxy.js?v={asset_version}"', 1)
    page.write_text(html, encoding="utf-8")
    script = out / "galaxy.js"
    script.write_text(script.read_text(encoding="utf-8")
                      .replace('from "./galaxy_gpu.js"', f'from "./galaxy_gpu.js?v={asset_version}"', 1)
                      .replace('from "./space_renderer.js"', f'from "./space_renderer.js?v={asset_version}"', 1),
                      encoding="utf-8")
    gpu = out / "galaxy_gpu.js"
    gpu.write_text(gpu.read_text(encoding="utf-8").replace(
        "from './space_renderer.js'", f"from './space_renderer.js?v={asset_version}'", 1), encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")

    write_json(out / "data/galaxy.json", snapshot)

    def export(repo: dict) -> bool:
        name = repo["name"]
        detail = galaxy.detail(owner, name)
        write_json(out / "data/repos" / f"{name}.json", detail)
        write_json(out / "data/heads" / f"{name}.json", galaxy.head(owner, name))
        return not detail.get("unavailable")

    with ThreadPoolExecutor(max_workers=6) as pool:
        complete = sum(pool.map(export, repos))
    return {"owner": owner, "repositories": len(repos), "detailed": complete, "source": inventory["source"]}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", help="GitHub user or organization (default: GITHUB_OWNER or the token's account)")
    parser.add_argument("--out", type=Path, default=Path("_site"), help="output directory (default: _site)")
    parser.add_argument("--include-private", action="store_true", help="also publish private repositories the token can read")
    args = parser.parse_args(argv)
    result = build(resolve_owner(args.owner), args.out, args.include_private)
    print(
        f"Built {args.out} for {result['owner']}: {result['repositories']} repositories, "
        f"{result['detailed']} with detail, source {result['source']}"
    )


if __name__ == "__main__":
    main()
