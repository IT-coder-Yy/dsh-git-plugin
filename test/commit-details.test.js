'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { helpers } = require('../lib')
const { createRepo, cleanup, makeShell } = require('./helpers')

test('提交详情保留特殊文件名，并正确对应重命名和二进制统计', async () => {
  const dir = createRepo()
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const repository = new helpers.GitRepositoryService(makeShell(dir))
  const oldName = '中文 "引号"\t旧文件.txt'
  const newName = '新文件\n带换行.txt'
  try {
    fs.writeFileSync(path.join(dir, oldName), 'one\ntwo\nthree\n')
    git('add', '.'); git('commit', '--amend', '--no-edit', '-q')
    const root = await repository.getCommitDetail(dir, git('rev-parse', 'HEAD'))
    assert.equal(root.ok, true)
    assert.deepEqual(root.data.files.find(file => file.path === oldName), {
      status: 'A', path: oldName, additions: 3, deletions: 0,
    })
    git('mv', oldName, newName)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nextra\n')
    fs.writeFileSync(path.join(dir, '二进制.dat'), Buffer.from([0, 1, 2]))
    git('add', '.'); git('commit', '-qm', 'test: rename special path')
    const result = await repository.getCommitDetail(dir, git('rev-parse', 'HEAD'))
    assert.equal(result.ok, true)
    assert.deepEqual(result.data.files.find(file => file.path === newName), {
      status: 'R100', path: newName, previousPath: oldName, additions: 0, deletions: 0,
    })
    assert.deepEqual(result.data.files.find(file => file.path === 'a.txt'), {
      status: 'M', path: 'a.txt', additions: 1, deletions: 0,
    })
    assert.deepEqual(result.data.files.find(file => file.path === '二进制.dat'), {
      status: 'A', path: '二进制.dat', additions: null, deletions: null,
    })
    assert.deepEqual(result.data.totals, { files: 3, additions: 1, deletions: 0, binary: 1 })
  } finally { cleanup(dir) }
})
