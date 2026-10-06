# Python API

Generated from the docstrings. Names without a module, such as `install`, are
importable from `polars_telemetry`; the others show their module.

## Instrumenting

::: polars_telemetry.install

::: polars_telemetry.uninstall

::: polars_telemetry.Config

::: polars_telemetry.activation.Installation
    options:
      show_root_full_path: true

::: polars_telemetry.compat.Capabilities
    options:
      show_root_full_path: true

## Masking

::: polars_telemetry.Redaction

::: polars_telemetry.redacted

## Labelling and scoping

::: polars_telemetry.label

::: polars_telemetry.profile

::: polars_telemetry.Session

## Exporters

::: polars_telemetry.export.otel.OTelExporter
    options:
      show_root_full_path: true

::: polars_telemetry.export.dogstatsd.DogStatsdExporter
    options:
      show_root_full_path: true

::: polars_telemetry.export.file.FileExporter
    options:
      show_root_full_path: true

::: polars_telemetry.export.console.ConsoleExporter
    options:
      show_root_full_path: true

::: polars_telemetry.export.base.Exporter
    options:
      show_root_full_path: true

## What an exporter receives

::: polars_telemetry.model.types.Query
    options:
      show_root_full_path: true

::: polars_telemetry.model.insights.Finding
    options:
      show_root_full_path: true

::: polars_telemetry.model.types.CustomMetric
    options:
      show_root_full_path: true
