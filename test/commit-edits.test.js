'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const plugin = require('../lib')
const { makeShell, createRepo, cleanup } = require('./helpers')

function fixture() {
  const dir = createRepo()
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  const write = (file, content) => fs.writeFileSync(path.join(dir, file), content)
  const read = file => fs.readFileSync(path.join(dir, file), 'utf8')
  const shell = makeShell(dir)
  const repository = new plugin.helpers.GitRepositoryService(shell)
  let id = 0
  const call = (action, payload = {}, operationId = 'edit-' + ++id) => repository.conflictAction(action, dir, payload,
    action.startsWith('get-') ? undefined : { sessionId: 'edits', workdir: dir, operationId })
  const snapshot = async () => {
    const result = await call('get-commit-edit-state')
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.data
  }
  const edit = async (action, payload = {}, operationId) => call(action, { token: (await snapshot()).token, confirmRisk: true, ...payload }, operationId)
  const commit = (content, message = 'change') => { write('a.txt', content); git('add', 'a.txt'); git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  const finish = async mode => {
    const result = await call('get-conflicts')
    return call('finish-operation', { kind: 'revert', mode, token: result.data.operationToken, confirmRisk: true })
  }
  return { dir, git, write, read, shell, call, snapshot, edit, commit, finish }
}
const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data }

test('修改说明：支持多行与引号，保留原树、父提交、暂存和未暂存内容', async () => {
  const f = fixture()
  try {
    f.commit('committed\n')
    const tree = f.git('rev-parse', 'HEAD^{tree}')
    const parent = f.git('rev-parse', 'HEAD^')
    f.write('a.txt', 'staged\n'); f.git('add', 'a.txt'); f.write('a.txt', 'unstaged\n')
    f.write('未跟踪.txt', 'untracked\n')
    const index = f.git('write-tree')
    const message = "fix: '说明' $(touch injected)\n\n正文保留\n# literal comment"
    success(await f.edit('amend-message', { message }))
    assert.equal(f.git('show', '-s', '--format=%B'), message)
    assert.equal(f.git('rev-parse', 'HEAD^{tree}'), tree)
    assert.equal(f.git('rev-parse', 'HEAD^'), parent)
    assert.equal(f.git('write-tree'), index)
    assert.equal(f.read('a.txt'), 'unstaged\n')
    assert.equal(f.read('未跟踪.txt'), 'untracked\n')
    assert.equal(fs.existsSync(path.join(f.dir, 'injected')), false)
  } finally { cleanup(f.dir) }
})

test('根提交允许改说明与补充；补充只使用暂存区且保留多行说明', async () => {
  const f = fixture()
  try {
    const message = '标题\n\n正文\n# 保留注释行\n尾部空格  '
    success(await f.edit('amend-message', { message }))
    const originalMessage = execFileSync('git', ['show', '-s', '--format=%B'], { cwd: f.dir, encoding: 'utf8' })
    f.git('config', 'commit.cleanup', 'strip')
    const root = f.git('rev-parse', 'HEAD')
    assert.equal((await f.edit('amend-commit')).ok, false)
    assert.equal((await f.edit('undo-commit')).ok, false)
    f.write('a.txt', 'staged\n'); f.git('add', 'a.txt'); f.write('a.txt', 'unstaged\n')
    success(await f.edit('amend-commit'))
    assert.notEqual(f.git('rev-parse', 'HEAD'), root)
    assert.equal(f.git('show', 'HEAD:a.txt'), 'staged')
    assert.equal(execFileSync('git', ['show', '-s', '--format=%B'], { cwd: f.dir, encoding: 'utf8' }), originalMessage)
    assert.equal(f.git('show', '-s', '--format=%P'), '')
    assert.equal(f.read('a.txt'), 'unstaged\n')
    assert.equal(f.git('diff', '--cached'), '')
  } finally { cleanup(f.dir) }
})

test('soft 撤销：保留完整暂存区、未暂存与未跟踪内容，重试不重复撤销', async () => {
  const f = fixture()
  try {
    const parent = f.git('rev-parse', 'HEAD')
    f.commit('committed\n')
    f.write('a.txt', 'staged\n'); f.git('add', 'a.txt'); f.write('a.txt', 'unstaged\n')
    f.write('new.txt', 'new\n')
    const index = f.git('write-tree')
    const first = await f.edit('undo-commit', {}, 'undo-once')
    success(first)
    assert.equal(f.git('rev-parse', 'HEAD'), parent)
    assert.equal(f.git('write-tree'), index)
    assert.equal(f.read('a.txt'), 'unstaged\n')
    assert.equal(f.read('new.txt'), 'new\n')
    assert.deepEqual(await f.edit('undo-commit', {}, 'undo-once'), first)
    assert.equal(f.git('rev-parse', 'HEAD'), parent)
  } finally { cleanup(f.dir) }
})

test('拒绝未确认、旧 HEAD、旧分支、旧暂存区、非法说明和分离 HEAD', async () => {
  const f = fixture()
  try {
    const before = f.git('rev-parse', 'HEAD')
    for (const message of ['', '   ', 'bad\0text', 'bad\rtext', 'x'.repeat(65537)]) {
      assert.equal((await f.edit('amend-message', { message })).ok, false)
    }
    assert.equal((await f.edit('amend-message', { message: 'new', confirmRisk: false })).code, 'PERMISSION_DENIED')
    assert.equal(f.git('rev-parse', 'HEAD'), before)
    let stale = await f.snapshot()
    f.git('switch', '-qc', 'same-head')
    assert.equal((await f.edit('amend-message', { message: 'new', token: stale.token })).ok, false)
    stale = await f.snapshot()
    f.write('a.txt', 'staged\n'); f.git('add', 'a.txt')
    assert.equal((await f.edit('amend-commit', { token: stale.token })).ok, false)
    stale = await f.snapshot()
    f.git('commit', '-qm', 'external commit')
    assert.equal((await f.edit('undo-commit', { token: stale.token })).ok, false)
    f.git('switch', '--detach', '-q')
    assert.equal((await f.edit('amend-message', { message: 'new' })).ok, false)
  } finally { cleanup(f.dir) }
})

test('普通与根提交 Revert：新增反向提交，保留后续历史；拒绝脏工作区和错误目标', async () => {
  const f = fixture()
  try {
    const root = f.git('rev-parse', 'HEAD')
    f.write('b.txt', 'target\n'); f.git('add', '.'); f.git('commit', '-qm', 'target')
    const target = f.git('rev-parse', 'HEAD')
    f.commit('later\n', 'later')
    const later = f.git('rev-parse', 'HEAD')
    f.write('untracked', 'keep')
    assert.equal((await f.edit('revert-commit', { hash: target })).ok, false)
    fs.unlinkSync(path.join(f.dir, 'untracked'))
    for (const hash of ['HEAD', '--abort', '0'.repeat(40), 'bad; touch injected']) assert.equal((await f.edit('revert-commit', { hash })).ok, false)
    assert.equal((await f.edit('revert-commit', { hash: target, mainline: 1 })).ok, false)
    success(await f.edit('revert-commit', { hash: target }))
    assert.equal(f.git('rev-parse', 'HEAD^'), later)
    assert.equal(fs.existsSync(path.join(f.dir, 'b.txt')), false)
    assert.equal(f.read('a.txt'), 'later\n')
    f.git('switch', '-qc', 'root-revert', root)
    success(await f.edit('revert-commit', { hash: root }))
    assert.equal(f.git('rev-parse', 'HEAD^'), root)
    assert.equal(fs.existsSync(path.join(f.dir, 'a.txt')), false)
    assert.equal((await f.edit('revert-commit', { hash: later })).ok, false)
  } finally { cleanup(f.dir) }
})

for (const mode of ['continue', 'abort', 'skip']) test('Revert 冲突可 ' + mode + '，并阻止交错修改提交', async () => {
  const f = fixture()
  try {
    const target = f.commit('target\n', 'target')
    const before = f.commit('later\n', 'later')
    const started = success(await f.edit('revert-commit', { hash: target }))
    assert.equal(started.operation, 'revert')
    assert.equal(started.files.length, 1)
    assert.equal((await f.edit('undo-commit')).ok, false)
    assert.equal((await f.finish('continue')).ok, false)
    if (mode === 'continue') {
      const detail = success(await f.call('get-conflict', { path: 'a.txt' }))
      assert.equal(detail.operation, 'revert')
      assert.equal(detail.ours.text, 'later\n')
      assert.equal(detail.theirs.text, 'hello\n')
      success(await f.call('resolve-conflict', { path: 'a.txt', token: detail.token, choice: 'theirs' }))
    }
    assert.equal(success(await f.finish(mode)).operation, null)
    assert.equal(f.git('status', '--porcelain'), '')
    if (mode === 'continue') {
      assert.equal(f.git('rev-parse', 'HEAD^'), before)
      assert.equal(f.read('a.txt'), 'hello\n')
    } else {
      assert.equal(f.git('rev-parse', 'HEAD'), before)
      assert.equal(f.read('a.txt'), 'later\n')
    }
  } finally { cleanup(f.dir) }
})

for (const mainline of [1, 2]) test('合并提交 Revert 要求显式主线，支持父提交 ' + mainline, async () => {
  const f = fixture()
  try {
    f.git('switch', '-qc', 'feature')
    f.write('feature.txt', 'feature'); f.git('add', '.'); f.git('commit', '-qm', 'feature')
    f.git('switch', '-q', 'main')
    f.write('main.txt', 'main'); f.git('add', '.'); f.git('commit', '-qm', 'main')
    f.git('merge', '--no-ff', '-qm', 'merge', 'feature')
    const hash = f.git('rev-parse', 'HEAD')
    for (const invalid of [undefined, 0, 3, 1.5, '1', '--abort']) assert.equal((await f.edit('revert-commit', { hash, mainline: invalid })).ok, false)
    success(await f.edit('revert-commit', { hash, mainline }))
    assert.equal(f.git('rev-parse', 'HEAD^{tree}'), f.git('rev-parse', hash + '^' + mainline + '^{tree}'))
    assert.equal(f.git('rev-parse', 'HEAD^'), hash)
  } finally { cleanup(f.dir) }
})

test('同一预览并发撤销只能成功一次', async () => {
  const f = fixture()
  try {
    f.commit('one\n'); const parent = f.git('rev-parse', 'HEAD'); f.commit('two\n')
    const token = (await f.snapshot()).token
    const results = await Promise.all(['a', 'b'].map(id => f.call('undo-commit', { token, confirmRisk: true }, id)))
    assert.equal(results.filter(result => result.ok).length, 1)
    assert.equal(f.git('rev-parse', 'HEAD'), parent)
  } finally { cleanup(f.dir) }
})

test('空 Revert 返回 Git 诊断，不创建提交或遗留操作状态', async () => {
  const f = fixture()
  try {
    f.git('commit', '--allow-empty', '-qm', 'empty')
    const before = f.git('rev-parse', 'HEAD')
    const result = await f.edit('revert-commit', { hash: before })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics)
    assert.equal(success(await f.call('get-conflicts')).operation, null)
    assert.equal(f.git('status', '--porcelain'), '')
    assert.equal(f.git('rev-parse', 'HEAD'), before)
  } finally { cleanup(f.dir) }
})

test('HTTP 分发四项提交操作，继承当前会话沙箱', async () => {
  const f = fixture()
  try {
    let route
    const policy = { mode: 'workspace-write' }
    const seenPolicies = []
    const shell = { ...f.shell, resolve: request => { seenPolicies.push(request.sandboxPolicy); return f.shell.resolve(request) } }
    plugin.apply({
      get: key => key === 'shell' ? shell : key === 'agents' ? { get: () => ({ session: { cwd: f.dir } }) } : key === 'sandboxPolicy' ? { resolve: () => policy } : key === 'tools' ? { register() {} } : null,
      inject: (_deps, callback) => callback({ get: key => key === 'connection' ? { requestRejection: () => undefined } : { register: definition => { route = definition } } }),
    })
    let id = 0
    const http = (action, payload = {}) => new Promise(resolve => {
      const req = new EventEmitter(); req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
      route.handler(req, { writeHead() {}, end: text => resolve(JSON.parse(text)) })
      queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify({ action, sessionId: 'edits-http', operationId: 'http-' + ++id, ...payload }))); req.emit('end') })
    })
    const edit = async (action, payload = {}) => {
      const state = success(await http('get-commit-edit-state'))
      return http(action, { token: state.token, confirmRisk: true, ...payload })
    }
    f.commit('target\n')
    success(await edit('amend-message', { message: 'http message' }))
    f.write('extra.txt', 'extra'); f.git('add', '.')
    success(await edit('amend-commit'))
    const hash = f.git('rev-parse', 'HEAD')
    success(await edit('revert-commit', { hash }))
    success(await edit('undo-commit'))
    assert.equal(f.git('rev-parse', 'HEAD'), hash)
    assert.ok(seenPolicies.length > 0)
    // The host chooses the effective policy; the caller cannot override it.
    assert.ok(seenPolicies.every(value => value === policy))
  } finally { cleanup(f.dir) }
})
