'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { helpers: { GitRepositoryService } } = require('../lib')
const { createRepo, cleanup, makeShell } = require('./helpers')

function fixture(t) {
  const dir = createRepo()
  t.after(() => cleanup(dir))
  let sequence = 0
  const service = new GitRepositoryService(makeShell(dir))
  return {
    dir, service,
    request: () => ({ sessionId: 'stash-test', workdir: dir, operationId: 'stash-' + ++sequence }),
    git: (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    write: (file, text) => fs.writeFileSync(path.join(dir, file), text),
    read: file => fs.readFileSync(path.join(dir, file), 'utf8'),
    async stash() { const result = await service.getStashes(dir); assert.equal(result.ok, true); return result.data[0] },
  }
}
function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.data }

test('按文件贮藏隔离其他暂存内容，保存说明、暂存版本与工作区版本，重复请求只执行一次', async t => {
  const f = fixture(t)
  f.write('b.txt', 'base b\n'); f.git('add', '.'); f.git('commit', '-qm', 'base b')
  f.write('a.txt', 'staged a\n'); f.write('b.txt', 'staged b\n'); f.git('add', '.')
  f.write('a.txt', 'working a\n')
  f.write('b.txt', 'working b\n')
  const indexBefore = f.git('show', ':b.txt')
  const request = f.request()
  const first = await f.service.createStash(request, '说明：仅 a\n第二行', ['a.txt'], false)
  ok(first)
  assert.deepEqual(await f.service.createStash(request, '说明：仅 a\n第二行', ['a.txt'], false), first)
  assert.equal(f.read('a.txt'), 'hello\n')
  assert.equal(f.read('b.txt'), 'working b\n')
  assert.equal(f.git('show', ':b.txt'), indexBefore)
  const stash = await f.stash()
  assert.match(stash.subject, /说明：仅 a/)
  assert.equal(ok(await f.service.getStashes(f.dir)).length, 1)
  assert.deepEqual(ok(await f.service.getStashDetail(f.dir, stash.selector, stash.hash)).files, [{ path: 'a.txt', status: 'M', untracked: false }])
  assert.equal(f.git('show', stash.hash + '^2:a.txt'), 'staged a\n')
  assert.equal(f.git('show', stash.hash + ':a.txt'), 'working a\n')
  const diff = ok(await f.service.getStashDiff(f.dir, stash.selector, stash.hash, 'a.txt', false))
  assert.match(diff.diff, /-hello/); assert.match(diff.diff, /\+working a/)
})

test('包含未跟踪文件支持中文、空格、换行、通配符文件名，按文件 Diff 不扩大匹配范围', async t => {
  const f = fixture(t)
  const unusual = '目录 [x]\n$(no-command).txt'
  f.write(unusual, 'new file\n'); f.write('other.txt', 'keep\n')
  ok(await f.service.createStash(f.request(), 'untracked', [unusual], true))
  assert.equal(fs.existsSync(path.join(f.dir, unusual)), false)
  assert.equal(f.read('other.txt'), 'keep\n')
  const stash = await f.stash()
  assert.deepEqual(ok(await f.service.getStashDetail(f.dir, stash.selector, stash.hash)).files, [{ path: unusual, status: 'A', untracked: true }])
  assert.match(ok(await f.service.getStashDiff(f.dir, stash.selector, stash.hash, unusual, true)).diff, /\+new file/)
  ok(await f.service.mutateStash(f.request(), 'apply-stash', stash.selector, stash.hash))
  assert.equal(f.read(unusual), 'new file\n')
  assert.equal(ok(await f.service.getStashes(f.dir)).length, 1)
})

test('默认排除未跟踪文件，全量创建及成功弹出恢复改动并删除贮藏', async t => {
  const f = fixture(t)
  f.write('a.txt', 'changed\n'); f.write('untracked.txt', 'keep\n')
  ok(await f.service.createStash(f.request(), '', undefined, false))
  assert.equal(f.read('untracked.txt'), 'keep\n')
  const stash = await f.stash()
  assert.equal(ok(await f.service.getStashDetail(f.dir, stash.selector, stash.hash)).files.length, 1)
  ok(await f.service.mutateStash(f.request(), 'pop-stash', stash.selector, stash.hash))
  assert.equal(f.read('a.txt'), 'changed\n')
  assert.equal(ok(await f.service.getStashes(f.dir)).length, 0)
})

test('重命名连同原路径贮藏，删除、二进制和权限变更均可查看', async t => {
  const f = fixture(t)
  f.write('gone.txt', 'gone\n'); f.write('binary.dat', Buffer.from([0, 1])); f.write('mode.sh', 'echo ok\n')
  f.git('add', '.'); f.git('commit', '-qm', 'base files')
  f.git('mv', 'a.txt', 'renamed.txt'); f.write('renamed.txt', 'renamed content\n')
  fs.unlinkSync(path.join(f.dir, 'gone.txt')); f.write('binary.dat', Buffer.from([0, 2])); fs.chmodSync(path.join(f.dir, 'mode.sh'), 0o755)
  ok(await f.service.createStash(f.request(), 'rename', ['renamed.txt', 'gone.txt', 'binary.dat', 'mode.sh'], false))
  assert.equal(f.read('a.txt'), 'hello\n')
  assert.equal(fs.existsSync(path.join(f.dir, 'renamed.txt')), false)
  const stash = await f.stash()
  const detail = ok(await f.service.getStashDetail(f.dir, stash.selector, stash.hash))
  assert.equal(detail.files.find(file => file.path === 'a.txt').status, 'D')
  assert.equal(detail.files.find(file => file.path === 'renamed.txt').status, 'A')
  assert.match(ok(await f.service.getStashDiff(f.dir, stash.selector, stash.hash, 'binary.dat', false)).diff, /Binary files/)
  assert.match(ok(await f.service.getStashDiff(f.dir, stash.selector, stash.hash, 'mode.sh', false)).diff, /new mode 100755/)
  ok(await f.service.mutateStash(f.request(), 'pop-stash', stash.selector, stash.hash))
  assert.equal(f.read('renamed.txt'), 'renamed content\n')
  assert.equal(fs.existsSync(path.join(f.dir, 'gone.txt')), false)
})

test('贮藏编号漂移会拦截写操作和读取；删除要求确认且只删除指定条目', async t => {
  const f = fixture(t)
  f.write('a.txt', 'first\n'); ok(await f.service.createStash(f.request(), 'first', undefined, false))
  const first = await f.stash()
  f.write('a.txt', 'second\n'); ok(await f.service.createStash(f.request(), 'second', undefined, false))
  for (const action of ['apply-stash', 'pop-stash', 'drop-stash', 'branch-stash']) {
    const result = await f.service.mutateStash(f.request(), action, first.selector, first.hash, 'new-branch', true)
    assert.equal(result.code, 'STATE_CONFLICT')
  }
  assert.equal((await f.service.getStashDetail(f.dir, first.selector, first.hash)).code, 'STATE_CONFLICT')
  assert.equal((await f.service.getStashDiff(f.dir, first.selector, first.hash, 'a.txt', false)).code, 'STATE_CONFLICT')
  const selected = { ...first, selector: 'stash@{1}' }
  assert.equal((await f.service.mutateStash(f.request(), 'drop-stash', selected.selector, selected.hash)).code, 'PERMISSION_DENIED')
  ok(await f.service.mutateStash(f.request(), 'drop-stash', selected.selector, selected.hash, undefined, true))
  assert.equal(ok(await f.service.getStashes(f.dir)).length, 1)
  assert.match((await f.stash()).subject, /second/)
  assert.equal(f.read('a.txt'), 'hello\n')
})

test('从贮藏原始提交创建并切换分支，恢复暂存状态及未跟踪文件；拒绝脏工作区', async t => {
  const f = fixture(t)
  const base = f.git('rev-parse', 'HEAD').trim()
  f.write('a.txt', 'staged\n'); f.git('add', 'a.txt'); f.write('new.txt', 'untracked\n')
  ok(await f.service.createStash(f.request(), 'branch me', undefined, true))
  const stash = await f.stash()
  f.write('a.txt', 'new head\n'); f.git('commit', '-qam', 'advance')
  f.write('dirty.txt', 'dirty\n')
  assert.equal((await f.service.mutateStash(f.request(), 'branch-stash', stash.selector, stash.hash, 'restored')).reason, 'DIRTY_WORKTREE')
  fs.unlinkSync(path.join(f.dir, 'dirty.txt'))
  assert.equal((await f.service.mutateStash(f.request(), 'branch-stash', stash.selector, stash.hash, '--bad')).code, 'INVALID_ARGUMENT')
  assert.equal((await f.service.mutateStash(f.request(), 'branch-stash', stash.selector, stash.hash, 'main')).ok, false)
  ok(await f.service.mutateStash(f.request(), 'branch-stash', stash.selector, stash.hash, 'restored'))
  assert.equal(f.git('branch', '--show-current').trim(), 'restored')
  assert.equal(f.git('rev-parse', 'HEAD').trim(), base)
  assert.equal(f.git('show', ':a.txt'), 'staged\n')
  assert.equal(f.read('new.txt'), 'untracked\n')
  assert.equal(ok(await f.service.getStashes(f.dir)).length, 0)
})

test('弹出冲突保留贮藏并可被冲突工作台读取；重复请求不再次执行', async t => {
  const f = fixture(t)
  f.write('a.txt', 'stash side\n'); ok(await f.service.createStash(f.request(), '', undefined, false))
  const stash = await f.stash()
  f.write('a.txt', 'head side\n'); f.git('commit', '-qam', 'conflicting head')
  const request = f.request()
  const result = await f.service.mutateStash(request, 'pop-stash', stash.selector, stash.hash)
  assert.equal(result.ok, false)
  assert.deepEqual(await f.service.mutateStash(request, 'pop-stash', stash.selector, stash.hash), result)
  assert.equal(ok(await f.service.getStashes(f.dir)).length, 1)
  assert.match(f.read('a.txt'), /<<<<<<< /)
  const conflicts = ok(await f.service.conflictAction('get-conflicts', f.dir, {}))
  assert.equal(conflicts.files[0].path, 'a.txt')
  assert.equal((await f.service.mutateStash(f.request(), 'apply-stash', stash.selector, stash.hash)).code, 'STATE_CONFLICT')
})

test('无改动、空选择、未启用未跟踪、恶意引用或路径不能创建或操作贮藏', async t => {
  const f = fixture(t)
  assert.equal((await f.service.createStash(f.request(), '', undefined, false)).ok, false)
  assert.equal((await f.service.createStash(f.request(), '', [], false)).code, 'INVALID_ARGUMENT')
  f.write('new.txt', 'keep\n')
  assert.equal((await f.service.createStash(f.request(), '', ['new.txt'], false)).ok, false)
  assert.equal((await f.service.createStash(f.request(), '', ['../a.txt'], true)).code, 'INVALID_ARGUMENT')
  assert.equal((await f.service.getStashDetail(f.dir, 'stash@{0}; touch bad', 'a'.repeat(40))).code, 'INVALID_ARGUMENT')
  assert.equal((await f.service.getStashDiff(f.dir, 'stash@{0}', 'a'.repeat(40), '/etc/passwd', false)).code, 'INVALID_ARGUMENT')
  assert.equal(f.read('new.txt'), 'keep\n')
  assert.equal(ok(await f.service.getStashes(f.dir)).length, 0)
})

test('会话位于子目录时所选路径仍相对于仓库根目录', async t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.dir, 'nested'))
  f.write('a.txt', 'nested request\n')
  const request = { ...f.request(), workdir: path.join(f.dir, 'nested') }
  ok(await f.service.createStash(request, '', ['a.txt'], false))
  const stash = await f.stash()
  assert.match(ok(await f.service.getStashDiff(request.workdir, stash.selector, stash.hash, 'a.txt', false)).diff, /\+nested request/)
})

test('所选已暂存删除、新增和 intent-to-add 内容全部保存，未选改动保留', async t => {
  const f = fixture(t)
  f.write('keep.txt', 'base\n'); f.git('add', '.'); f.git('commit', '-qm', 'base')
  f.write('keep.txt', 'keep changed\n')
  f.git('rm', 'a.txt')
  f.write('added.txt', 'staged new\n'); f.git('add', 'added.txt')
  f.write('intent.txt', 'intent content\n'); f.git('add', '-N', 'intent.txt')
  ok(await f.service.createStash(f.request(), 'mixed selection', ['a.txt', 'added.txt', 'intent.txt'], false))
  assert.equal(f.read('a.txt'), 'hello\n')
  assert.equal(f.read('keep.txt'), 'keep changed\n')
  assert.equal(fs.existsSync(path.join(f.dir, 'added.txt')), false)
  assert.equal(fs.existsSync(path.join(f.dir, 'intent.txt')), false)
  const stash = await f.stash()
  assert.equal(f.git('show', stash.hash + ':intent.txt'), 'intent content\n')
  assert.deepEqual(ok(await f.service.getStashDetail(f.dir, stash.selector, stash.hash)).files.map(file => file.path), ['a.txt', 'added.txt', 'intent.txt'])
})

test('HTTP 路由贯通创建、详情、Diff、应用、弹出、删除与创建分支', async t => {
  const f = fixture(t)
  const plugin = require('../lib')
  const { EventEmitter } = require('node:events')
  let route
  plugin.apply({
    get(key) {
      if (key === 'shell') return makeShell(f.dir)
      if (key === 'tools') return { register() {} }
      if (key === 'agents') return { get: id => id === 'stash-http' ? { session: { cwd: f.dir } } : undefined }
      return null
    },
    inject: (_deps, callback) => callback({ get: key => key === 'connection' ? { requestRejection: () => undefined } : { register: definition => { route = definition } } }),
  })
  let sequence = 0
  const call = (action, payload = {}) => new Promise(resolve => {
    const req = new EventEmitter()
    req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
    route.handler(req, { writeHead() {}, end(text) { resolve(JSON.parse(text)) } })
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify({ action, sessionId: 'stash-http', operationId: 'http-' + ++sequence, ...payload })))
      req.emit('end')
    })
  })
  const create = async () => {
    ok(await call('create-stash', { message: 'via HTTP', paths: ['a.txt'], includeUntracked: false }))
    return ok(await call('get-stashes'))[0]
  }
  f.write('a.txt', 'http changes\n')
  let stash = await create()
  assert.equal(ok(await call('get-stash-detail', stash)).files[0].path, 'a.txt')
  assert.match(ok(await call('get-stash-diff', { ...stash, path: 'a.txt', untracked: false })).diff, /http changes/)
  ok(await call('apply-stash', stash))
  assert.equal(f.read('a.txt'), 'http changes\n')
  assert.equal((await call('drop-stash', stash)).code, 'PERMISSION_DENIED')
  ok(await call('drop-stash', { ...stash, confirmRisk: true }))
  stash = await create()
  ok(await call('pop-stash', stash))
  stash = await create()
  ok(await call('branch-stash', { ...stash, name: 'http-restored' }))
  assert.equal(f.git('branch', '--show-current').trim(), 'http-restored')
  assert.equal(f.read('a.txt'), 'http changes\n')
  assert.deepEqual(ok(await call('get-stashes')), [])
  assert.equal((await call('get-stash-detail', { ...stash, sessionId: 'missing' })).code, 'SESSION_NOT_FOUND')
})

test('按文件贮藏不受用户 Diff 前缀、颜色和空白校验配置影响', async t => {
  for (const [key, value] of [['diff.noprefix', 'true'], ['color.ui', 'always'], ['apply.whitespace', 'error'], ['apply.whitespace', 'fix']]) {
    await t.test(key + '=' + value, async t => {
      const f = fixture(t)
      f.git('config', key, value)
      f.write('a.txt', 'staged with spaces  \n'); f.git('add', 'a.txt')
      f.write('a.txt', 'working version\n')
      ok(await f.service.createStash(f.request(), 'configured Git', ['a.txt'], false))
      assert.equal(f.read('a.txt'), 'hello\n')
      const stash = await f.stash()
      assert.equal(f.git('show', stash.hash + '^2:a.txt'), 'staged with spaces  \n')
      assert.equal(f.git('show', stash.hash + ':a.txt'), 'working version\n')
      ok(await f.service.mutateStash(f.request(), 'branch-stash', stash.selector, stash.hash, 'restore-configured'))
      assert.equal(f.read('a.txt'), 'working version\n')
      assert.equal(f.git('show', ':a.txt'), 'staged with spaces  \n')
      assert.equal(f.git('config', '--get', key).trim(), value)
    })
  }
})

test('按文件贮藏可以恢复符号链接且不修改链接目标', async t => {
  const f = fixture(t)
  f.write('target.txt', 'target original\n')
  fs.symlinkSync('target.txt', path.join(f.dir, 'link.txt'))
  f.git('add', '.'); f.git('commit', '-qm', 'symlink base')
  fs.unlinkSync(path.join(f.dir, 'link.txt'))
  fs.symlinkSync('a.txt', path.join(f.dir, 'link.txt'))
  ok(await f.service.createStash(f.request(), 'symlink', ['link.txt'], false))
  assert.equal(fs.readlinkSync(path.join(f.dir, 'link.txt')), 'target.txt')
  const stash = await f.stash()
  ok(await f.service.mutateStash(f.request(), 'pop-stash', stash.selector, stash.hash))
  assert.equal(fs.readlinkSync(path.join(f.dir, 'link.txt')), 'a.txt')
  assert.equal(f.read('target.txt'), 'target original\n')
  assert.equal(f.read('a.txt'), 'hello\n')
})

test('未跟踪文件恢复发生重名冲突时不覆盖文件也不删除贮藏', async t => {
  const f = fixture(t)
  f.write('new.txt', 'saved content\n')
  ok(await f.service.createStash(f.request(), 'untracked collision', ['new.txt'], true))
  const stash = await f.stash()
  f.write('new.txt', 'new content\n')
  assert.equal((await f.service.mutateStash(f.request(), 'pop-stash', stash.selector, stash.hash)).ok, false)
  assert.equal(f.read('new.txt'), 'new content\n')
  assert.equal(ok(await f.service.getStashes(f.dir)).length, 1)
  assert.equal(f.git('show', stash.hash + '^3:new.txt'), 'saved content\n')
})
