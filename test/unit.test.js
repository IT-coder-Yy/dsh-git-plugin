'use strict'
/**
 * 单元测试：lib/index.js 导出的纯逻辑（命令校验 / 风险分级 / 预期结果推导等）。
 * 运行：node --test test/
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const plugin = require('../lib')
const { helpers } = plugin

const { parseCommand, validateCommand, classifyRisk, classifyStepsRisk, redactSecrets, redactAndLimit, addPathsOf, deriveChecks } = helpers

test('Host 仅把 Shell/Tools 作为必需服务，WebServer 为可选增强', () => {
  assert.deepStrictEqual(plugin.inject, ['shell', 'tools'])
})

function callHttp(handler, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', ...extraHeaders }
    req.destroy = () => req.emit('error', new Error('destroyed'))
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }) },
    }
    handler(req, res)
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  })
}

test('parseCommand 保留引号内文本并生成安全执行命令', () => {
  const r = parseCommand('git commit -m "fix: a & b; c"')
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.args, ['git', 'commit', '-m', 'fix: a & b; c'])
  assert.strictEqual(r.normalized, "'git' 'commit' '-m' 'fix: a & b; c'")

  const windowsPath = parseCommand('git add "docs\\guide.md"')
  assert.strictEqual(windowsPath.ok, true)
  assert.strictEqual(windowsPath.args[2], 'docs\\guide.md')
})

test('validateCommand 拒绝非 git 命令', () => {
  assert.strictEqual(validateCommand('rm -rf /').ok, false)
  assert.strictEqual(validateCommand('cd /tmp && git status').ok, false)
  assert.strictEqual(validateCommand('npm test && git push').ok, false)
})

test('validateCommand 拒绝命令连接 / 管道 / 重定向 / shell 展开', () => {
  assert.strictEqual(validateCommand('git status & echo bypass').ok, false)
  assert.strictEqual(validateCommand('git status && git push').ok, false)
  assert.strictEqual(validateCommand('git status; git push').ok, false)
  assert.strictEqual(validateCommand('git log | head -5').ok, false)
  assert.strictEqual(validateCommand('git log > /tmp/x').ok, false)
  assert.strictEqual(validateCommand('git commit -m "$(whoami)"').ok, false)
  assert.strictEqual(validateCommand('git commit -m "`date`"').ok, false)
  assert.strictEqual(validateCommand('git commit -m "${HOME}"').ok, false)
  assert.strictEqual(validateCommand('git add $HOME/file').ok, false)
})

test('validateCommand 拒绝 Git 二次执行入口、外部子命令与内嵌凭证', () => {
  assert.strictEqual(validateCommand('git -c alias.pwn="!echo marker" pwn').ok, false)
  assert.strictEqual(validateCommand('git submodule foreach "echo marker"').ok, false)
  assert.strictEqual(validateCommand('git made-up-command').ok, false)
  assert.strictEqual(validateCommand('git fetch --upload-pack=echo origin').ok, false)
  assert.strictEqual(validateCommand('git fetch ext::sh -c id').ok, false)
  assert.strictEqual(validateCommand('git rebase -x "touch marker" HEAD~1').ok, false)
  assert.strictEqual(validateCommand('git merge -s /tmp/evil topic').ok, false)
  assert.strictEqual(validateCommand('git merge -sevil topic').ok, false)
  assert.strictEqual(validateCommand('git push --exec="sh -c id" origin main').ok, false)
  assert.strictEqual(validateCommand('git grep -O"sh -c id" pattern').ok, false)
  assert.strictEqual(validateCommand('git cat-file --filters HEAD:file').ok, false)
  assert.strictEqual(validateCommand('git remote add origin https://user:token@example.com/repo.git').ok, false)
})

test('classifyRisk 高风险命令', () => {
  assert.strictEqual(classifyRisk('git reset --hard HEAD~1').level, 'hard')
  assert.strictEqual(classifyRisk('git reset --soft HEAD~1').level, 'hard')
  assert.strictEqual(classifyRisk('git push --force origin main').level, 'hard')
  assert.strictEqual(classifyRisk('git push -f origin main').level, 'hard')
  assert.strictEqual(classifyRisk('git rebase -i HEAD~3').level, 'hard')
  assert.strictEqual(classifyRisk('git clean -fd').level, 'hard')
  assert.strictEqual(classifyRisk('git branch -D old').level, 'hard')
  assert.strictEqual(classifyRisk('git branch -d old').level, 'hard')
  assert.strictEqual(classifyRisk('git checkout -- .').level, 'hard')
  assert.strictEqual(classifyRisk('git checkout -f main').level, 'hard')
  assert.strictEqual(classifyRisk('git restore .').level, 'hard')
  assert.strictEqual(classifyRisk('git restore --source=HEAD --worktree .').level, 'hard')
  assert.strictEqual(classifyRisk('git stash clear').level, 'hard')
  assert.strictEqual(classifyRisk('git branch -f old HEAD~1').level, 'hard')
  assert.strictEqual(classifyRisk('git push origin :main').level, 'hard')
  assert.strictEqual(classifyRisk('git push -d origin main').level, 'hard')
  assert.strictEqual(classifyRisk('git commit --amend -m fix').level, 'hard')
  assert.strictEqual(classifyRisk('git tag -d v1').level, 'hard')
  assert.strictEqual(classifyRisk('git rm file.txt').level, 'hard')
  assert.strictEqual(classifyRisk('git switch -C main').level, 'hard')
  assert.strictEqual(classifyRisk('git pull --rebase').level, 'hard')
})

test('classifyRisk 常规与安全', () => {
  assert.strictEqual(classifyRisk('git status').level, 'safe')
  assert.strictEqual(classifyRisk('git log --oneline -5').level, 'safe')
  assert.strictEqual(classifyRisk('git diff HEAD').level, 'safe')
  assert.strictEqual(classifyRisk('git add -A').level, 'normal')
  assert.strictEqual(classifyRisk('git push origin main').level, 'normal')
  assert.strictEqual(classifyRisk('git checkout -b feat/x').level, 'hard')
  assert.strictEqual(classifyRisk('git restore --staged a.txt').level, 'normal')
  assert.strictEqual(classifyStepsRisk(['git status', 'git log -1']).level, 'safe')
  assert.strictEqual(classifyStepsRisk(['git status', 'git add -A']).level, 'normal')
  assert.strictEqual(classifyStepsRisk(['git status', 'git reset --hard HEAD']).level, 'hard')
})

test('redactSecrets 脱敏 URL 凭证与常见令牌', () => {
  const text = redactSecrets('https://user:pass@example.com/repo.git?token=abc ghp_123456789012345678901234')
  assert.doesNotMatch(text, /user:pass|token=abc|ghp_123/)
  assert.match(text, /https:\/\/\*\*\*@example\.com/)
  assert.match(redactAndLimit('x'.repeat(25000)), /输出已截断/)
  assert.ok(redactAndLimit('x'.repeat(25000)).length < 20100)
})

test('addPathsOf 剔除 add 的 flags 与 -- 分隔符', () => {
  assert.strictEqual(addPathsOf('git add -f docs/a.md frontend/b.ts'), 'docs/a.md frontend/b.ts')
  assert.strictEqual(addPathsOf('git add -- a.txt'), 'a.txt')
  assert.strictEqual(addPathsOf('git add -A'), '')
})

test('deriveChecks 按命令推导预期结果', () => {
  let checks = deriveChecks(['git commit -m "fix: hello"'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['commit-msg'])
  assert.strictEqual(checks[0].value, 'fix: hello')

  checks = deriveChecks(['git switch -c feat/x'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['branch'])
  assert.strictEqual(checks[0].value, 'feat/x')

  checks = deriveChecks(['git add -f a.txt b.txt', 'git commit -m "fix: hello"'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['commit-msg']) // 有 commit 时不再检查 staged

  checks = deriveChecks(['git add -f a.txt'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['staged'])
  assert.deepStrictEqual(checks[0].value, ['a.txt'])

  checks = deriveChecks(['git add -- "docs/a b.md"'])
  assert.deepStrictEqual(checks[0].value, ['docs/a b.md'])

  checks = deriveChecks(['git branch -D old'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['branch-gone'])

  checks = deriveChecks(['git stash push'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['stash-nonempty'])

  checks = deriveChecks(['git push origin main'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['no-ahead'])
})

test('工具路径按会话隔离，并阻止成功提议重放', async () => {
  const registered = []
  let userCommandRuns = 0
  const tools = { register: (definition) => registered.push(definition) }
  const shell = {
    resolve: (request) => ({ ...request, workdir: request.workdir || '/tmp/repo' }),
    run: async (spec) => {
      if (spec.command === "'git' 'status'") userCommandRuns++
      return { exitCode: 0, signal: null, timedOut: false, stdout: { text: spec.command.includes('rev-parse') ? '/tmp/repo\n' : 'ok\n' }, stderr: { text: '' } }
    },
  }
  const ctx = { get: (key) => key === 'tools' ? tools : key === 'shell' ? shell : null }
  plugin.apply(ctx)
  const byName = (name) => registered.find((definition) => definition.name === name)
  const signal = new AbortController().signal
  const execA = { agent: { id: 'session-a' }, signal }
  const execB = { agent: { id: 'session-b' }, signal }
  const proposal = await byName('git_propose').execute({ intent: '查看状态', command: 'git status', explanation: '只读' }, execA)
  assert.strictEqual(proposal.ok, true)
  assert.strictEqual(proposal.risk, 'safe')
  const crossSession = await byName('git_execute').execute({ proposalId: proposal.proposalId }, execB)
  assert.strictEqual(crossSession.ok, false)
  const first = await byName('git_execute').execute({ proposalId: proposal.proposalId }, execA)
  const replay = await byName('git_execute').execute({ proposalId: proposal.proposalId }, execA)
  assert.strictEqual(first.ok, true)
  assert.strictEqual(replay.ok, false)
  assert.strictEqual(userCommandRuns, 1)
})

test('HTTP 路由严格按 sessionId 隔离提议', async () => {
  const registered = []
  let route = null
  const tools = { register: (definition) => registered.push(definition) }
  const webServer = { register: (definition) => { route = definition } }
  const shell = {
    resolve: (request) => ({ ...request, workdir: request.workdir || '/tmp/repo' }),
    run: async (spec) => ({ exitCode: 0, signal: null, timedOut: false, stdout: { text: spec.command.includes('rev-parse') ? '/tmp/repo\n' : 'ok\n' }, stderr: { text: '' } }),
  }
  plugin.apply({
    get: (key) => key === 'tools' ? tools : key === 'shell' ? shell : key === 'webServer' ? webServer : null,
    inject: (deps, callback) => {
      assert.deepStrictEqual(deps, ['webServer'])
      return callback({ get: (key) => key === 'webServer' ? webServer : null })
    },
  })
  const propose = registered.find((definition) => definition.name === 'git_propose')
  const proposal = await propose.execute(
    { intent: '查看状态', command: 'git status', explanation: '只读' },
    { agent: { id: 'http-session-a' }, signal: new AbortController().signal },
  )
  const own = await callHttp(route.handler, { action: 'state', sessionId: 'http-session-a' })
  const other = await callHttp(route.handler, { action: 'state', sessionId: 'http-session-b' })
  const crossExecute = await callHttp(route.handler, { action: 'execute', sessionId: 'http-session-b', proposalId: proposal.proposalId })
  assert.strictEqual(own.body.proposal.proposalId, proposal.proposalId)
  assert.strictEqual(other.body.proposal, null)
  assert.strictEqual(crossExecute.body.ok, false)
  assert.match(crossExecute.body.error, /找不到该提议/)

  const hard = await propose.execute(
    { intent: '清理文件', command: 'git clean -fd', explanation: '删除未跟踪文件' },
    { agent: { id: 'http-session-hard' }, signal: new AbortController().signal },
  )
  const copyWithoutConfirm = await callHttp(route.handler, { action: 'mark-copied', sessionId: 'http-session-hard', proposalId: hard.proposalId })
  const copyWithConfirm = await callHttp(route.handler, { action: 'mark-copied', sessionId: 'http-session-hard', proposalId: hard.proposalId, confirm: true })
  assert.strictEqual(copyWithoutConfirm.body.ok, false)
  assert.strictEqual(copyWithConfirm.body.ok, true)
  const invalidType = await callHttp(route.handler, { action: 'state', sessionId: 'http-session-a' }, { 'content-type': 'application/json-patch+json' })
  const crossSite = await callHttp(route.handler, { action: 'state', sessionId: 'http-session-a' }, { 'sec-fetch-site': 'cross-site' })
  assert.strictEqual(invalidType.status, 415)
  assert.strictEqual(crossSite.status, 403)
})

test('同一会话执行中不能创建覆盖它的新提议', async () => {
  const registered = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const shell = {
    resolve: (request) => ({ ...request, workdir: request.workdir || '/tmp/repo' }),
    run: async (spec) => {
      if (spec.command === "'git' 'status'") await gate
      return { exitCode: 0, signal: null, timedOut: false, stdout: { text: spec.command.includes('rev-parse') ? '/tmp/repo\n' : 'ok\n' }, stderr: { text: '' } }
    },
  }
  plugin.apply({ get: (key) => key === 'tools' ? { register: (definition) => registered.push(definition) } : key === 'shell' ? shell : null })
  const propose = registered.find((definition) => definition.name === 'git_propose')
  const execute = registered.find((definition) => definition.name === 'git_execute')
  const exec = { agent: { id: 'running-session' }, signal: new AbortController().signal }
  const first = await propose.execute({ intent: '状态', command: 'git status', explanation: '读取状态' }, exec)
  const running = execute.execute({ proposalId: first.proposalId }, exec)
  const replacement = await propose.execute({ intent: '日志', command: 'git log -1', explanation: '读取日志' }, exec)
  assert.strictEqual(replacement.ok, false)
  assert.match(replacement.error, /正在执行/)
  release()
  assert.strictEqual((await running).ok, true)
})

test('buildRecovery：.gitignore 忽略 → add 加 -f', () => {
  const failedStep = { command: 'git add docs/api.md', result: { stderr: '下列路径根据您的一个 .gitignore 文件而被忽略：docs\n提示：请使用 -f', stdout: '' } }
  const recovery = helpers.buildRecovery({}, failedStep, '')
  assert.ok(recovery)
  assert.strictEqual(recovery.command, 'git add -f docs/api.md')
  assert.match(recovery.suggestion, /\.gitignore/)
})

test('buildRecovery：分支已存在 → switch -c 改为 switch', () => {
  const failedStep = { command: 'git switch -c feature/x', result: { stderr: 'fatal: a branch named "feature/x" already exists', stdout: '' } }
  const recovery = helpers.buildRecovery({}, failedStep, '')
  assert.ok(recovery)
  assert.strictEqual(recovery.command, 'git switch feature/x')
})

test('buildRecovery：只读文件系统 → 给出环境建议、无自动改写命令', () => {
  const failedStep = { command: 'git reset --soft HEAD~1', result: { stderr: "cannot lock ref 'HEAD': 无法创建 '.git/HEAD.lock'：只读文件系统", stdout: '' } }
  const recovery = helpers.buildRecovery({}, failedStep, '')
  assert.ok(recovery)
  assert.strictEqual(recovery.command, null)
  assert.match(recovery.suggestion, /只读/)
})

test('buildRecovery：未知失败 → null（不瞎猜）', () => {
  const failedStep = { command: 'git log', result: { stderr: 'some unknown weird error', stdout: '' } }
  assert.strictEqual(helpers.buildRecovery({}, failedStep, ''), null)
})

test('registerRecoveryProposal：自动登记为新的 pending 提议（recovery 标记）', () => {
  const failedProposal = { sessionId: 'recovery-session', workdir: '/tmp/repo' }
  const recovery = { suggestion: '目标文件被 .gitignore 忽略，改用 -f。', command: 'git add -f a.txt' }
  const created = helpers.registerRecoveryProposal(failedProposal, recovery)
  assert.ok(created)
  assert.strictEqual(created.status, 'pending')
  assert.strictEqual(created.recovery, true)
  assert.strictEqual(created.command, 'git add -f a.txt')
  assert.strictEqual(helpers.latestPending('recovery-session').proposalId, created.proposalId)
})
