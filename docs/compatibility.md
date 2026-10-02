# Compatibility

## Supported versions

**polars 1.44.1 and newer 1.44.x.**

The observer hook does not exist before 1.44.0, and 1.44.0's runtime is yanked
(a `when/then/otherwise` regression), so 1.44.1 is the floor. There is nothing
older to support.

polars is declared with a floor and no upper pin, so a newer polars never
causes a resolver conflict. What happens instead is described below.

## What happens on an unknown polars

`install()` runs a capability probe: a trivial monitored query whose payloads
are checked against the known contract. It costs milliseconds and runs once.

| Probe result | Behaviour |
| --- | --- |
| Everything as expected | Full instrumentation |
| Plan or metrics payloads off-contract | Query spans only, with a warning |
| Callbacks never fire | Not installed, with a warning; `install()` returns `None` |
| No monitoring API at all | Not installed, with a warning |

Your queries keep working in every case.

## How we find out before you do

A nightly CI job installs the newest polars — pre-releases included — and runs
the live contract test against it. On failure it opens an issue. The intent is
to learn about a breaking change while it is still a release candidate.

The supply-chain quarantine that normally ignores releases newer than 7 days is
lifted for `polars` alone in that job.

## If the interface goes away

Everything rests on a private arrangement between two first-party packages. If
polars removes or changes it, the probe degrades or declines, and the package
keeps your queries running while emitting less — or nothing.

Worth knowing: `polars-cloud` pins `polars==1.44.2` *exactly*, not a range. The
vendor treats this contract as version-locked too.
