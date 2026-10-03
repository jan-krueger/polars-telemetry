# Contributing

## Setup

```bash
uv sync --all-groups
```

Dependencies newer than 7 days are ignored by resolution (`exclude-newer`), so
a freshly compromised release cannot be pulled in by a routine sync.

## Tasks

Every task is a nox session, and CI calls the same ones — so there is a single
definition of what "lint" means. nox is in the dev group, so there is nothing
extra to install.

```bash
uv run nox -l              # list sessions
uv run nox                 # lint, typecheck and the suite

uv run nox -s test         # the suite
uv run nox -s lint         # ruff check + format --check
uv run nox -s typecheck    # mypy, strict
uv run nox -s viewer       # build the profile viewer into docs/viewer
uv run nox -s docs         # serve the documentation locally
uv run nox -s docs-build   # build it the way CI does
uv run nox -s matrix       # python x polars grid
uv run nox -s canary       # live contract against the newest polars
uv run nox -s dev          # the stack + a sample workload through it
uv run nox -s up / down    # just the stack
```

Sessions declared `venv_backend="none"` run in the environment nox was started
from, which is why they are invoked through `uv run`. Only `matrix`, `canary`
and `bench` build their own environments, because they need a specific polars
or a quiet machine.

Arguments pass through after `--`:

```bash
uv run nox -s test -- -k fingerprint -x
uv run nox -s capture -- 1.44.2
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
build output and is not committed — the `docs-build` session builds the viewer
first, so a docs build never ships a stale one.

It is not versioned or published to an index. It deploys with the docs site
whenever `docs/`, `viewer/` or `mkdocs.yml` change on `main`.

## Releasing

Tag-triggered, published with **PyPI Trusted Publishing** (OpenID Connect).
There is no API token in the repository or its secrets.

```bash
# 1. Move the Unreleased section of CHANGELOG.md under the new version
# 2. Bump __version__ in src/polars_telemetry/__init__.py
git commit -am "chore: release X.Y.Z"
git tag vX.Y.Z
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
