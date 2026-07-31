# Changelog

## [Unreleased]

### Added

- Added the experimental transport-neutral `PiClient` and multi-session `PiSessionHandle` APIs with structured `PiServerError` responses.
- Added `PiClient.connect()`, idempotent asynchronous disposal, and `AsyncDisposable` support for explicit connection ownership.

### Changed

- Changed session attachments to explicit shared or exclusive `SessionLease` objects so independent consumers cannot detach each other's connection-level session or conflict with an exclusive coordinator.
