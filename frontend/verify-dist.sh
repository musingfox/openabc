#!/usr/bin/env bash
# verify-dist.sh — Anti-drift guard for frontend/dist.
# Builds the frontend into a temporary directory and diffs it against the
# committed dist/. If they differ (source changed but dist not rebuilt and
# re-committed), this script exits non-zero. Exit 0 = no drift.
# Usage: bash frontend/verify-dist.sh  (from any working directory)

set -e

cd "$(dirname "$0")"

TMPDIR_BUILD="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUILD"' EXIT

bun install --frozen-lockfile

# Build into a temp location, leaving the committed dist/ untouched.
bun run build -- --outDir "$TMPDIR_BUILD/dist" --emptyOutDir

# Compare committed dist/ against the fresh build.
diff -r dist "$TMPDIR_BUILD/dist"
