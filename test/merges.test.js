'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { helpers } = require('../lib')
const { makeShell, createRepo, cleanup } = require('./helpers')

function fixture({ diverged = false, conflict = false } = {}) {
  const dir = createRepo()
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (file, text) => fs.writeFileSync(path.join(dir, file), text)
  write('共同.txt', 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
  git('switch', '-qc', 'incoming')
  write(conflict ? '共同.txt' : '源文件 [1].txt', 'incoming\n'); git('add', '.'); git('commit', '-qm', 'incoming commit')
  git('switch', '-q', 'main')
  if (diverged || conflict) { write(conflict ? '共同.txt' : 'local.txt', 'ours\n'); git('add', '.'); git('commit', '-qm', 'local commit') }
  const repository = new helpers.GitRepositoryService(makeShell(dir))
  let id = 0
  const call = (action, payload = {}, extra = {}) => repository.conflictAction(action, dir, payload,
    action.startsWith('get-') ? undefined : { sessionId: 'merges', workdir: dir, operationId: 'merge-' + ++id, ...extra })
  const preview = (target = 'refs/heads/incoming') => call('get-merge-preview', { target })
  const merge = async (mode, extra = {}) => {
    const result = await preview()
    assert.equal(result.ok, true, JSON.stringify(result))
    return call('merge-branch', { target: result.data.target, token: result.data.token, mode }, extra)
  }
  const finish = async mode => {
    const state = (await call('get-conflicts')).data
    return call('finish-operation', { kind: 'merge', token: state.operationToken, mode, confirmRisk: true })
  }
  return { dir, git, write, call, preview, merge, finish }
}

for (const mode of ['normal', 'ff-only']) test(mode + '：预览与快进合并', async () => {
  const f = fixture()
  try {
    const before = f.git('rev-parse', 'HEAD')
    const preview = await f.preview()
    assert.equal(preview.ok, true, JSON.stringify(preview))
    assert.equal(preview.data.canFastForward, true)
    assert.equal(preview.data.commits.length, 1)
    assert.equal(preview.data.commits[0].subject, 'incoming commit')
    assert.deepEqual(preview.data.files, ['源文件 [1].txt'])
    assert.match(preview.data.diff, /\+incoming/)
    assert.equal(f.git('rev-parse', 'HEAD'), before)
    f.git('config', 'merge.ff', 'false')
    const result = await f.merge(mode)
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.operation, null)
    assert.equal(f.git('rev-parse', 'HEAD'), f.git('rev-parse', 'incoming'))
    assert.equal((await f.preview()).data.alreadyMerged, true)
  } finally { cleanup(f.dir) }
})

test('分叉：仅快进拒绝，普通合并创建双父提交并可幂等重试', async () => {
  const f = fixture({ diverged: true })
  try {
    const before = f.git('rev-parse', 'HEAD')
    const preview = await f.preview()
    assert.equal(preview.data.canFastForward, false)
    assert.deepEqual(preview.data.files, ['源文件 [1].txt'])
    assert.equal((await f.merge('ff-only')).ok, false)
    assert.equal(f.git('rev-parse', 'HEAD'), before)
    assert.equal(f.git('status', '--porcelain'), '')
    f.git('config', 'merge.ff', 'only')
    const first = await f.merge('normal', { operationId: 'same-request' })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(f.git('show', '-s', '--format=%P').split(' ').length, 2)
    assert.deepEqual(await f.merge('normal', { operationId: 'same-request' }), first)
  } finally { cleanup(f.dir) }
})

for (const mode of ['normal', 'squash']) for (const finish of ['continue', 'abort']) test(mode + ' 冲突：' + finish, async () => {
  const f = fixture({ conflict: true })
  try {
    const before = f.git('rev-parse', 'HEAD')
    const start = await f.merge(mode)
    assert.equal(start.ok, true, JSON.stringify(start))
    assert.equal(start.data.operation, 'merge'); assert.equal(start.data.files.length, 1)
    assert.equal(start.data.mergeMode, mode === 'squash' ? 'squash' : undefined)
    assert.equal((await f.finish('continue')).ok, false)
    if (finish === 'continue') {
      const detail = (await f.call('get-conflict', { path: '共同.txt' })).data
      assert.equal(detail.theirs.text, 'incoming\n')
      const resolved = await f.call('resolve-conflict', { path: '共同.txt', token: detail.token, choice: 'theirs' })
      assert.equal(resolved.ok, true, JSON.stringify(resolved))
    }
    const result = await f.finish(finish)
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.operation, null)
    assert.equal(f.git('status', '--porcelain'), '')
    if (finish === 'abort') {
      assert.equal(f.git('rev-parse', 'HEAD'), before)
      assert.equal(fs.readFileSync(path.join(f.dir, '共同.txt'), 'utf8'), 'ours\n')
    } else {
      assert.equal(f.git('show', '-s', '--format=%P').split(' ').length, mode === 'squash' ? 1 : 2)
    }
  } finally { cleanup(f.dir) }
})

for (const finish of ['continue', 'abort']) test('无冲突压缩合并暂存结果后可' + finish, async () => {
  const f = fixture()
  try {
    const before = f.git('rev-parse', 'HEAD')
    const result = await f.merge('squash')
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.mergeMode, 'squash')
    assert.equal(f.git('rev-parse', 'HEAD'), before)
    assert.ok(f.git('diff', '--cached', '--name-only'))
    const completed = await f.finish(finish)
    assert.equal(completed.ok, true, JSON.stringify(completed)); assert.equal(completed.data.operation, null)
    assert.equal(f.git('status', '--porcelain'), '')
    if (finish === 'continue') assert.equal(f.git('show', '-s', '--format=%P'), before)
    else assert.equal(fs.existsSync(path.join(f.dir, '源文件 [1].txt')), false)
  } finally { cleanup(f.dir) }
})

test('拒绝旧预览、脏工作区、当前分支、标签及参数注入；支持远程引用', async () => {
  const f = fixture()
  try {
    for (const target of ['refs/heads/main', '--abort', 'HEAD', 'refs/tags/incoming']) assert.equal((await f.preview(target)).ok, false)
    f.git('update-ref', 'refs/remotes/origin/incoming', 'incoming')
    assert.equal((await f.preview('refs/remotes/origin/incoming')).ok, true)
    const old = (await f.preview()).data
    f.git('update-ref', 'refs/heads/incoming', 'HEAD')
    const stale = await f.call('merge-branch', { target: old.target, token: old.token, mode: 'normal' })
    assert.equal(stale.ok, false); assert.match(stale.message, /重新预览/)
    f.git('update-ref', 'refs/heads/incoming', 'refs/remotes/origin/incoming')
    f.write('untracked.txt', 'keep')
    const dirty = await f.merge('normal')
    assert.equal(dirty.ok, false); assert.match(dirty.message, /提交或贮藏/)
    assert.equal(fs.readFileSync(path.join(f.dir, 'untracked.txt'), 'utf8'), 'keep')
  } finally { cleanup(f.dir) }
})

test('外部提交后压缩状态失效，旧 token 不能中止已完成提交', async () => {
  const f = fixture()
  try {
    const result = await f.merge('squash')
    f.git('commit', '-qm', 'external squash')
    const head = f.git('rev-parse', 'HEAD')
    assert.equal((await f.call('get-conflicts')).data.operation, null)
    assert.equal((await f.call('finish-operation', { kind: 'merge', token: result.data.operationToken, mode: 'abort', confirmRisk: true })).ok, false)
    assert.equal(f.git('rev-parse', 'HEAD'), head)
  } finally { cleanup(f.dir) }
})

test('压缩合并状态隔离到 linked worktree，子目录可继续或中止', async () => {
  const f = fixture()
  const worktree = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gg-merge-worktree-'))
  try {
    f.git('worktree', 'add', '-b', 'linked', worktree, 'main')
    fs.mkdirSync(path.join(worktree, 'sub'))
    const repository = new helpers.GitRepositoryService(makeShell(worktree))
    const workdir = path.join(worktree, 'sub')
    const preview = await repository.conflictAction('get-merge-preview', workdir, { target: 'refs/heads/incoming' })
    const start = await repository.conflictAction('merge-branch', workdir, { target: preview.data.target, token: preview.data.token, mode: 'squash' }, { sessionId: 'linked', workdir, operationId: 'start' })
    assert.equal(start.ok, true, JSON.stringify(start)); assert.equal(start.data.mergeMode, 'squash')
    assert.equal((await f.call('get-conflicts')).data.operation, null)
    const abort = await repository.conflictAction('finish-operation', workdir, { kind: 'merge', token: start.data.operationToken, mode: 'abort', confirmRisk: true }, { sessionId: 'linked', workdir, operationId: 'abort' })
    assert.equal(abort.ok, true, JSON.stringify(abort)); assert.equal(abort.data.operation, null)
    assert.equal(fs.existsSync(path.join(worktree, '源文件 [1].txt')), false)
  } finally { cleanup(worktree); cleanup(f.dir) }
})

test('大 Diff 截断有提示，二进制和重命名可预览，外部 reset 清除压缩状态', async () => {
  const f = fixture()
  try {
    f.git('switch', 'incoming')
    f.git('mv', '共同.txt', '改名.txt')
    f.write('binary.dat', Buffer.from([0, 1, 2]))
    f.write('large.txt', 'line\n'.repeat(40000))
    f.git('add', '.'); f.git('commit', '-qm', 'large and binary')
    f.git('switch', 'main')
    const preview = await f.preview()
    assert.equal(preview.ok, true, JSON.stringify(preview))
    assert.equal(preview.data.diffTruncated, true)
    assert.equal(preview.data.diff.length, 180000)
    assert.ok(preview.data.files.includes('改名.txt'))
    assert.match(preview.data.diff, /Binary files/)
    assert.equal((await f.merge('squash')).ok, true)
    f.git('reset', '--hard', 'HEAD')
    assert.equal((await f.call('get-conflicts')).data.operation, null)
    f.git('checkout', '--detach', 'HEAD')
    const detached = await f.preview()
    assert.equal(detached.ok, false); assert.match(detached.message, /分离 HEAD/)
    assert.equal((await f.call('get-conflicts')).ok, true)
  } finally { cleanup(f.dir) }
})

test('未完成合并阻止再次开始；无关历史预览给出明确错误', async () => {
  const f = fixture({ conflict: true })
  try {
    const start = await f.merge('normal')
    const blocked = await f.merge('squash')
    assert.equal(blocked.ok, false); assert.match(blocked.message, /当前 Git 操作/)
    assert.equal((await f.call('get-conflicts')).data.operationToken, start.data.operationToken)
    await f.finish('abort')
    f.git('switch', '--orphan', 'unrelated')
    f.write('orphan.txt', 'unrelated'); f.git('add', '.'); f.git('commit', '-qm', 'unrelated')
    f.git('switch', 'main')
    const result = await f.preview('refs/heads/unrelated')
    assert.equal(result.ok, false); assert.match(result.message, /没有共同祖先/)
  } finally { cleanup(f.dir) }
})


test('同名标签及本地/远程分支不会改变合并源的实际引用', async () => {
  const f = fixture()
  try {
    f.git('tag', 'incoming', 'refs/heads/incoming')
    f.git('branch', 'origin/incoming', 'refs/heads/incoming')
    f.git('update-ref', 'refs/remotes/origin/incoming', 'refs/heads/incoming')
    const repository = new helpers.GitRepositoryService(makeShell(f.dir))
    const references = await repository.getBranches(f.dir)
    assert.equal(references.ok, true, JSON.stringify(references))
    assert.ok(references.data.branches.some(branch => branch.name === 'incoming'))
    assert.ok(references.data.branches.some(branch => branch.name === 'origin/incoming'))
    assert.equal(references.data.remotes[0].name, 'origin/incoming')
    for (const target of ['refs/heads/incoming', 'refs/heads/origin/incoming', 'refs/remotes/origin/incoming']) {
      const preview = await f.preview(target)
      assert.equal(preview.ok, true, JSON.stringify(preview))
      assert.equal(preview.data.sourceHead, f.git('rev-parse', 'refs/heads/incoming'))
    }
  } finally { cleanup(f.dir) }
})
