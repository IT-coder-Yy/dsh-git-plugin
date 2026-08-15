'use strict'
/**
 * Test helpers: a minimal child_process shell adapter for ctx.get('shell') and
 * temporary Git repository setup and cleanup.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Minimal shell adapter with the Harness resolve-to-run shape.
 * @param {string} cwd Default working directory.
 */
function makeShell(cwd) {
  return {
    resolve: (req) => ({
      ...req,
      workdir: req.workdir || cwd,
      timeoutMs: req.timeoutMs || 30000,
      stdoutMaxBytes: req.stdoutMaxBytes || 2 * 1024 * 1024,
      sandboxPolicy: undefined,
    }),
    run: async (spec) => {
      try {
        const stdout = execFileSync('bash', ['-c', spec.command], {
          cwd: spec.workdir || cwd,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: stdout }, stderr: { text: '' } }
      } catch (err) {
        return {
          exitCode: err.status == null ? -1 : err.status,
          signal: err.signal || null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: String(err.stdout || '') },
          stderr: { text: String(err.stderr || '') },
        }
      }
    },
  }
}

/** Create a temporary Git repository with one initial commit and return its path. */
function createRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', 'a.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

module.exports = { makeShell, createRepo, cleanup }
