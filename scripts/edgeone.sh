#!/usr/bin/env bash
# Run one EdgeOne Pages build phase on the Node.js version this repository needs.
#
# EdgeOne Pages can only switch between the Node.js versions its image carries,
# and the newest of those is 22.11.0, which the build scripts do not support:
# `import.meta.main` is undefined there and TypeScript type stripping is off by
# default. Both phases therefore unpack the pinned release into `.edgeone/node`
# and put it ahead of the image's interpreter, so `node`, `npm` and `pnpm` all
# resolve to one supported runtime. The phases share a checkout, so `build`
# normally reuses what `install` downloaded.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node_version="${EDGEONE_NODE_VERSION:-22.19.0}"
node_root="$root/.edgeone/node"

log() { printf 'edgeone: %s\n' "$*"; }

cd "$root"

# Put the pinned Node.js first on PATH, unpacking it on first use.
prepare_node() {
  if [ -x "$node_root/bin/node" ] && [ "$("$node_root/bin/node" --version)" = "v$node_version" ]; then
    log "reusing Node.js v$node_version from $node_root"
  else
    log "unpacking Node.js v$node_version into $node_root"
    node "$root/scripts/edgeone/download-node.mjs" "$node_root"
  fi
  PATH="$node_root/bin:$PATH"
  export PATH
  # Drop the interpreter the previous PATH lookup cached, so `node`, `npm` and
  # anything installed next resolve inside the unpacked release.
  hash -r
  log "node $(node --version), npm $(npm --version)"
}

# Install the workspace exactly as the lockfile describes.
#
# `--ignore-scripts` is deliberate: the root postinstall installs git hooks and
# the dependency scripts fetch Electron binaries and build toolchains, none of
# which a Web artifact needs. Omitting them also keeps the step inside the
# 20-minute build budget.
install_dependencies() {
  prepare_node
  npm install --global pnpm@11.28.5 --no-fund --no-audit
  log "pnpm $(pnpm --version)"
  pnpm install --frozen-lockfile --ignore-scripts
}

build_artifacts() {
  prepare_node
  pnpm run build:edgeone
}

case "${1:-}" in
  install) install_dependencies ;;
  build) build_artifacts ;;
  *)
    printf 'usage: %s install|build\n' "$0" >&2
    exit 2
    ;;
esac
