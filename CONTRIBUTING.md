# Contributing

## Setup

Needs uv, Node 22.12 or newer (viewer and docs) and Docker Compose (the local
stack).

```bash
uv sync --all-groups
```

Resolution ignores dependencies newer than 7 days (`exclude-newer`), so a
routine sync cannot pull in a freshly compromised release.

## Tasks

Every task is a nox session; CI calls the same sessions. nox is in the dev
group.

```bash
uv run nox -l              # list sessions
uv run nox                 # lint, typecheck and the suite

uv run nox -s test         # the suite
uv run nox -s lint         # ruff check + format --check
uv run nox -s typecheck    # mypy, strict
uv run nox -s viewer       # build the profile viewer into docs/viewer
uv run nox -s viewer-lock  # re-lock the viewer from releases at least 7 days old
uv run nox -s docs         # serve the documentation locally
uv run nox -s docs-build   # build it the way CI does
uv run nox -s matrix       # python x polars grid
uv run nox -s canary       # live contract against the newest polars
uv run nox -s dev          # the stack + a sample workload through it
uv run nox -s up / down    # just the stack
uv run nox -s influx       # add Telegraf and InfluxDB to it
```

With `influx` running, Telegraf takes OTLP on `localhost:4327` and DogStatsD on
`localhost:8125/udp`, and the Grafana dashboard `polars-statsd` charts what
arrives over DogStatsD. Send it histograms, which Telegraf summarises:
`DogStatsdExporter(DogStatsd(port=8125, ...), distributions=False)`.

Sessions declared `venv_backend="none"` run in the environment nox was started
from, so invoke them through `uv run`. Only `matrix` and `canary` build their
own environments, to install a specific polars.

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

| Docs test | Requires |
| --- | --- |
| `tests/unit/test_docs.py` | every semconv name and unit in `docs/reference/spans-and-metrics.md`; every `Config` option in the option tables of `README.md` and `docs/reference/configuration.md`; every insight rule as a heading in `docs/insights.md` |
| `tests/unit/test_doc_links.py` | every docs address linked from `README.md`, `viewer/src` and `src` to resolve |
| `tests/unit/test_doc_claims.py` | the quick-start snippets to run and print the expected CLI summary; the supported polars versions to match `compat.SUPPORTED`; the CLI options to match `docs/insights.md`; no counts in prose, as matched by `COUNTED` |

## Insight rules

Rules live in `src/polars_telemetry/model/insights/rules/`, one module each,
listed in `rules/__init__.py`. They read `NodeTraits` and the `PlanView`,
never polars' kind names or expression text: that knowledge belongs in
`adapter/dialect.py` and `adapter/traits.py`, whose live contract test runs on
every polars version.

To add one:

1. Write `rules/<id>.py`: a `Rule` with `check` (facts only, no data-size
   thresholds) returning evidence whose reported fields use `unit()`, and
   `describe` returning a title (the fact, one line) and a fix (imperative,
   one line, API names in backticks, no hedging, no why: that goes in the
   docs).
2. Add it to `RULES`.
3. Add a test pair to `tests/insights/test_rules.py`: a plan that shows the
   pattern, and the closest healthy one that must stay quiet.
4. Update `EXPECTED` in `tests/insights/test_corpus.py` if it fires on TPC-H,
   and say why in the comment beside it.
5. Add a heading ``### `<id>` `` to `docs/insights.md`. The viewer links each
   finding to `insights/#<id>`, so never rename an id or move the page.

A new fact about nodes goes into `NodeTraits`, read in `adapter/traits.py`
with a case in `tests/contract/test_live.py`.

## The viewer

`viewer/` is a Vite + React app built to a single HTML file. `docs/viewer/` is
build output and is not committed; the `docs-build` session builds the viewer
first.

`uv run nox -s viewer-test` runs its unit tests and a check that no bare CSS
selector is shared between components. CI runs it on Node 22.12, the oldest
supported.

`uv run nox -s viewer-fixture` regenerates `viewer/tests/fixtures/profile.json`
from the captured polars payloads, so the viewer's contract test cannot drift
from what the exporter writes.

It is not versioned or published to an index. It deploys with the docs site
whenever `docs/`, `viewer/`, `mkdocs.yml`, `pyproject.toml`, `uv.lock` or the
pages workflow change on `main`.

## Writing docs

- Show what to type, then what it prints. Paste real output from running the
  snippet, never an edited or invented one.
- The quick starts need nothing beyond `pip install polars-telemetry`; anything
  that needs an extra or a collector comes after.
- One page owns each fact; other pages link to it.
- Short, active sentences. Leave out motivation, history and hedging unless the
  reader acts on it.
- Options, comparisons and lists of cases go in tables.
- Don't count rules, exporters or metrics in prose; the numbers go stale.
- Headings are addresses. Don't rename one that is linked from code, the viewer
  or another page.
- `uv run nox -s docs-build` builds strictly: a broken link or anchor fails.

## Releasing

Tag-triggered, published with **PyPI Trusted Publishing** (OpenID Connect).
There is no API token in the repository or its secrets.

1. On a branch `release-X.Y.Z`: move the Unreleased section of `CHANGELOG.md`
   under the new version, bump `__version__` in
   `src/polars_telemetry/_version.py`, re-record `examples/` with the TPC-H
   runner and run `uv run nox -s viewer-fixture`.
2. Run the suite against every polars version in the CI matrix.
3. Open a PR and merge it.
4. Tag the merge commit and push the tag:

```bash
git tag vX.Y.Z <merge commit>
git push origin vX.Y.Z
```

hatchling reads the version from `src/polars_telemetry/_version.py`, so that
file and the tag must agree. The tag runs the release pipeline; the docs and
viewer deploy from `main` as described above.

`.github/workflows/release.yml` then runs: **verify** (the whole CI suite via
`workflow_call`) → **build** (`uv build` + `twine check`) → **testpypi** →
**smoke** (install the published wheel into a clean environment and import it)
→ **pypi** (SLSA provenance, publish, GitHub release).

### One-time setup

These live outside the repository and are set by hand.

**GitHub environments** — `testpypi` and `pypi` under **Settings →
Environments**. For each, under *Deployment branches and tags*, add the pattern
`v*` with the ref type set to **Tag**. The selector defaults to *Branch*, which
silently blocks every tag-triggered deploy. A required reviewer on `pypi` makes
publishing need an approval, not just a pushed tag.

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
