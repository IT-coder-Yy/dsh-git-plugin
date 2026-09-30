'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const script = resolve(__dirname, '../scripts/prepare-release.mjs')

function prepare(t, tag, prerelease, versions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'easygit-release-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const version = tag.replace(/^v/, '')
  const pkg = JSON.stringify({ name: 'dsh-easygit-plugin', version: versions.pkg ?? version })
  const lock = JSON.stringify({ version: versions.lock ?? version, packages: { '': { version: versions.root ?? version } } })
  const event = join(cwd, 'event.json')
  const output = join(cwd, 'output')
  writeFileSync(join(cwd, 'package.json'), pkg)
  writeFileSync(join(cwd, 'package-lock.json'), lock)
  writeFileSync(event, JSON.stringify({ release: { tag_name: tag, prerelease, draft: false } }))
  writeFileSync(output, '')
  const result = spawnSync(process.execPath, [script], {
    cwd, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
  })
  assert.equal(readFileSync(join(cwd, 'package.json'), 'utf8'), pkg)
  assert.equal(readFileSync(join(cwd, 'package-lock.json'), 'utf8'), lock)
  return { ...result, output: readFileSync(output, 'utf8') }
}

test('正式版本进入 latest，预发布版本进入 beta', async t => {
  for (const [tag, prerelease, channel] of [
    ['v0.5.0', false, 'latest'], ['v1.0.0', false, 'latest'],
    ['v1.0.0-beta.1', true, 'beta'], ['v1.0.0-rc.1', true, 'beta'],
  ]) {
    await t.test(tag, t => {
      const result = prepare(t, tag, prerelease)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.output, `version=${tag.slice(1)}\ndist-tag=${channel}\n`)
    })
  }
})

test('拒绝无效版本和可能注入输出的标签', async t => {
  for (const tag of ['1.0.0', 'v1.0', 'v01.0.0', 'v1.0.0-beta.01', 'v1.0.0+build', 'v1.0.0\n', 'v1.0.0\ndist-tag=latest', 'v$(whoami)']) {
    await t.test(JSON.stringify(tag), t => {
      const result = prepare(t, tag, false)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Release 标签必须/)
      assert.equal(result.output, '')
    })
  }
})

test('拒绝与版本后缀不一致的 Release 类型', async t => {
  for (const [tag, prerelease] of [['v1.0.0', true], ['v1.0.0-beta.1', false]]) {
    await t.test(tag, t => {
      const result = prepare(t, tag, prerelease)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /pre-release 选项必须/)
      assert.equal(result.output, '')
    })
  }
})

test('拒绝 package.json 或锁文件中的版本与标签不一致', async t => {
  for (const key of ['pkg', 'lock', 'root']) {
    await t.test(key, t => {
      const result = prepare(t, 'v1.0.0', false, { [key]: '0.4.0' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /版本不一致/)
      assert.equal(result.output, '')
    })
  }
})
