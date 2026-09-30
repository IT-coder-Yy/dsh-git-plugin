'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { helpers } = require('../lib')
const { createRepo, cleanup, makeShell } = require('./helpers')

function fixture(saved = {}) {
  const listeners = {}, agents = new Map(), modelChanges = [], guards = []
  let counter = 0
  const tools = { schemas: scope => { assert.equal(typeof scope, 'object'); return ['read', 'shell', 'write', 'git_propose', 'git_repo_state', 'git_diff'].map(name => ({ name })) }, restrict: () => {}, guard: fn => guards.push(fn) }
  function agent(id, events = []) {
    const value = {
      id, ctx: { get: key => ({ tools, systemPrompt: { context: () => {} } })[key] },
      session: { header: { id, cwd: '/tmp/project' }, snapshotEvents: () => events },
      inbox: { nextStep: [], nextTurn: [] },
      inject(message) { this.inbox.nextStep.push(message) },
      status: 'idle',
      followup(message) { this.inbox.nextTurn.push(message) },
      cancel() { this.inbox.nextTurn = []; this.status = 'idle' },
      async whenIdle() {},
    }
    agents.set(id, value)
    return value
  }
  const parent = agent('main', [{ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '原始目标' }] } }])
  const model = { provider: 'provider', model: 'model-a', reasoningEffort: 'high' }
  const controller = {
    async inspect(id) { const a = agents.get(id); if (!a) throw new Error('missing'); return { meta: a.session.header, events: structuredClone(a.session.snapshotEvents()) } },
    async fork({ sessionId, atSeq }) { const id = 'child-' + ++counter; agent(id, structuredClone(agents.get(sessionId).session.snapshotEvents().filter(e => e.seq <= atSeq))); return { sessionId: id } },
    async create() { const id = 'child-' + ++counter; agent(id); return { sessionId: id } },
    async resolveAgent(id) { return { agent: agents.get(id) } },
    async selectModel(selection) { modelChanges.push(structuredClone(selection)) },
    async rename() {},
  }
  const services = {
    tools, agents: { get: id => agents.get(id) }, sessionController: controller,
    sessionQuery: { observeSession: async () => ({ projections: { values: { modelSelection: { next: structuredClone(model) } } }, [Symbol.dispose]() {} }) },
    storage: { backend: { get: () => ({ kv: { open: async () => ({
      loadAll: async () => ({ tables: { links: structuredClone(saved) } }),
      putRecord: async (_, id, value) => { saved[id] = structuredClone(value) }, close: async () => {},
    }) } }) } },
  }
  const ctx = { get: key => services[key], on: (name, fn) => { listeners[name] = fn }, effect: () => {} }
  const service = new helpers.SideChatService(ctx)
  return { service, ctx, parent, agent, agents, model, modelChanges, controller, guards, saved, listeners }
}

test('并发打开幂等；同目录不同主会话隔离；仅初始化模型；恢复关联', async () => {
  const f = fixture()
  const [first, again] = await Promise.all([f.service.open('main'), f.service.open('main')])
  assert.equal(first.sessionId, again.sessionId)
  assert.deepEqual(f.modelChanges, [{ sessionId: first.sessionId, provider: 'provider', model: 'model-a', reasoningEffort: 'high' }])
  f.model.model = 'model-b'
  await f.service.open('main')
  assert.equal(f.modelChanges.length, 1)
  f.agent('another-main')
  const second = await f.service.open('another-main')
  assert.notEqual(second.sessionId, first.sessionId)
  const restored = new helpers.SideChatService(f.ctx)
  assert.equal((await restored.open('main')).sessionId, first.sessionId)
  assert.equal(f.modelChanges.length, 2)
  await assert.rejects(f.service.open(first.sessionId), /嵌套/)
})

test('增量上下文不唤醒；不重复同步；取消后补齐；不复制模型设置或执行主会话命令', async () => {
  const f = fixture(), opened = await f.service.open('main'), child = f.agents.get(opened.sessionId)
  f.parent.session.snapshotEvents().push(
    { seq: 1, type: 'model/selection', data: { model: 'changed' } },
    { seq: 2, type: 'tool/call', data: { name: 'shell', arguments: 'git reset --hard' } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最新上下文' }] } } },
  )
  await f.service.open('main')
  assert.equal(child.inbox.nextStep.length, 1)
  assert.equal(child.inbox.nextTurn.length, 0)
  assert.match(child.inbox.nextStep[0].content[0].text, /最新上下文/)
  assert.doesNotMatch(child.inbox.nextStep[0].content[0].text, /model\/selection/)
  await f.service.open('main')
  assert.equal(child.inbox.nextStep.length, 1)
  child.inbox.nextStep = [] // native cancel may discard pending context
  const decision = await f.listeners['agent/pre-step']({ agent: child, signal: new AbortController().signal }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(decision.messages.length, 1)
  child.session.snapshotEvents().push({ seq: 4, type: 'user/message', data: decision.messages[0] })
  await f.service.open('main')
  assert.equal(child.inbox.nextStep.length, 0)
  assert.equal(f.parent.session.snapshotEvents().length, 4)
})

test('侧边会话写工具被拦截，主会话不受影响；执行反馈只发往侧边', async () => {
  const f = fixture(), opened = await f.service.open('main'), child = f.agents.get(opened.sessionId)
  for (const name of ['shell', 'write', 'subagent', 'unknown']) assert.match(f.guards[0]({ agent: child, name }), /点击执行/)
  for (const name of ['read', 'git_propose', 'git_repo_state']) assert.equal(f.guards[0]({ agent: child, name }), undefined)
  assert.equal(f.guards[0]({ agent: f.parent, name: 'shell' }), undefined)
  await f.service.feedback('main', 'proposal-1', { ok: true, command: 'git status' })
  assert.equal(child.inbox.nextTurn.length, 1)
  assert.equal(f.parent.inbox.nextTurn.length, 0)
})

test('真实仓库快照识别同状态内容变化、未跟踪文件变化及分支变化', async () => {
  const dir = createRepo()
  try {
    const repository = new helpers.GitRepositoryService(makeShell(dir))
    fs.writeFileSync(dir + '/a.txt', 'first\n')
    const first = await repository.proposalSnapshot(dir)
    fs.writeFileSync(dir + '/a.txt', 'other\n')
    const other = await repository.proposalSnapshot(dir)
    assert.notEqual(first, other)
    fs.writeFileSync(dir + '/new.txt', 'aaa')
    const untracked = await repository.proposalSnapshot(dir)
    fs.writeFileSync(dir + '/new.txt', 'bbb')
    assert.notEqual(untracked, await repository.proposalSnapshot(dir))
    const before = await repository.proposalSnapshot(dir)
    await repository.run(dir, 'git branch extra')
    assert.notEqual(before, await repository.proposalSnapshot(dir))
  } finally { cleanup(dir) }
})

test('建议与工作台共享仓库锁，不同实例对同仓库写入串行', async () => {
  const dir = createRepo()
  try {
    const first = new helpers.GitRepositoryService(makeShell(dir)), second = new helpers.GitRepositoryService(makeShell(dir))
    let release, entered
    const started = new Promise(resolve => { entered = resolve })
    const pending = new Promise(resolve => { release = resolve })
    const held = first.serializeProposal(dir, async () => { entered(); await pending })
    await started
    let finished = false
    const mutation = second.stageAll({ sessionId: 's', workdir: dir, operationId: 'stage' }).then(result => { finished = true; assert.equal(result.ok, true) })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(finished, false)
    release()
    await Promise.all([held, mutation])
  } finally { cleanup(dir) }
})

test('侧边提议归属主会话；过期拒绝、成功与重复执行反馈隔离', async () => {
  const dir = createRepo(), f = fixture(), registered = new Map()
  try {
    for (const a of f.agents.values()) a.session.header.cwd = dir
    const baseGet = f.ctx.get
    const realShell = makeShell(dir)
    const policy = { mode: 'workspace-write', workspaceRoot: dir, sessionId: 'main' }
    const requests = []
    const services = {
      shell: { ...realShell, resolve(request) {
        requests.push(request)
        assert.deepEqual(request.sandboxPolicy, policy, '每次 Git 读取和写入均应继承主会话策略')
        return { ...realShell.resolve(request), sandboxPolicy: request.sandboxPolicy }
      } },
      sandboxPolicy: { resolve: ({ session }) => ({ ...policy, sessionId: session.header.id }) },
      tools: { ...baseGet('tools'), register: tool => registered.set(tool.name, tool) },
      connection: { requestRejection: () => undefined },
      webServer: { register: route => { services.route = route } },
    }
    f.ctx.get = key => services[key] ?? baseGet(key)
    require('../lib').apply(f.ctx)
    const { EventEmitter } = require('node:events')
    const http = body => new Promise(resolve => {
      const req = new EventEmitter(); req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
      services.route.handler(req, { writeHead() {}, end: text => resolve(JSON.parse(text)) })
      queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify({ sessionId: 'main', ...body }))); req.emit('end') })
    })
    const opened = await http({ action: 'side-chat' }); assert.equal(opened.ok, true)
    const child = f.agents.get(opened.sessionId); child.session.header.cwd = dir
    const state = await registered.get('git_repo_state').execute({}, { agent: child })
    assert.equal(state.isRepo, true)
    assert.equal(state.topLevel, dir)
    fs.writeFileSync(dir + '/a.txt', 'read-only diff\n')
    const diffTool = registered.get('git_diff')
    assert.equal(f.guards.at(-1)({ name: 'git_diff', agent: child }), undefined)
    assert.match((await diffTool.execute({}, { agent: child })).diff, /\+read-only diff/)
    assert.equal((await diffTool.execute({}, { agent: { id: 'missing' } })).ok, false)
    assert.ok(requests.filter(request => request.command.includes('diff')).every(request => request.workdir === dir))
    const propose = command => registered.get('git_propose').execute({ command, intent: 'test' }, { agent: child })
    const old = await propose('git branch stale'); assert.equal(old.ok, true)
    assert.equal(helpers.findProposal('main', old.proposalId).chatSessionId, child.id)
    assert.equal(helpers.findProposal(child.id, old.proposalId), undefined)
    fs.writeFileSync(dir + '/a.txt', 'external change\n')
    assert.match((await http({ action: 'execute', proposalId: old.proposalId })).error, /仓库已变化/)
    assert.equal(child.inbox.nextTurn.length, 1)
    await http({ action: 'execute', proposalId: old.proposalId })
    assert.equal(child.inbox.nextTurn.length, 1, '重复请求不应再次唤醒模型')
    const fresh = await propose('git branch fresh'); assert.equal(fresh.ok, true)
    assert.equal((await http({ action: 'execute', proposalId: fresh.proposalId })).ok, true)
    assert.equal(child.inbox.nextTurn.length, 2)
    const failed = await propose('git switch -c main')
    const failure = await http({ action: 'execute', proposalId: failed.proposalId })
    assert.equal(failure.ok, false)
    const recovery = helpers.findProposal('main', failure.recovery.proposalId)
    assert.equal(recovery.chatSessionId, child.id)
    assert.match(recovery.repositorySnapshot, /^[a-f0-9]{64}$/)
    assert.equal(f.parent.inbox.nextTurn.length, 0)
    const manual = await propose('git switch -c manual-policy')
    assert.equal((await http({ action: 'mark-copied', proposalId: manual.proposalId })).ok, true)
    assert.equal((await http({ action: 'verify', proposalId: manual.proposalId })).verified, false)
    await realShell.run(realShell.resolve({ command: 'git switch -c manual-policy', workdir: dir }))
    assert.equal((await http({ action: 'verify', proposalId: manual.proposalId })).verified, true)
    assert.ok(requests.length > 10)
    const { execFileSync } = require('node:child_process')
    const branches = execFileSync('git', ['branch', '--list'], { cwd: dir, encoding: 'utf8' })
    assert.match(branches, /fresh/); assert.doesNotMatch(branches, /stale/)
  } finally { cleanup(dir) }
})

test('自动分析并发去重、明确追问、取消启动竞态及失败重试', async () => {
  const f = fixture(), proposal = { sessionId: 'main', proposalId: 'failure', failure: { command: 'git switch missing', message: 'invalid reference' } }
  let saved = 0
  const persist = async () => { saved++ }
  await Promise.all([f.service.requestAnalysis(proposal, persist), f.service.requestAnalysis(proposal, persist)])
  const child = f.agents.get(f.saved.main.sessionId)
  assert.equal(child.inbox.nextTurn.length, 1)
  assert.ok(proposal.analysisRequestedAt)
  assert.match(child.inbox.nextTurn[0].content[0].text, /不要猜测/)
  assert.doesNotMatch(child.inbox.nextTurn[0].content[0].text, /用户已.*确认/)
  assert.equal((await f.service.status('main')).running, true)
  await f.service.cancel('main')
  assert.equal(child.inbox.nextTurn.length, 0)
  assert.equal((await f.service.status('main')).running, false)
  child.session.snapshotEvents().push({ seq: 10, time: Date.now(), type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '想新建分支，还是切换远程分支？' }] } } })
  assert.match((await f.service.status('main', proposal.analysisRequestedAt)).reply, /想新建/)
  assert.equal((await f.service.status('another-main')).reply, '')
  child.session.snapshotEvents().push({ seq: 11, time: Date.now(), type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'provider unavailable' } } } })
  assert.equal((await f.service.status('main')).error, 'provider unavailable')
  const cancelled = { ...proposal, proposalId: 'cancelled', analysisRequestedAt: undefined }
  const starting = f.service.requestAnalysis(cancelled, persist)
  cancelled.analysisCancelledAt = Date.now()
  await starting
  assert.equal(child.inbox.nextTurn.length, 0)
  const next = { ...proposal, analysisRequestedAt: undefined }
  const followup = child.followup
  child.followup = () => { throw new Error('admission failed') }
  await assert.rejects(f.service.requestAnalysis(next, persist), /admission failed/)
  assert.equal(next.analysisRequestedAt, undefined)
  child.followup = followup
  await f.service.requestAnalysis(next, persist, true)
  assert.equal(child.inbox.nextTurn.length, 1)
  assert.equal(f.parent.inbox.nextTurn.length, 0)
})
