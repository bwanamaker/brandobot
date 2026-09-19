# Changelog

All notable changes to this project are documented here.

## [0.3.0] - 2026-09-15

### Added

- Added the `run_ui_test` tool for running temporary TypeScript Playwright Test specs with a bundled `@playwright/test` runner.
- Added managed Chromium downloads shared by the `browser` and `run_ui_test` tools.
- Added bounded structured test results with temporary trace, screenshot, and video evidence.
- Added bounded runner timeouts and best-effort cancellation cleanup.
- Added documentation for code-execution permissions and temporary-test limitations.

### Changed

- Pinned Playwright dependencies so the CLI and test runner share one browser cache.
- Expanded Playwright environment sanitization to inherited debug configuration.
- Stripped ANSI escape codes from test results and diagnostics.

### Fixed

- Fixed an abort-listener leak when waiting for Chromium installation.
- Fixed plugin startup by preventing helper exports from being treated as legacy plugins.
- Restored previously published named helper exports through OpenCode's plugin-module API.
- Guarded Chromium detection against malformed non-array arguments.
- Kept ephemeral-workspace cleanup inside Brandobot's private temporary directory.
- Marked runs without a usable Playwright JSON report as unverified instead of passing.
- Validated Playwright's Chromium installation completion marker before reuse.
- Restricted browser CLI commands that can install dependencies, import or export browser state, or execute local code.
- Excluded generated OpenCode plugin output from linting.

## [0.2.1] - 2026-09-13

### Fixed

- Corrected the README Node.js version requirement.

## [0.2.0] - 2026-09-13

### Added

- Added ESLint with TypeScript support.
- Added pull-request validation in GitHub Actions for linting, typechecking, tests, and builds.
- Added tag-based npm staged publishing with Trusted Publishing support.
- Added a pinned Bun version for reproducible CI installs.

### Changed

- Raised the minimum supported Node.js version to 22.22.2.

## [0.1.1] - 2026-09-10

### Added

- Added npm package installation documentation.

### Changed

- Updated the package for public scoped npm publishing.

## [0.1.0] - 2026-09-10

### Added

- Added the Brandobot OpenCode plugin.
- Added the `open_url` tool for opening URLs in the system browser.
- Added the `browser` tool for Playwright CLI automation.
- Added isolated browser sessions and artifact handling.
