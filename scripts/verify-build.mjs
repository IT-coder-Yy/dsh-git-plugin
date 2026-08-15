import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { relative, resolve } from 'node:path'

const outputDirectory = resolve('lib')

async function snapshot(directory) {
  const result = new Map()
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const digest = createHash('sha256').update(await readFile(path)).digest('hex')
        result.set(relative(directory, path), digest)
      }
    }
  }
  await visit(directory)
  return result
}

function runBuild() {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, ['run', 'build'], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`Build failed (${signal || code || 'unknown'})`))
    })
  })
}

function differences(before, after) {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  return paths.filter((path) => before.get(path) !== after.get(path))
}

const before = await snapshot(outputDirectory)
if (before.size === 0) throw new Error('No committed build artifacts were found in lib/')
await runBuild()
const changed = differences(before, await snapshot(outputDirectory))
if (changed.length > 0) {
  console.error('Generated artifacts were out of date:')
  for (const path of changed) console.error(`  lib/${path}`)
  process.exitCode = 1
} else {
  console.log(`Verified ${before.size} reproducible build artifacts.`)
}
