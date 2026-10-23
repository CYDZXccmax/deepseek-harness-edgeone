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

# Pack the Web Worker image and make the worker page the served page.
#
# `vite build` emits two pages over one chunk set: index.html, which only boots
# once `dsh web` injects window.__DSH_BOOT__ and serves the module loader, and
# preview.html, which carries one extra module tag that starts the Worker host
# against the image packed below. A static host serves no `dsh web`, so the
# deployment root has to be the worker page; serving index.html instead loads a
# shell that fails its first boot with "bootstrap facade is missing".
preview_deployment() {
  prepare_node
  local dist="$root/apps/web/dist"
  if [ ! -f "$dist/preview.html" ]; then
    printf 'edgeone: %s is missing; the web gate did not emit the worker page\n' "$dist/preview.html" >&2
    exit 1
  fi
  log "packing the Web Worker image"
  pnpm --filter @deepseek-ai/dsh-web-frontend exec dsh-pack-vfs-image --out dist/preview/vfs-image.tar.gz
  # Source maps would publish the whole module graph and only inflate the upload.
  find "$dist" -name '*.map' -delete
  cp "$dist/preview.html" "$dist/index.html"
  log "serving the worker page from $dist/index.html"
}

case "${1:-}" in
  install) install_dependencies ;;
  build) build_artifacts; preview_deployment ;;
  *)
    printf 'usage: %s install|build\n' "$0" >&2
    exit 2
    ;;
esac
