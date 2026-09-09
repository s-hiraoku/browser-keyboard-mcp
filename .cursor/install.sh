#!/usr/bin/env bash
set -euo pipefail

# Install pinned Node dependencies from the lockfile.
npm ci

# Download the Chromium build Playwright expects and its OS-level runtime
# libraries. Both steps are idempotent: already-present browsers and packages
# are detected and skipped on later runs.
npx playwright install --with-deps chromium
