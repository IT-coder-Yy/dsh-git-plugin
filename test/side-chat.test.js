'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { helpers } = require('../lib')
const { createRepo, cleanup, makeShell } = require('./helpers')

function fixture(saved = {}) {
  const listeners = {}, agents = new Map(), modelChanges = [], guards = []
  let counter = 0
  const tools = { schemas: scope => { assert.equal(typeof scope, 'object'); return ['read', 'shell', 'write', 'git_propose', 'git_repo_state'].map(name => ({ name })) }, restrict: () => {}, guard: fn => guards.push(fn) }
  function agent(id, events = []) {
    const value = {
      id, ctx: { get: key => ({ tools, systemPrompt: { context: () => {} } })[key] },
      session: { header: { id, cwd: '/tmp/project' }, snapshotEvents: () => events },
      inbox: { nextStep: [], nextTurn: [] },
      inject(message) { this.inbox.nextStep.push(message) },
      followup(message) { this.inbox.nextTurn.push(message) },
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
