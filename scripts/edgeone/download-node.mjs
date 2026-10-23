/**
 * Unpack the pinned Node.js release that the EdgeOne Pages build runs on.
 *
 * EdgeOne Pages switches between a fixed set of Node.js versions and refuses
 * every other one: a project pinned to 22.19.0 fails before the first command
 * with `Switching error: Failed to switch to Node.js 22.19.0`. This repository
 * needs 22.19.0 because the build scripts test `import.meta.main` and rely on
 * Node's default TypeScript type stripping, so the build fetches the official
 * release itself and runs every later step on that interpreter.
 *
 * The official archive carries `include/node`, the headers the Host native gate
 * compiles its Node-API addon against, so nothing else has to be downloaded.
 *
 * Usage: `node scripts/edgeone/download-node.mjs <target directory>`.
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Node.js release to install; `package.json` engines require `^22.19.0 || >=24.0.0`. */
const NODE_VERSION = process.env.EDGEONE_NODE_VERSION ?? '22.19.0'

/** Release archive name for the machine running this script. */
function archiveName() {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `node-v${NODE_VERSION}-${platform}-${arch}.tar.gz`
}

/**
 * Release archive URLs tried in order. The mirror answers inside mainland
 * China, which is where the build runs; nodejs.org is the fallback.
 * @param name - Archive file name from {@link archiveName}.
 * @returns Absolute URLs in preference order.
 */
function archiveUrls(name) {
  return [
    `https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}/${name}`,
    `https://nodejs.org/dist/v${NODE_VERSION}/${name}`,
  ]
}

/**
 * Report the version a node binary prints.
 * @param binary - Path to a candidate `node` executable.
 * @returns The version without its leading `v`, or `undefined` when the binary is absent or fails.
 */
function reportedVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  const printed = result.status === 0 ? result.stdout.trim() : ''
  return printed.startsWith('v') ? printed.slice(1) : undefined
}

/**
 * Stream one archive to disk.
 * @param url - Archive URL.
 * @param destination - File to write.
 * @throws When the server answers with a failing status or no body.
 */
async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (response.body === null) throw new Error('empty response body')
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

/**
 * Fetch and unpack the pinned release into `target`.
 * @param target - Directory that should end up holding `bin/`, `lib/` and `include/`.
 * @throws When every mirror fails, `tar` fails, or the unpacked binary reports another version.
 */
async function install(target) {
  const name = archiveName()
  const archive = join(dirname(target), name)
  const staging = `${target}.staging`
  await mkdir(dirname(target), { recursive: true })

  const failures = []
  let downloaded = false
  for (const url of archiveUrls(name)) {
    try {
      process.stdout.write(`node: downloading ${url}\n`)
      await download(url, archive)
      downloaded = true
      break
    } catch (error) {
      failures.push(`${url} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  if (!downloaded) throw new Error(`node: every mirror failed:\n  ${failures.join('\n  ')}`)

  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const tar = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', staging], { stdio: 'inherit' })
  if (tar.error !== undefined) throw tar.error
  if (tar.status !== 0) throw new Error(`node: tar exited with status ${String(tar.status)}`)

  await chmod(join(staging, 'bin', 'node'), 0o755)
  const unpacked = reportedVersion(join(staging, 'bin', 'node'))
  if (unpacked !== NODE_VERSION) {
    throw new Error(`node: unpacked archive reports ${String(unpacked)}, expected ${NODE_VERSION}`)
  }
  await rm(target, { recursive: true, force: true })
  await rename(staging, target)
  await rm(archive, { force: true })
}

const target = process.argv[2]
if (target === undefined) throw new Error('usage: download-node.mjs <target directory>')
if (reportedVersion(join(target, 'bin', 'node')) === NODE_VERSION) {
  process.stdout.write(`node: reusing ${join(target, 'bin', 'node')} (v${NODE_VERSION})\n`)
} else {
  await install(target)
  process.stdout.write(`node: installed v${NODE_VERSION} at ${join(target, 'bin', 'node')}\n`)
}
