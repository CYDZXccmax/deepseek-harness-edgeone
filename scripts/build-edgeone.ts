/**
 * Build the Web deployment artifacts on a memory-constrained host, as an EdgeOne Pages build does.
 *
 * The artifact scope schedules up to eight gates at once, and each compiler or bundler holds its
 * own heap, so a container near 6 GB has to serialize them and lower the ceilings. This entrypoint
 * supplies those values only where the environment leaves them unset, then runs the artifact scope
 * once, so a larger host raises any of them by exporting the same names before the build.
 */

import { spawnSync } from 'node:child_process'
import { pnpmCommand } from './release/process.ts'

/** Build environment the low-memory host selects, each overridable by exporting it beforehand. */
const LOW_MEMORY_DEFAULTS = {
  // One gate at a time: the peak is then the largest single gate rather than their sum.
  DSH_GATE_CONCURRENCY: '1',
  // Host `tsc` projects the whole symbol graph; 3072 MiB leaves room for its non-heap footprint.
  DSH_HOST_TSC_HEAP_MB: '3072',
  // Rollup keeps the module graph twice while writing maps; this host ships without them.
  DSH_WEB_SOURCEMAP: '0',
  // tsdown bundles all 342 workspace members at once; three passes bound that peak, and the
  // first one takes Typert from the bundle-free pass instead of a second program in-process.
  DSH_HOST_BUNDLE_SHARDS: '3',
} as const

/** Heap ceiling every child that inherits `NODE_OPTIONS` observes. */
const NODE_OPTIONS_HEAP = '--max-old-space-size=3072'

/**
 * Apply the low-memory defaults to one environment.
 * @param environment - Parent environment the child build inherits.
 * @returns A copy carrying each default the parent leaves unset, and the heap flag when it lacks one.
 */
function lowMemoryEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const unset = Object.entries(LOW_MEMORY_DEFAULTS)
    .filter(([name]) => environment[name] === undefined || environment[name] === '')
  const resolved: NodeJS.ProcessEnv = { ...environment, ...Object.fromEntries(unset) }
  const nodeOptions = environment.NODE_OPTIONS ?? ''
  if (!/--max-old-space-size/u.test(nodeOptions)) {
    resolved.NODE_OPTIONS = `${nodeOptions} ${NODE_OPTIONS_HEAP}`.trim()
  }
  return resolved
}

const environment = lowMemoryEnvironment(process.env)
const applied = Object.keys(LOW_MEMORY_DEFAULTS).filter(name => process.env[name] !== environment[name])
if (applied.length > 0) console.log(`build-edgeone: low-memory defaults ${applied.join(', ')}`)
const [command, ...prefix] = pnpmCommand()
const result = spawnSync(command, [...prefix, 'run', 'build:artifacts'], { stdio: 'inherit', env: environment })
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
