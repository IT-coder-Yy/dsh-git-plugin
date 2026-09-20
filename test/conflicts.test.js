'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { helpers } = require('../lib')
const { makeShell, createRepo, cleanup } = require('./helpers')

function fixture(file = 'a.txt', content = { base: 'base\n', ours: 'ours\n', theirs: 'theirs\n' }) {
  const dir = createRepo()
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  fs.writeFileSync(path.join(dir, file), content.base)
  git('add', '--', file); git('commit', '-qm', 'base')
  git('switch', '-qc', 'incoming')
  fs.writeFileSync(path.join(dir, file), content.theirs)
  git('commit', '-qam', 'incoming')
  git('switch', '-q', 'main')
  fs.writeFileSync(path.join(dir, file), content.ours)
  git('commit', '-qam', 'ours')
  const repository = new helpers.GitRepositoryService(makeShell(dir))
  let id = 0
  const call = (action, payload = {}, extra = {}) => repository.conflictAction(action, dir, payload,
    action.startsWith('get-') ? undefined : { sessionId: 'conflicts', workdir: dir, operationId: 'op-' + (++id), ...extra })
  return { dir, git, call, repository }
}

for (const kind of ['merge', 'rebase', 'cherry-pick']) test(kind + '：读取四方、保存、标记、继续的真实流程', async () => {
  const f = fixture('中文 name [1].txt')
  try {
    const start = await f.call('start-operation', { kind, target: 'incoming', confirmRisk: true })
    assert.equal(start.ok, true, JSON.stringify(start)); assert.equal(start.data.operation, kind)
    assert.equal(start.data.files.length, 1)
    const file = start.data.files[0].path
    const detail = await f.call('get-conflict', { path: file })
    assert.equal(detail.ok, true, JSON.stringify(detail))
    assert.equal(detail.data.base.text, 'base\n')
    assert.equal(detail.data.ours.text, kind === 'rebase' ? 'theirs\n' : 'ours\n')
    assert.equal(detail.data.theirs.text, kind === 'rebase' ? 'ours\n' : 'theirs\n')
    const incomingRef = kind === 'merge' ? 'MERGE_HEAD' : kind === 'rebase' ? 'REBASE_HEAD' : 'CHERRY_PICK_HEAD'
    assert.equal(detail.data.ours.source, 'HEAD · ' + f.git('rev-parse', 'HEAD').slice(0, 12))
    assert.equal(detail.data.theirs.source, incomingRef + ' · ' + f.git('rev-parse', incomingRef).slice(0, 12))
    const blocked = await f.call('resolve-conflict', { path: file, token: detail.data.token, choice: 'result' })
    assert.equal(blocked.ok, false); assert.match(blocked.message, /冲突标记/)
    const continuedTooSoon = await f.call('finish-operation', { kind, token: start.data.operationToken, mode: 'continue', confirmRisk: true })
    assert.equal(continuedTooSoon.ok, false)
    const saved = await f.call('save-conflict', { path: file, token: detail.data.token, content: 'resolved\n' })
    assert.equal(saved.ok, true, JSON.stringify(saved)); assert.notEqual(saved.data.token, detail.data.token)
    assert.ok(f.git('ls-files', '-u'))
    const resolved = await f.call('resolve-conflict', { path: file, token: saved.data.token, choice: 'result' })
    assert.equal(resolved.ok, true, JSON.stringify(resolved)); assert.equal(resolved.data.files.length, 0)
    assert.equal(f.git('ls-files', '-u'), '')
    const completed = await f.call('finish-operation', { kind, token: resolved.data.operationToken, mode: 'continue', confirmRisk: true })
    assert.equal(completed.ok, true, JSON.stringify(completed)); assert.equal(completed.data.operation, null)
    assert.equal(fs.readFileSync(path.join(f.dir, file), 'utf8'), 'resolved\n')
  } finally { cleanup(f.dir) }
})

test('冲突保存拒绝旧快照、超限和路径越界，重复请求不重写文件', async () => {
  const f = fixture()
  try {
    await f.call('start-operation', { kind: 'merge', target: 'incoming', confirmRisk: true })
    const detail = (await f.call('get-conflict', { path: 'a.txt' })).data
    fs.writeFileSync(path.join(f.dir, 'a.txt'), 'external change\n')
    const stale = await f.call('save-conflict', { path: 'a.txt', token: detail.token, content: 'lost' })
    assert.equal(stale.ok, false); assert.match(stale.message, /外部修改/)
    assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'external change\n')
    assert.equal((await f.call('get-conflict', { path: '../a.txt' })).ok, false)
    assert.equal((await f.call('save-conflict', { path: 'a.txt', token: detail.token, content: 'x'.repeat(49153) })).ok, false)
    const fresh = (await f.call('get-conflict', { path: 'a.txt' })).data
    const payload = { path: 'a.txt', token: fresh.token, content: 'saved\r\n\n' }
    const first = await f.call('save-conflict', payload, { operationId: 'repeat' })
    assert.equal(first.ok, true)
    fs.writeFileSync(path.join(f.dir, 'a.txt'), 'do not overwrite')
    const second = await f.call('save-conflict', payload, { operationId: 'repeat' })
    assert.deepEqual(second, first)
    assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'do not overwrite')
  } finally { cleanup(f.dir) }
})

test('二进制冲突选择整份版本、删除修改冲突选择删除', async () => {
  const f = fixture('binary.dat', { base: Buffer.from([0, 1]), ours: Buffer.from([0, 2]), theirs: Buffer.from([0, 3]) })
  try {
    await f.call('start-operation', { kind: 'merge', target: 'incoming', confirmRisk: true })
    const detail = (await f.call('get-conflict', { path: 'binary.dat' })).data
    assert.equal(detail.editable, false)
    const resolved = await f.call('resolve-conflict', { path: 'binary.dat', token: detail.token, choice: 'theirs' })
    assert.equal(resolved.ok, true, JSON.stringify(resolved))
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'binary.dat')), Buffer.from([0, 3]))
  } finally { cleanup(f.dir) }
  const d = fixture()
  try {
    d.git('rm', 'a.txt'); d.git('commit', '-qm', 'delete')
    await d.call('start-operation', { kind: 'merge', target: 'incoming', confirmRisk: true })
    const detail = (await d.call('get-conflict', { path: 'a.txt' })).data
    assert.equal(detail.ours.exists, false)
    assert.equal((await d.call('resolve-conflict', { path: 'a.txt', token: detail.token, choice: 'ours' })).ok, false)
    const resolved = await d.call('resolve-conflict', { path: 'a.txt', token: detail.token, choice: 'delete' })
    assert.equal(resolved.ok, true, JSON.stringify(resolved)); assert.equal(fs.existsSync(path.join(d.dir, 'a.txt')), false)
  } finally { cleanup(d.dir) }
})

for (const kind of ['merge', 'rebase', 'cherry-pick']) test(kind + '：中止恢复原始工作区', async () => {
  const f = fixture()
  try {
    const initial = f.git('rev-parse', 'HEAD')
    const start = await f.call('start-operation', { kind, target: 'incoming', confirmRisk: true })
    const reject = await f.call('finish-operation', { kind, token: start.data.operationToken, mode: 'abort', confirmRisk: false })
    assert.equal(reject.ok, false)
    const abort = await f.call('finish-operation', { kind, token: start.data.operationToken, mode: 'abort', confirmRisk: true })
    assert.equal(abort.ok, true, JSON.stringify(abort)); assert.equal(abort.data.operation, null)
    assert.equal(f.git('rev-parse', 'HEAD'), initial)
    assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'ours\n')
  } finally { cleanup(f.dir) }
})

test('符号链接不能把编辑写入仓库外，Git 参数不接受选项注入', async () => {
  const f = fixture()
  try {
    assert.equal((await f.call('start-operation', { kind: 'merge', target: '--abort', confirmRisk: true })).ok, false)
    await f.call('start-operation', { kind: 'merge', target: 'incoming', confirmRisk: true })
    const detail = (await f.call('get-conflict', { path: 'a.txt' })).data
    const outside = path.join(f.dir, 'outside.txt')
    fs.writeFileSync(outside, 'untouched')
    fs.unlinkSync(path.join(f.dir, 'a.txt')); fs.symlinkSync(outside, path.join(f.dir, 'a.txt'))
    const save = await f.call('save-conflict', { path: 'a.txt', token: detail.token, content: 'bad' })
    assert.equal(save.ok, false); assert.match(save.message, /符号链接/)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched')
  } finally { cleanup(f.dir) }
})

test('Rebase 连续两轮冲突不会被误报完成', async () => {
  const f = fixture()
  try {
    fs.writeFileSync(path.join(f.dir, 'a.txt'), 'second commit\n')
    f.git('commit', '-qam', 'second')
    let current = await f.call('start-operation', { kind: 'rebase', target: 'incoming', confirmRisk: true })
    const firstOperationToken = current.data.operationToken
    for (const content of ['first resolution\n', 'second resolution\n']) {
      assert.equal(current.data.operation, 'rebase')
      assert.equal(current.data.files.length, 1)
      const detail = (await f.call('get-conflict', { path: 'a.txt' })).data
      const saved = await f.call('save-conflict', { path: 'a.txt', token: detail.token, content })
      const resolved = await f.call('resolve-conflict', { path: 'a.txt', token: saved.data.token, choice: 'result' })
      current = await f.call('finish-operation', { kind: 'rebase', token: resolved.data.operationToken, mode: 'continue', confirmRisk: true })
      assert.equal(current.ok, true, JSON.stringify(current))
      if (content.startsWith('first')) {
        assert.notEqual(current.data.operationToken, firstOperationToken)
        assert.equal(current.data.operation, 'rebase')
      }
    }
    assert.equal(current.data.operation, null)
    assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'second resolution\n')
  } finally { cleanup(f.dir) }
})

test('仓库子目录和 linked worktree 正确识别 Git 操作状态', async () => {
  const f = fixture()
  const worktree = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gg-conflict-worktree-'))
  try {
    f.git('worktree', 'add', '-b', 'linked', worktree, 'main')
    fs.mkdirSync(path.join(worktree, 'sub'))
    const repo = new helpers.GitRepositoryService(makeShell(worktree))
    const request = { sessionId: 'linked', workdir: path.join(worktree, 'sub'), operationId: 'merge-linked' }
    const start = await repo.conflictAction('start-operation', request.workdir, { kind: 'merge', target: 'incoming', confirmRisk: true }, request)
    assert.equal(start.ok, true, JSON.stringify(start)); assert.equal(start.data.operation, 'merge')
    const detail = await repo.conflictAction('get-conflict', request.workdir, { path: 'a.txt' })
    assert.equal(detail.ok, true, JSON.stringify(detail)); assert.equal(detail.data.base.text, 'base\n')
    assert.equal((await f.call('get-conflicts')).data.operation, null)
  } finally { cleanup(worktree); cleanup(f.dir) }
})

test('空提交可跳过；自定义冲突标记阻止未解决内容暂存', async () => {
  const f = fixture()
  try {
    fs.writeFileSync(path.join(f.dir, '.gitattributes'), 'a.txt conflict-marker-size=10\n')
    f.git('add', '.gitattributes'); f.git('commit', '-qm', 'attributes')
    const start = await f.call('start-operation', { kind: 'cherry-pick', target: 'incoming', confirmRisk: true })
    const detail = (await f.call('get-conflict', { path: 'a.txt' })).data
    assert.equal(detail.markerSize, 10)
    assert.equal((await f.call('resolve-conflict', { path: 'a.txt', token: detail.token, choice: 'result' })).ok, false)
    const resolved = await f.call('resolve-conflict', { path: 'a.txt', token: detail.token, choice: 'ours' })
    const empty = await f.call('finish-operation', { kind: 'cherry-pick', token: resolved.data.operationToken, mode: 'continue', confirmRisk: true })
    assert.equal(empty.ok, false)
    const skip = await f.call('finish-operation', { kind: 'cherry-pick', token: start.data.operationToken, mode: 'skip', confirmRisk: true })
    assert.equal(skip.ok, true, JSON.stringify(skip)); assert.equal(skip.data.operation, null)
  } finally { cleanup(f.dir) }
})

test('冲突接口复用会话定位和沙箱，忽略客户端工作目录', async () => {
  const f = fixture()
  try {
    const { EventEmitter } = require('node:events')
    let route
    const policies = []
    const baseShell = makeShell(f.dir)
    const policy = { kind: 'workspace' }
    require('../lib').apply({
      get(key) {
        if (key === 'shell') return { resolve(req) { policies.push(req.sandboxPolicy); return baseShell.resolve(req) }, run: baseShell.run }
        if (key === 'tools') return { register() {} }
        if (key === 'sandboxPolicy') return { resolve: () => policy }
        if (key === 'agents') return { get: id => id === 'conflict-http' ? { session: { cwd: f.dir, sandboxPolicy: policy } } : undefined }
        return null
      },
      inject: (_deps, callback) => callback({ get: key => key === 'connection' ? { requestRejection: () => undefined } : { register(definition) { route = definition } } }),
    })
    const call = body => new Promise(resolve => {
      const req = new EventEmitter(); req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
      const res = { writeHead() {}, end(text) { resolve(JSON.parse(text)) } }
      route.handler(req, res)
      queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
    })
    const request = { sessionId: 'conflict-http', workdir: '/does-not-exist' }
    const preview = await call({ ...request, action: 'get-merge-preview', target: 'refs/heads/incoming' })
    assert.equal(preview.ok, true, JSON.stringify(preview))
    const start = await call({ ...request, action: 'merge-branch', operationId: 'http-start', target: preview.data.target, token: preview.data.token, mode: 'normal' })
    assert.equal(start.ok, true, JSON.stringify(start))
    const detail = await call({ ...request, action: 'get-conflict', path: 'a.txt' })
    assert.equal(detail.ok, true, JSON.stringify(detail)); assert.equal(detail.data.base.text, 'base\n')
    const saved = await call({ ...request, action: 'save-conflict', operationId: 'http-save', path: 'a.txt', token: detail.data.token, content: 'http saved\n' })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    const resolved = await call({ ...request, action: 'resolve-conflict', operationId: 'http-resolve', path: 'a.txt', token: saved.data.token, choice: 'result' })
    assert.equal(resolved.ok, true, JSON.stringify(resolved)); assert.equal(resolved.data.files.length, 0)
    assert.equal((await call({ action: 'get-conflicts', sessionId: 'not-a-session' })).ok, false)
    assert.ok(policies.length > 0)
    assert.ok(policies.every(value => value === policy), '所有 Git 与文件读写均必须沿用会话沙箱')
  } finally { cleanup(f.dir) }
})

test('同仓库不同会话保存同一快照时仅一个成功', async () => {
  const f = fixture()
  try {
    await f.call('start-operation', { kind: 'merge', target: 'incoming', confirmRisk: true })
    const detail = (await f.call('get-conflict', { path: 'a.txt' })).data
    const results = await Promise.all(['one', 'two'].map(sessionId => f.call('save-conflict', { path: 'a.txt', token: detail.token, content: sessionId }, { sessionId })))
    assert.equal(results.filter(result => result.ok).length, 1)
    assert.equal(results.filter(result => !result.ok && result.code === 'STATE_CONFLICT').length, 1)
  } finally { cleanup(f.dir) }
})

test('合法 Markdown 分隔线不被误判为冲突标记', async () => {
  const f = fixture()
  try {
    await f.call('start-operation', { kind: 'merge', target: 'incoming', confirmRisk: true })
    const detail = (await f.call('get-conflict', { path: 'a.txt' })).data
    const content = '文档标题\n========\n<<<<<<<identifier\n正常正文\n'
    const saved = await f.call('save-conflict', { path: 'a.txt', token: detail.token, content })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    const resolved = await f.call('resolve-conflict', { path: 'a.txt', token: saved.data.token, choice: 'result' })
    assert.equal(resolved.ok, true, JSON.stringify(resolved))
    assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), content)
  } finally { cleanup(f.dir) }
})

test('无提交仓库可以读取空冲突列表', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gg-unborn-'))
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    const repository = new helpers.GitRepositoryService(makeShell(dir))
    const result = await repository.conflictAction('get-conflicts', dir, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.data.operation, null)
    assert.deepEqual(result.data.files, [])
    assert.match(result.data.operationToken, /^[a-f0-9]{64}$/)
  } finally { cleanup(dir) }
})

test('变更列表保留中文、引号、箭头和重命名路径', async () => {
  const f = fixture('中文 name [1].txt')
  try {
    await f.call('start-operation', { kind: 'merge', target: 'incoming', confirmRisk: true })
    let summary = await f.repository.getSummary(f.dir)
    assert.equal(summary.ok, true)
    assert.equal(summary.data.files[0].path, '中文 name [1].txt')
    assert.equal(summary.data.files[0].indexStatus + summary.data.files[0].workTreeStatus, 'UU')
    f.git('merge', '--abort')
    const renamed = '新文件 "quoted" -> target.txt'
    f.git('mv', '中文 name [1].txt', renamed)
    fs.writeFileSync(path.join(f.dir, 'new -> literal.txt'), 'untracked')
    summary = await f.repository.getSummary(f.dir)
    assert.equal(summary.ok, true)
    const rename = summary.data.files.find(file => file.indexStatus === 'R')
    assert.equal(rename.path, renamed)
    assert.equal(rename.originalPath, '中文 name [1].txt')
    assert.ok(summary.data.files.some(file => file.path === 'new -> literal.txt' && file.originalPath === undefined))
  } finally { cleanup(f.dir) }
})
