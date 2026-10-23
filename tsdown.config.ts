import { globSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'
import { WORKSPACE_TYPERT_FACES } from './scripts/typert-faces.ts'
import { workspacePackageGlobs } from './scripts/workspace-package-globs.ts'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * Read the batch selector that splits one pass into sequential builds.
 *
 * A pass bundles every workspace member concurrently inside one process, so its peak memory
 * grows with the member count. A build host with a hard memory ceiling runs several passes
 * instead, each over one batch of members: `DSH_TSUND_SHARD=2/3` builds the second of three.
 * @param configured - Raw `DSH_TSUND_SHARD` value, absent when the pass builds everything.
 * @returns The selected batch and the batch count, or `undefined` for one whole pass.
 * @throws If the value is not `index/total` with `1 <= index <= total <= 99`.
 */
function workspaceShard(configured: string | undefined): { readonly index: number; readonly total: number } | undefined {
  if (configured === undefined || configured === '') return undefined
  const match = /^(\d{1,2})\/(\d{1,2})$/u.exec(configured)
  const index = match === null ? Number.NaN : Number(match[1])
  const total = match === null ? Number.NaN : Number(match[2])
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`tsdown: DSH_TSUND_SHARD must be index/total with 1 <= index <= total, received ${JSON.stringify(configured)}`)
  }
  return { index, total }
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact. `apps/desktop` bundles after
 * this pass (root package.json `build:lib:host`): its main bundle inlines
 * workspace devDependencies from their lib/ output, and tsdown builds
 * workspace members concurrently without ordering them.
 *
 * Two variables let a memory-constrained host reshape the pass without changing what it
 * produces. `DSH_TSUND_SHARD` narrows it to one batch of members, which the build runs once
 * per batch. `DSH_TSUND_TYPERT=0` leaves Typert artifact generation to the standalone pass
 * that reads source; the plugin stays because its transform is what lowers source decorators,
 * and a bundle that kept them would fail every JavaScript parser downstream.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  const packages = workspacePackageGlobs(globSync(['vendor/*/package.json', 'packages/*/*/package.json'], { cwd: import.meta.dirname }))
  const members = [...packages, 'apps/cli', ...client ? [] : ['apps/desktop-host']]
  const shard = workspaceShard(process.env.DSH_TSUND_SHARD)
  return {
    workspace: shard === undefined ? members : members.filter((_, position) => position % shard.total === shard.index - 1),
    entry: client ? '' : ['lib/types/{index,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({
      mode: 'workspace',
      faces: WORKSPACE_TYPERT_FACES,
      artifacts: process.env.DSH_TSUND_TYPERT !== '0',
    })],
  }
})
