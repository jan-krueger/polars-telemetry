# Contributing

## Setup

```bash
uv sync --all-groups
```

Dependencies newer than 7 days are ignored by resolution (`exclude-newer`), so
a freshly compromised release cannot be pulled in by a routine sync.

## Tasks

```bash
just test        # the suite
just lint        # ruff check + format --check
just typecheck   # mypy, strict
just viewer      # build the profile viewer into docs/viewer
just docs        # serve the documentation locally
just docs-build  # build it the way CI does
just matrix      # python x polars grid
just canary      # live contract against the newest polars
just dev         # collector, Jaeger, Prometheus, Grafana + a sample workload
just urls        # where to look
```

## Tests

| Marker | Covers |
| --- | --- |
| `contract` | the shape of the polars observer interface, golden and live |
| `live` | real polars queries against the installed version |
| `e2e` | instrumentation installed, real queries, real exporters |
| `integration` | requires a running OTel collector |
| `bench` | overhead, gated on a budget |

The attribute reference is test-guarded: `tests/unit/test_docs.py` fails if a
declared attribute is missing from `docs/attributes.md`.

## The viewer

`viewer/` is a Vite + React app built to a single HTML file. `docs/viewer/` is
build output and is not committed — `just docs-build` and CI run `npm ci && npm
run build` first, so a docs build never ships a stale viewer.

It is not versioned or published to an index. It deploys with the docs site
whenever `docs/`, `viewer/` or `mkdocs.yml` change on `main`.

## Releasing

Tag-triggered, published with **PyPI Trusted Publishing** (OpenID Connect).
There is no API token in the repository or its secrets.

```bash
# 1. Move the Unreleased section of CHANGELOG.md under the new version
# 2. Bump __version__ in src/polars_telemetry/__init__.py
git commit -am "chore: release 0.1.0"
git tag v0.1.0
git push origin main --tags
```

hatchling reads the version from `src/polars_telemetry/__init__.py`, so that
file and the tag must agree. Pushing `main` deploys the docs and viewer;
pushing the tag runs the release pipeline. The two are independent.

`.github/workflows/release.yml` then runs: **verify** (the whole CI suite via
`workflow_call`) → **build** (`uv build` + `twine check`) → **testpypi** →
**smoke** (install the published wheel into a clean environment and import it)
→ **pypi** (SLSA provenance, publish, GitHub release).

### One-time setup

Four things live outside the repository and have to be set by hand.

**GitHub environments** — `testpypi` and `pypi` under **Settings →
Environments**. For each, under *Deployment branches and tags*, add the pattern
`v*` with the ref type set to **Tag**. The selector defaults to *Branch*, which
silently blocks every tag-triggered deploy. A required reviewer on `pypi` turns
publishing into a deliberate act rather than a consequence of pushing a tag.

**Trusted publishers** — a *pending* publisher on both
[pypi.org](https://pypi.org/manage/account/publishing/) and
[test.pypi.org](https://test.pypi.org/manage/account/publishing/); the two are
separate services with separate accounts.

| Field | Value |
| --- | --- |
| PyPI Project Name | `polars-telemetry` |
| Owner | repository owner |
| Repository name | `polars-telemetry` |
| Workflow name | `release.yml` |
| Environment name | `testpypi` or `pypi` |

OIDC claims are matched against these exactly. A renamed workflow file, a
blank environment name, an underscore in the project name, or a repository
transfer each break publishing until the publisher is updated.

**GitHub Pages** — **Settings → Pages → Source → GitHub Actions**.

## Commits

One line, [Conventional Commits](https://www.conventionalcommits.org/), no body.
