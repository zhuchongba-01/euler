# @earendil-works/pi-telemetry

Vendor-neutral telemetry contracts and typed schema utilities for pi packages.

This package contains no exporter and depends on no telemetry backend. Applications provide a `TelemetryContext` adapter; pi packages pass contexts explicitly and define their own domain schemas.
