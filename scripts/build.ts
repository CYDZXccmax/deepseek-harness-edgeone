/**
 * Build repository artifacts, type-check the aggregate test and script programs, or both.
 *
 * `--scope artifacts` emits every artifact and binds the client outputs to their public environment;
 * `--scope check` type-checks only the Host and Client aggregate programs against the package
 * declarations already on disk; the default runs both step sets as one dependency graph, so the
 * aggregate checks overlap the remaining artifact steps. `--scope typecheck` (`pnpm run typecheck`)
 * type-checks every package project and both aggregate programs; beside Host compilation it writes
 * the Typert declarations that Client compilation imports, without bundling.
 */

import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  CLIENT_BUILD_RECORD_PATH,
  CLIENT_BUILD_PROFILE_SELECTOR,
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
  writeClientBuildRecord,
} from './client-build-environment.ts'
import { aggregateBuildArgs, aggregateCheckArgs, contractSteps, libraryBuildSteps } from './compile-referenced-projects.ts'
import type { LibraryStep } from './compile-referenced-projects.ts'
import { pnpmCommand } from './release/process.ts'
import { defaultParallelism, describeDefaultParallelism } from './parallelism.ts'
import { runAggregate } from './run-gates.ts'
import type { Gate } from './run-gates.ts'

/**
 * Steps one build invocation runs: every artifact and check, only artifacts, only aggregate checks,
 * or every type check with the generated Typert declarations it needs.
 */
export type BuildScope = 'complete' | 'artifacts' | 'check' | 'typecheck'

/** Parsed command-line selection of one build invocation. */
export interface BuildArguments {
  readonly scope: BuildScope
  /** Client build profile requested by `--profile`; `complete` and `artifacts` scopes only. */
  readonly profile: string | undefined
}

/**
 * Parse the build command line.
 * @param args - Arguments after the script path.
 * @returns The selected scope and requested client build profile.
 * @throws If an option is unknown, the scope is not `artifacts`, `check`, or `typecheck`,
 *   or `--profile` accompanies `--scope check` or `--scope typecheck`.
 */
export function parseBuildArguments(args: readonly string[]): BuildArguments {
  const { values } = parseArgs({
    args: [...args],
    options: {
      profile: { type: 'string' },
      scope: { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values.scope !== undefined && values.scope !== 'artifacts' && values.scope !== 'check' && values.scope !== 'typecheck') {
    throw new Error(`build: --scope must be artifacts, check, or typecheck, got ${JSON.stringify(values.scope)}; omit it for the complete build`)
  }
  const scope: BuildScope = values.scope ?? 'complete'
  if ((scope === 'check' || scope === 'typecheck') && values.profile !== undefined) {
    throw new Error(`build: --profile selects artifact values and does not apply to --scope ${scope}`)
  }
  return { scope, profile: values.profile }
}

/**
 * Construct the build steps of one scope as a gate dependency graph.
 * Artifact steps keep the serial order native, Host compilation, Host bundle (Typert),
 * Desktop bundle, Client compilation, Client bundle, then Web. `DSH_HOST_BUNDLE_SHARDS`
 * replaces the Host bundle step with that many sequential passes, each over one batch of
 * workspace packages; see {@link artifactGates}. The typecheck scope runs Host
 * compilation beside the bundle-free Typert pass, which reads only source, and then Client
 * compilation, which needs both outputs; it writes no bundle. In the complete and typecheck
 * scopes each aggregate check waits only for its own face's package compilation; alone, the
 * checks have no predecessors and read whatever declarations already exist. The typecheck scope
 * checks aggregates in build mode, which skips a program whose tsbuildinfo is current; the other
 * scopes use project mode, which compiles no reference.
 * @param root - Repository root containing the compiler and bundle configurations.
 * @param scope - Steps to include.
 * @param environment - Environment overlay applied to every step; the parent value of a key mapped to `undefined` is removed.
 * @returns The gate graph in report order.
 * @throws If an aggregate configuration is invalid.
 */
export function buildGates(
  root: string,
  scope: BuildScope,
  environment: Readonly<Record<string, string | undefined>> = {},
): Gate[] {
  const env = { ...environment }
  const gates: Gate[] = []
  if (scope === 'complete' || scope === 'artifacts') {
    gates.push(pnpmGate('native', 'native addon', ['run', 'build:native-system'], [], env))
    for (const gate of artifactGates(root, env)) gates.push(gate)
    gates.push(pnpmGate('web', 'Web build', ['run', 'build:web'], ['client-bundle'], env))
  }
  if (scope === 'typecheck') {
    for (const step of contractSteps(root, 'all')) gates.push(libraryGate(step, step.needs, env))
  }
  if (scope !== 'artifacts') {
    for (const face of ['host', 'client'] as const) {
      gates.push({
        id: `${face}-check`,
        label: `${face} aggregate check`,
        displayCommand: `tsc ${scope === 'typecheck' ? '-b' : '-p'} tsconfig.${face}.json`,
        command: process.execPath,
        args: scope === 'typecheck' ? aggregateBuildArgs(face) : aggregateCheckArgs(face),
        // No Host aggregate file imports a generated `/typert` or `/remote` subpath, so
        // host-check never reads what a concurrent host-typert step writes.
        needs: scope === 'check' ? [] : [`${face}-src`],
        env,
      })
    }
  }
  return gates
}

/** Most sequential batches one build may split the Host bundler pass into. */
const HOST_BUNDLE_SHARD_LIMIT = 8

/**
 * Read how many sequential batches the Host bundler pass runs in.
 * @param configured - Raw `DSH_HOST_BUNDLE_SHARDS` value, absent when unset.
 * @returns The batch count, `1` when unset or empty.
 * @throws If the value is not a decimal integer from 1 through `HOST_BUNDLE_SHARD_LIMIT`.
 */
function hostBundleShards(configured: string | undefined): number {
  if (configured === undefined || configured === '') return 1
  const shards = Number.parseInt(configured, 10)
  if (!Number.isSafeInteger(shards) || shards < 1 || shards > HOST_BUNDLE_SHARD_LIMIT || String(shards) !== configured) {
    throw new Error(`build: DSH_HOST_BUNDLE_SHARDS must be a decimal integer from 1 to ${String(HOST_BUNDLE_SHARD_LIMIT)}, got ${JSON.stringify(configured)}`)
  }
  return shards
}

/**
 * List the artifact gates from Host compilation through the Client bundle, splitting the Host
 * bundler pass when asked.
 *
 * `DSH_HOST_BUNDLE_SHARDS` runs the Host bundler as that many sequential passes over disjoint
 * batches of workspace packages. A host under a hard memory ceiling needs it because tsdown
 * bundles every workspace member concurrently inside one process, while the Typert pass adds a
 * second TypeScript program in its own Worker Thread beside those builds. One pass per batch
 * bounds both, and each pass exits before the next starts. Split passes take their Typert
 * artifacts from the bundle-free pass that reads source only, so generation happens once.
 * @param root - Repository root containing the compiler and bundle configurations.
 * @param env - Environment overlay applied to every step.
 * @returns The gates in report order, each waiting for its predecessor.
 * @throws If the batch count or an aggregate configuration is invalid.
 */
function artifactGates(root: string, env: Record<string, string | undefined>): Gate[] {
  const shards = hostBundleShards(process.env.DSH_HOST_BUNDLE_SHARDS)
  const gates: Gate[] = []
  let previous = 'native'
  for (const step of libraryBuildSteps(root, 'all')) {
    if (step.id !== 'host-bundle' || shards === 1) {
      gates.push(libraryGate(step, [previous], env))
      previous = step.id
      continue
    }
    const typert = contractSteps(root, 'host').find(candidate => candidate.id === 'host-typert')
    if (typert === undefined) throw new Error('build: the Host contract steps no longer list host-typert')
    gates.push(libraryGate(typert, [previous], env))
    previous = typert.id
    for (let index = 1; index <= shards; index += 1) {
      const batch = `${String(index)}/${String(shards)}`
      const id = index === shards ? 'host-bundle' : `host-bundle-${String(index)}`
      gates.push({
        ...libraryGate(step, [previous], { ...env, DSH_TSUND_TYPERT: '0', DSH_TSUND_SHARD: batch }),
        id,
        label: `${step.label} ${batch}`,
      })
      previous = id
    }
  }
  return gates
}

function libraryGate(step: LibraryStep, needs: readonly string[], env: Record<string, string | undefined>): Gate {
  return {
    id: step.id,
    label: step.label,
    displayCommand: step.displayCommand,
    command: step.command,
    args: [...step.args],
    needs: [...needs],
    env,
  }
}

function pnpmGate(
  id: string,
  label: string,
  args: readonly string[],
  needs: readonly string[],
  env: Record<string, string | undefined>,
): Gate {
  const [command, ...prefix] = pnpmCommand()
  return { id, label, displayCommand: `pnpm ${args.join(' ')}`, command, args: [...prefix, ...args], needs: [...needs], env }
}

/**
 * Express a complete child environment as an overlay on the parent environment.
 * @param parent - Environment the gate executor merges the overlay into.
 * @param child - Complete environment every step must observe.
 * @returns `child` plus an `undefined` entry for each parent key it omits.
 */
function environmentOverlay(parent: NodeJS.ProcessEnv, child: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return { ...Object.fromEntries(Object.keys(parent).map(name => [name, undefined])), ...child }
}

async function main(): Promise<number> {
  // tsdown.config.ts loads only through Node type stripping (`--config-loader native`); this names the cause before tsdown fails.
  if (!process.features.typescript) {
    throw new Error('build: Node.js TypeScript type stripping is unavailable in this Node.js process; remove --no-experimental-strip-types from NODE_OPTIONS or use a Node.js build with TypeScript support')
  }
  const { scope, profile } = parseBuildArguments(process.argv.slice(2))
  const root = resolve(import.meta.dirname, '..')
  const name = scope === 'complete' ? 'build' : scope === 'typecheck' ? 'typecheck' : `build:${scope}`
  const budget = defaultParallelism()
  const workers = (gates: readonly Gate[]) => ({
    workers: Math.min(gates.length, budget),
    source: describeDefaultParallelism(),
  })
  if (scope === 'check' || scope === 'typecheck') {
    const gates = buildGates(root, scope)
    return runAggregate(name, gates, workers(gates))
  }

  const repositoryEnvironment = repositoryClientBuildEnvironment(root, process.env)
  const clientEnvironment = resolveClientBuildEnvironment(repositoryEnvironment, profile ?? process.env[CLIENT_BUILD_PROFILE_SELECTOR])
  const environment = environmentOverlay(process.env, clientBuildProcessEnvironment(process.env, clientEnvironment))
  rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
  const gates = buildGates(root, scope, environment)
  const exitCode = await runAggregate(name, gates, workers(gates))
  if (exitCode !== 0) return exitCode
  const record = writeClientBuildRecord(root, clientEnvironment)
  console.log(
    `build: recorded ${String(record.artifacts.fileCount)} client artifact(s) with ${String(Object.keys(record.environment).length)} public value(s)`,
  )
  return 0
}

if (import.meta.main) process.exitCode = await main()
