<h1 align="center">GitHub Galaxy</h1> # GitHub Galaxy

Your GitHub account rendered as a living spiral galaxy. Every repository is one arm,
every commit is a star on that arm, and the whole thing turns slowly around you at the core.

![GitHub Galaxy demo: hovering arms, opening a repository and orbiting the disc](docs/demo.gif)

Select a repository and its full commit history lights up along its own arm. Branches run
as parallel strands, merges glow brighter, HEAD carries a diffraction glint, and GitHub
Actions runs pulse as rings around the commits they built.

![Repository drill-down](docs/repository.jpg)

![Galaxy overview](docs/overview.jpg)

## Features

- **One arm per repository**, built automatically from the account. Nothing is hardcoded:
  new repositories appear on the next refresh.
- **Commits as stars**: newest at the rim, oldest near the core, sized by diff size.
- **Repository drill-down**: up to 200 commits, branches, pull requests and Actions runs,
  synced both ways between the scene and the side panel.
- **Hover anywhere on the disc** to pick the nearest arm. Search, language filter and
  fork/archived toggles are included.
- **GPU rendering** with Three.js shaders: around 25k stars, gas filaments, dust lanes,
  a warm bulge, a stellar halo, HDR bloom and tone mapping.
- **Read-only and local**: the token never reaches the browser. Responses are cached on
  disk and refreshed in the background, so restarts don't burn the rate limit.

## Quick start

Requirements: Python 3.10+ and a WebGL 2 browser. There are no Python packages to install
and no build step.

```sh
git clone https://github.com/lavochkaa/githubGalaxy.git
cd githubGalaxy
python3 server.py --owner <your-github-login>
```

Open <http://127.0.0.1:8765/>.

Without a token the public REST API is used: public repositories only, 60 requests per hour.

## Using a token (recommended)

A token adds private repositories, uses GraphQL and raises the limit to 5,000 requests per hour.

1. Go to **GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token**.
2. Set **Repository access** to **All repositories**.
3. Under **Repository permissions**, grant **Read-only** access to: Contents, Metadata,
   Pull requests, Actions.
4. Store the token in a file only you can read:

```sh
mkdir -p ~/.config/github-galaxy
read -rs "TOKEN?GitHub token: " && printf %s "$TOKEN" > ~/.config/github-galaxy/token && unset TOKEN
chmod 600 ~/.config/github-galaxy/token
```

(In bash, use `read -rsp "GitHub token: " TOKEN` instead.)

5. Start the server. With a token, `--owner` is optional and defaults to the token's account.

```sh
GITHUB_TOKEN_FILE=~/.config/github-galaxy/token python3 server.py
```

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `--owner` / `GITHUB_OWNER` | token account | User or organization to render |
| `--host` | `127.0.0.1` | Interface to bind |
| `--port` | `8765` | Port to listen on |
| `GITHUB_TOKEN_FILE` | none | Path to a token file. Must be mode `0600` |
| `GITHUB_TOKEN` / `GH_TOKEN` | none | Token from the environment |
| `GITHUB_GALAXY_CACHE` | `~/.cache/github-galaxy/cache.json` | Disk cache location |

Cache freshness: inventory 5 minutes, repository detail 90 seconds, per-repository commit
history 1 hour. Expired entries are served immediately and refreshed in the background.
Entries older than a week are discarded.

## Controls

| Action | Input |
| --- | --- |
| Orbit | Drag |
| Pan | Shift + drag, or right-drag |
| Zoom | Alt/Ctrl/⌘ + scroll, or `+` / `-` |
| Select a repository | Click its arm, or search and press Enter |
| Inspect a commit | Hover or click a commit star, or a row in the panel |
| Back to the galaxy | `Esc` or **Back to galaxy** |

Append `?bloom=force` to keep the glow pass on slow GPUs; it switches off automatically
when frames get slow.

## How it works

```
browser (web/)                         server.py                  GitHub
 galaxy.js ── interaction, panel ──▶  /api/github-galaxy        ─▶ GraphQL (token)
 galaxy_gpu.js ── shader layers        /api/github-galaxy/repo   ─▶ REST (public fallback)
 galaxy_arm_layout.mjs ── arm math     /api/github-galaxy/head
 space_renderer.js ── HDR + bloom      github_galaxy_data.py ── validation, cache
```

- **Arms** are logarithmic spirals that share one pitch and phase origin, so they stay
  evenly interleaved. A two-armed density wave brightens broad bands across them for the
  grand-design look. The pattern rotates rigidly, so the arm shapes never wind up.
- **The same arm function** exists in JavaScript (`galaxy_arm_layout.mjs`) and GLSL
  (`galaxy_gpu.js`). The GPU moves every particle, and the CPU evaluates the same function
  only for picking and labels, so hover targets always match what is drawn.
- **Rendering** goes into a half-float target, then a soft-threshold extract, a five-level
  bloom mip chain, exponential tone mapping, sRGB output and dithering.

## Project layout

```
server.py               local HTTP server and API routes
github_galaxy_data.py   GitHub GraphQL/REST client, validation, disk cache
web/                    static client (no build step)
  index.html            page and styles
  galaxy.js             scene, camera, picking, labels, side panel
  galaxy_gpu.js         shader layers: stars, gas, dust lanes, bulge, commits
  galaxy_arm_layout.mjs arm geometry shared by CPU and GPU
  space_renderer.js     renderer, background nebulae, HDR bloom pipeline
  vendor/               Three.js r186 (MIT)
tests/                  Python unittest and Node assertion scripts
```

## Tests

```sh
python3 -m unittest discover -s tests
for test in tests/*.mjs; do node "$test"; done
```

## License

MIT, see [LICENSE](LICENSE). Three.js is bundled under its own MIT license in
[`web/vendor/THREE-LICENSE.txt`](web/vendor/THREE-LICENSE.txt).
