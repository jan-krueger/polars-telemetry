# Security

## Reporting

Report vulnerabilities privately via GitHub's "Report a vulnerability" button
on the Security tab, or by email to jan@krueger-jan.de. Expect an
acknowledgement within 5 working days.

Please do not open a public issue for a vulnerability.

## What this package sends

Instrumentation exports query plan detail — file paths, column names, and
literal predicate values — to whichever OTLP endpoint the host application has
configured. That is by design; see "Data in your telemetry" in the README for
how to restrict it.

The package opens no network connections of its own. Export is performed by
the OpenTelemetry SDK the application configures.

## Supply chain

- Dependency resolution applies a 7-day quarantine (`exclude-newer = "7 days"`)
  so a freshly compromised release is not picked up before it is caught. The
  nightly canary lifts it for `polars` alone.
- `uv.lock` is committed; CI installs with `--locked`.
- `pip-audit` and `osv-scanner` run on every pull request.
- Releases are published with PyPI Trusted Publishing (OIDC); no API token
  exists. Artifacts carry build provenance attestations.
- GitHub Actions are pinned and updated by Dependabot with a 7-day cooldown.
