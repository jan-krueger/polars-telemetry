# Releasing

Releases are tag-triggered and published with **PyPI Trusted Publishing**
(OpenID Connect). No API token exists anywhere in the repository or its
secrets, so there is none to leak or rotate.

## How the pipeline runs

Pushing a `v*` tag runs `.github/workflows/release.yml`:

1. **verify** — re-runs the entire CI suite via `workflow_call`.
2. **build** — `uv build`, then `twine check` on the artifacts.
3. **testpypi** — publishes to TestPyPI through Trusted Publishing.
4. **smoke** — installs the published wheel into a clean environment and
   imports it. A package that builds but cannot be installed is still broken.
5. **pypi** — attaches SLSA build provenance, publishes to PyPI, and creates
   the GitHub release.

`pypa/gh-action-pypi-publish` also generates [PEP 740](https://peps.python.org/pep-0740/)
attestations for the uploaded files by default.

## One-time setup

The workflow is only half of it; the other half lives in each index's
settings and has to be done by hand once.

### 1. GitHub environments

Create two environments under **Settings → Environments**:

| Environment | Used by |
| --- | --- |
| `testpypi` | the TestPyPI publish job |
| `pypi` | the PyPI publish job |

Adding a required reviewer to `pypi` is worth it: it turns publishing into a
deliberate act rather than a consequence of pushing a tag.

### 2. Trusted publisher on PyPI

On [pypi.org](https://pypi.org/manage/account/publishing/), add a **pending
publisher** (the project does not exist yet, so it cannot be configured from a
project page):

| Field | Value |
| --- | --- |
| PyPI project name | `polars-telemetry` |
| Owner | your GitHub user or organisation |
| Repository name | `polars-telemetry` |
| Workflow name | `release.yml` |
| Environment name | `pypi` |

### 3. Trusted publisher on TestPyPI

Repeat on [test.pypi.org](https://test.pypi.org/manage/account/publishing/)
with environment name `testpypi`.

!!! warning "The values must match exactly"
    OIDC claims are checked against these four fields. A renamed workflow file,
    a different environment name, or a repository transfer all break publishing
    until the publisher is updated.

## Cutting a release

```bash
# 1. Move the Unreleased section of CHANGELOG.md under the new version
# 2. Bump __version__ in src/polars_telemetry/__init__.py
git commit -am "chore: release 0.1.0"
git tag v0.1.0
git push origin main --tags
```

The version is read from `src/polars_telemetry/__init__.py` by hatchling, so
that file and the tag must agree.
