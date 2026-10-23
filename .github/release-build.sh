#!/usr/bin/env bash
# Build the release assets for one version into dist/release/ (ignored by git):
#   villanelle-<version>.tgz                 npm pack of ts/
#   villanelle-<version>-py3-none-any.whl    uv build of py/ (wheel)
#   villanelle-<version>.tar.gz              uv build of py/ (sdist)
# The version is stamped into ts/package.json and py/pyproject.toml for the build only; both files get their
# committed bytes back on exit, so the version is never committed. Run by semantic-release's prepare step
# (.releaserc.json) and, in dry-run, by the release job in .github/workflows/ci.yml.
# Needs: Node 24 with corepack, ts/ dependencies installed, Java 11+ (tools/gen.sh), uv.
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:?usage: .github/release-build.sh <version>}"
out=dist/release

saved=$(mktemp -d)
cp ts/package.json py/pyproject.toml "$saved/"
restore() { cp "$saved/package.json" ts/package.json; cp "$saved/pyproject.toml" py/pyproject.toml; rm -rf "$saved"; }
trap restore EXIT

rm -rf "$out"
mkdir -p "$out"

npm pkg set --prefix ts version="$version"
corepack pnpm -C ts build
npm pack ./ts --pack-destination "$out"

uv version --project py --frozen "$version"
bash tools/gen.sh py
uv build --out-dir "$out" py

ls -l "$out"
