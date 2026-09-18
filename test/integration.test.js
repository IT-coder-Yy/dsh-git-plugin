'use strict'
/**
 * Integration tests for the core plugin flow in real temporary Git repositories:
 * step execution, expected-state verification, partial execution, and fingerprint
 * changes. A child_process adapter stands in for Harness's shell service.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const plugin = require('../lib')
const { helpers } = plugin
const { makeShell, createRepo, cleanup } = require('./helpers')

const { deriveChecks, runChecks, verifyProposal, executeProposalSteps, executeRegisteredProposal, captureFingerprint, storeProposal, findProposal, proposalView, latestPending } = helpers

function callHttp(handler, body) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json' }
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

test('提交流程：add+commit 两步执行 → 逐步成功 → 预期校验全部通过', async () => {
  const dir = createRepo()
  try {
    const shell = makeShell(dir)
    fs.writeFileSync(path.join(dir, 'b.txt'), 'world\n')
    const steps = ['git add -f b.txt', 'git commit -m "fix: hello"']
    const proposal = { workdir: dir, steps: steps.map((c) => ({ command: c, result: null })) }
    const { ok, stepsResult } = await executeProposalSteps(shell, proposal)
    assert.strictEqual(ok, true)
    assert.deepStrictEqual(stepsResult.map((s) => s.ok), [true, true])

    const checks = deriveChecks(steps)
    assert.deepStrictEqual(checks.map((c) => c.type), ['commit-msg'])
    const failed = await runChecks(shell, dir, checks)
    assert.deepStrictEqual(failed, [], '预期结果应全部满足')
  } finally { cleanup(dir) }
})

test('部分执行：只 add 不 commit → commit-msg 校验失败（对应面板 partial 状态）', async () => {
  const dir = createRepo()
  try {
    const shell = makeShell(dir)
    fs.writeFileSync(path.join(dir, 'b.txt'), 'world\n')
    execFileSync('git', ['add', '-f', 'b.txt'], { cwd: dir }) // Simulate a user who ran only the first step.

    const checks = deriveChecks(['git add -f b.txt', 'git commit -m "fix: hello"'])
    assert.deepStrictEqual(checks.map((c) => c.type), ['commit-msg'])
    const failed = await runChecks(shell, dir, checks)
    assert.ok(failed.length > 0, '未提交时 commit-msg 校验必须失败')
    assert.match(failed[0], /最近提交信息应为/)
  } finally { cleanup(dir) }
})

test('建分支：switch -c 后 branch 校验通过，且仓库指纹发生变化', async () => {
  const dir = createRepo()
  try {
    const shell = makeShell(dir)
    const before = await captureFingerprint(shell, dir)
    execFileSync('git', ['switch', '-q', '-c', 'feat/x'], { cwd: dir })
    const after = await captureFingerprint(shell, dir)
    assert.notStrictEqual(before, after, '切分支后指纹应变化')

    const checks = deriveChecks(['git switch -c feat/x'])
    assert.deepStrictEqual(checks.map((c) => c.type), ['branch'])
    const failed = await runChecks(shell, dir, checks)
    assert.deepStrictEqual(failed, [], '当前分支应为 feat/x')
  } finally { cleanup(dir) }
})

test('同步工作台：Fetch、仅快进 Pull、Push 设置上游及 Rebase 中止使用真实仓库', async () => {
  const dir = createRepo()
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-remote-'))
  const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-peer-'))
  try {
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main'], { cwd: bare })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: dir })
    const repository = new helpers.GitRepositoryService(makeShell(dir))
    const request = (operationId) => ({ sessionId: 'sync-session', workdir: dir, operationId })

    let state = await repository.getSyncState(dir)
    assert.strictEqual(state.ok, true)
    assert.strictEqual(state.data.branch, 'main')
    assert.strictEqual(state.data.upstream, 'origin/main')
    assert.deepStrictEqual(state.data.remotes, ['origin'])
    assert.strictEqual(state.data.ahead, 0)
    assert.strictEqual(state.data.behind, 0)

    execFileSync('git', ['clone', '-q', bare, peer])
    execFileSync('git', ['config', 'user.name', 'peer'], { cwd: peer })
    execFileSync('git', ['config', 'user.email', 'peer@example.com'], { cwd: peer })
    fs.writeFileSync(path.join(peer, 'remote.txt'), 'remote\n')
    execFileSync('git', ['add', 'remote.txt'], { cwd: peer })
    execFileSync('git', ['commit', '-q', '-m', 'remote update'], { cwd: peer })
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: peer })

    const fetched = await repository.fetchRemote(request('fetch-origin'), 'origin')
    assert.strictEqual(fetched.ok, true, JSON.stringify(fetched))
    assert.strictEqual(fetched.data.behind, 1)
    const pulled = await repository.pullFfOnly(request('pull-ff-only'))
    assert.strictEqual(pulled.ok, true, JSON.stringify(pulled))
    assert.strictEqual(pulled.data.behind, 0)
    assert.strictEqual(fs.readFileSync(path.join(dir, 'remote.txt'), 'utf8'), 'remote\n')

    execFileSync('git', ['switch', '-q', '-c', 'feature/sync'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature\n')
    execFileSync('git', ['add', 'feature.txt'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feature update'], { cwd: dir })
    const pushed = await repository.pushCurrent(request('push-feature'), 'origin', 'feature/sync', true)
    assert.strictEqual(pushed.ok, true, JSON.stringify(pushed))
    assert.strictEqual(pushed.data.upstream, 'origin/feature/sync')

    execFileSync('git', ['switch', '-q', 'main'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main change\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'main conflict'], { cwd: dir })
    execFileSync('git', ['switch', '-q', '-c', 'feature/conflict', 'HEAD~1'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature change\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feature conflict'], { cwd: dir })

    const withoutConfirmation = await repository.rebaseOnto(request('rebase-without-confirm'), 'main', false)
    assert.strictEqual(withoutConfirmation.ok, false)
    assert.strictEqual(withoutConfirmation.code, 'PERMISSION_DENIED')
    const conflicted = await repository.rebaseOnto(request('rebase-conflict'), 'main', true)
    assert.strictEqual(conflicted.ok, false)
    assert.strictEqual(conflicted.code, 'GIT_FAILED')
    state = await repository.getSyncState(dir)
    assert.strictEqual(state.ok, true)
    assert.strictEqual(state.data.rebaseInProgress, true)
    assert.ok(state.data.conflictCount > 0)
    const aborted = await repository.abortRebase(request('rebase-abort'), true)
    assert.strictEqual(aborted.ok, true, JSON.stringify(aborted))
    assert.strictEqual(aborted.data.rebaseInProgress, false)

    const conflictedAgain = await repository.rebaseOnto(request('rebase-conflict-again'), 'main', true)
    assert.strictEqual(conflictedAgain.ok, false)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved change\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    const continued = await repository.continueRebase(request('rebase-continue'), true)
    assert.strictEqual(continued.ok, true, JSON.stringify(continued))
    assert.strictEqual(continued.data.rebaseInProgress, false)
  } finally {
    cleanup(dir)
    cleanup(peer)
    cleanup(bare)
  }
})

test('暂存校验：git add 后 staged 检查通过', async () => {
  const dir = createRepo()
  try {
    const shell = makeShell(dir)
    fs.writeFileSync(path.join(dir, 'c.txt'), 'x\n')
    execFileSync('git', ['add', '-f', 'c.txt'], { cwd: dir })
    const checks = deriveChecks(['git add -f c.txt'])
    const failed = await runChecks(shell, dir, checks)
    assert.deepStrictEqual(failed, [])
  } finally { cleanup(dir) }
})

test('执行失败即停：第一步成功、第二步失败 → ok=false 且第二步结果记录为失败', async () => {
  const dir = createRepo()
  try {
    const shell = makeShell(dir)
    fs.writeFileSync(path.join(dir, 'b.txt'), 'world\n')
    // The second step fails because it commits a nonexistent path.
    const proposal = { workdir: dir, steps: [
      { command: 'git add -f b.txt', result: null },
      { command: 'git commit -m "x" -- nonexistent.txt', result: null },
    ] }
    const { ok, stepsResult } = await executeProposalSteps(shell, proposal)
    assert.strictEqual(ok, false)
    assert.strictEqual(stepsResult.length, 2, '两步都要执行到')
    assert.strictEqual(stepsResult[0].ok, true)
    assert.strictEqual(stepsResult[1].ok, false)
    assert.strictEqual(proposal.steps[1].result.ok, false)
  } finally { cleanup(dir) }
})

test('提议存储：登记 / 查找 / 新提议顶替旧提议', () => {
  const now = Date.now()
  const mk = (id, seq) => ({ proposalId: id, sessionId: 's1', closed: false, createdAt: now + seq, steps: [{ command: 'git status', result: null }] })
  storeProposal('s1', mk('p1', 1))
  storeProposal('s1', mk('p2', 2))
  assert.strictEqual(findProposal('s1', 'p1').proposalId, 'p1')
  assert.strictEqual(findProposal('s2', 'p1'), undefined, '其他会话不得读取本会话提议')
  const p2 = findProposal('s1', 'p2')
  const view = proposalView(p2)
  assert.strictEqual(view.proposalId, 'p2')
  assert.strictEqual(view.steps.length, 1)
  assert.strictEqual(latestPending('s1').proposalId, 'p2')

  // Simulate git_propose replacement by closing every previous pending proposal.
  const prev = [{ proposalId: 'p1', closed: false }, { proposalId: 'p2', closed: false }]
  for (const pp of prev) pp.closed = true
  storeProposal('s1', mk('p3', 3))
  assert.strictEqual(latestPending('s1').proposalId, 'p3')
})

test('提议执行防重放：成功后同一 proposalId 不能再次执行', async () => {
  const dir = createRepo()
  try {
    const base = makeShell(dir)
    let userCommandRuns = 0
    const shell = {
      resolve: base.resolve,
      run: async (spec) => {
        if (spec.command === "'git' 'status'") userCommandRuns++
        return base.run(spec)
      },
    }
    const proposal = {
      proposalId: 'replay-test',
      workdir: dir,
      command: 'git status',
      steps: [{ command: 'git status', result: null }],
      status: 'pending',
      closed: false,
    }
    const first = await executeRegisteredProposal(shell, proposal)
    const second = await executeRegisteredProposal(shell, proposal)
    assert.strictEqual(first.ok, true)
    assert.strictEqual(second.ok, false)
    assert.match(second.error, /不能重复执行/)
    assert.strictEqual(userCommandRuns, 1)
  } finally { cleanup(dir) }
})

test('手动验证：只有目标状态从不满足迁移为满足才确认成功', async () => {
  const dir = createRepo()
  try {
    const shell = makeShell(dir)
    const proposal = {
      workdir: dir,
      steps: [{ command: 'git switch -c feat/manual', result: null }],
      fingerprint: await captureFingerprint(shell, dir),
    }
    proposal.baselineFailed = await runChecks(shell, dir, deriveChecks(proposal.steps.map((step) => step.command)))
    assert.strictEqual(proposal.baselineFailed.length, 1)

    execFileSync('git', ['switch', '-q', '-c', 'feat/manual'], { cwd: dir })
    const verified = await verifyProposal(shell, proposal)
    assert.strictEqual(verified.verified, true)
    assert.strictEqual(verified.partial, false)
  } finally { cleanup(dir) }
})

test('手动验证：复制前已满足的状态不得误报为本次执行成功', async () => {
  const dir = createRepo()
  try {
    const shell = makeShell(dir)
    const proposal = {
      workdir: dir,
      steps: [{ command: 'git commit -m init', result: null }],
      fingerprint: await captureFingerprint(shell, dir),
    }
    proposal.baselineFailed = await runChecks(shell, dir, deriveChecks(proposal.steps.map((step) => step.command)))
    assert.deepStrictEqual(proposal.baselineFailed, [])

    const result = await verifyProposal(shell, proposal)
    assert.strictEqual(result.verified, false)
    assert.match(result.message, /已经满足/)
  } finally { cleanup(dir) }
})

test('执行失败自动生成并登记修正提议（.gitignore 忽略 → add -f）', async () => {
  const dir = createRepo()
  try {
    const shell = makeShell(dir)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'b.txt\n')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x\n')
    const proposal = {
      proposalId: 'p-rec', sessionId: 'rec-sess', workdir: dir,
      command: 'git add b.txt',
      steps: [{ command: 'git add b.txt', result: null }],
      risk: 'normal', reasons: [], confirmed: false,
      status: 'pending', closed: false,
    }
    const result = await executeRegisteredProposal(shell, proposal)
    assert.strictEqual(result.ok, false)
    assert.ok(result.recovery, '失败响应应携带 recovery')
    assert.strictEqual(result.recovery.command, 'git add -f b.txt')
    assert.ok(result.recovery.proposalId, '应自动登记修正提议')
    const next = latestPending('rec-sess')
    assert.ok(next, '修正提议应为最新的 pending 提议')
    assert.strictEqual(next.recovery, true)
    assert.strictEqual(next.command, 'git add -f b.txt')
    assert.strictEqual(next.status, 'pending')
  } finally { cleanup(dir) }
})

test('提议命令的复杂失败保留在建议页并等待 Agent 确认', async () => {
  const dir = createRepo()
  try {
    const shell = makeShell(dir)
    const proposal = {
      proposalId: 'p-complex', sessionId: 'complex-proposal-session', workdir: dir,
      command: 'git reset --soft HEAD~99',
      steps: [{ command: 'git reset --soft HEAD~99', result: null }],
      risk: 'normal', reasons: [], confirmed: false,
      status: 'pending', closed: false,
    }
    const result = await executeRegisteredProposal(shell, proposal)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.recovery, null)
    assert.strictEqual(result.analysis.proposalId, 'p-complex')
    assert.strictEqual(proposal.needsAgentAnalysis, true)
    assert.strictEqual(proposal.failure.command, 'git reset --soft HEAD~99')
    assert.match(proposal.failure.stderr, /HEAD~99|unknown revision|ambiguous argument/i)
  } finally { cleanup(dir) }
})

test('结构化仓库 Action 受会话工作目录约束，并对 operationId 去重', async () => {
  const dir = createRepo()
  try {
    fs.writeFileSync(path.join(dir, 'work.txt'), 'pending\n')
    fs.mkdirSync(path.join(dir, 'nested-cache'))
    fs.writeFileSync(path.join(dir, 'nested-cache', 'cache.txt'), 'nested pending\n')
    const registered = []
    let route
    let addRuns = 0
    let agentLookups = 0
    let forceUnstageFailure = false
    const baseShell = makeShell(dir)
    const shell = {
      resolve: baseShell.resolve,
      run: async (spec) => {
        if (spec.command === "git add -- 'work.txt'") addRuns += 1
        if (spec.command === "git switch -c 'localized-existing' 'main'") {
          return { exitCode: 128, stderr: { text: "致命错误：一个名为 'localized-existing' 的分支已经存在" }, stdout: { text: '' } }
        }
        if (forceUnstageFailure && spec.command === 'git reset HEAD -- :/') {
          return { exitCode: 1, stderr: { text: 'fatal: simulated unstage failure' }, stdout: { text: '' } }
        }
        return baseShell.run(spec)
      },
    }
    const session = { cwd: dir }
    plugin.apply({
      get: (key) => {
        if (key === 'shell') return shell
        if (key === 'tools') return { register: (definition) => registered.push(definition) }
        if (key === 'agents') return { get: (id) => { agentLookups += 1; return id === 'workbench-session' ? { session } : undefined } }
        return null
      },
      inject: (_deps, callback) => callback({ get: (key) => key === 'connection' ? { requestRejection: () => undefined } : { register: (definition) => { route = definition } } }),
    })

    const summary = await callHttp(route.handler, { action: 'get-summary', sessionId: 'workbench-session' })
    assert.strictEqual(summary.status, 200)
    assert.strictEqual(summary.body.ok, true)
    assert.strictEqual(summary.body.data.topLevel, dir)
    assert.match(summary.body.data.head, /^[0-9a-f]+$/)
    assert.ok(summary.body.data.files.some((file) => file.path === 'work.txt'))
    assert.ok(summary.body.data.files.some((file) => file.path === 'nested-cache/cache.txt'), '未跟踪目录应列出其内部文件，供前端构建可展开目录树')

    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir })
    execFileSync('git', ['tag', 'v1.0.0'], { cwd: dir })
    const references = await callHttp(route.handler, { action: 'get-branches', sessionId: 'workbench-session' })
    assert.strictEqual(references.body.ok, true)
    assert.ok(references.body.data.branches.some((branch) => branch.name === 'main' && branch.current))
    assert.ok(references.body.data.remotes.some((remote) => remote.name === 'origin/main'))
    assert.ok(references.body.data.tags.some((tag) => tag.name === 'v1.0.0' && tag.hash))

    const lookupsBeforeFailure = agentLookups
    const existingBranch = await callHttp(route.handler, {
      action: 'create-branch', sessionId: 'workbench-session', operationId: 'create-existing-main', name: 'main', base: 'main',
    })
    assert.strictEqual(agentLookups, lookupsBeforeFailure + 1, '同一请求的执行与修正提议必须复用同一份会话上下文')
    assert.strictEqual(existingBranch.body.ok, false)
    assert.strictEqual(existingBranch.body.code, 'STATE_CONFLICT')
    assert.strictEqual(existingBranch.body.reason, 'BRANCH_EXISTS')
    assert.strictEqual(existingBranch.body.failure.command, "git switch -c 'main' 'main'")
    assert.strictEqual(existingBranch.body.failure.code, 'STATE_CONFLICT')
    assert.strictEqual(existingBranch.body.failure.message, '同名本地分支已经存在')
    assert.strictEqual(existingBranch.body.failure.mayHavePartialChanges, false)
    assert.ok(existingBranch.body.recovery, '按钮命令失败后应返回已登记的修正提议')
    assert.strictEqual(existingBranch.body.recovery.command, "git switch 'main'")
    assert.match(existingBranch.body.recovery.suggestion, /已存在/)
    assert.ok(existingBranch.body.recovery.proposalId)
    const buttonRecovery = latestPending('workbench-session')
    assert.ok(buttonRecovery, '修正提议应出现在同一会话的建议页数据源中')
    assert.strictEqual(buttonRecovery.proposalId, existingBranch.body.recovery.proposalId)
    assert.strictEqual(buttonRecovery.command, "git switch 'main'")
    assert.strictEqual(buttonRecovery.status, 'pending')
    assert.strictEqual(buttonRecovery.recovery, true)
    const repeatedExistingBranch = await callHttp(route.handler, {
      action: 'create-branch', sessionId: 'workbench-session', operationId: 'create-existing-main', name: 'main', base: 'main',
    })
    assert.strictEqual(repeatedExistingBranch.body.recovery.proposalId, existingBranch.body.recovery.proposalId, '相同 operationId 不得重复登记修正提议')
    assert.strictEqual(latestPending('workbench-session').proposalId, existingBranch.body.recovery.proposalId)

    const localizedExistingBranch = await callHttp(route.handler, {
      action: 'create-branch', sessionId: 'workbench-session', operationId: 'create-localized-existing', name: 'localized-existing', base: 'main',
    })
    assert.strictEqual(localizedExistingBranch.body.ok, false)
    assert.strictEqual(localizedExistingBranch.body.recovery.command, "git switch 'localized-existing'")
    assert.strictEqual(latestPending('workbench-session').proposalId, localizedExistingBranch.body.recovery.proposalId)

    const untrackedDiff = await callHttp(route.handler, { action: 'get-diff', sessionId: 'workbench-session', path: 'work.txt', staged: false })
    assert.strictEqual(untrackedDiff.body.ok, true)
    assert.match(untrackedDiff.body.data.diff, /^\+pending$/m)

    const firstStage = await callHttp(route.handler, { action: 'stage-paths', sessionId: 'workbench-session', operationId: 'stage-work-file', paths: ['work.txt'] })
    const repeatedStage = await callHttp(route.handler, { action: 'stage-paths', sessionId: 'workbench-session', operationId: 'stage-work-file', paths: ['work.txt'] })
    assert.strictEqual(firstStage.body.ok, true)
    assert.strictEqual(repeatedStage.body.ok, true)
    assert.strictEqual(addRuns, 1, 'the same operationId must not stage the file twice')

    const unstageAll = await callHttp(route.handler, { action: 'unstage-all', sessionId: 'workbench-session', operationId: 'unstage-all-work-file' })
    assert.strictEqual(unstageAll.body.ok, true)
    assert.strictEqual(unstageAll.body.data.stagedCount, 0)
    const stageAgain = await callHttp(route.handler, { action: 'stage-paths', sessionId: 'workbench-session', operationId: 'stage-work-file-again', paths: ['work.txt'] })
    assert.strictEqual(stageAgain.body.ok, true)

    const traversal = await callHttp(route.handler, { action: 'stage-paths', sessionId: 'workbench-session', operationId: 'invalid-path', paths: ['../outside.txt'] })
    assert.deepStrictEqual(traversal.body, { ok: false, code: 'INVALID_ARGUMENT', message: 'paths 必须包含 1–100 个仓库内相对路径' })

    const commit = await callHttp(route.handler, { action: 'commit', sessionId: 'workbench-session', operationId: 'commit-work-file', message: 'feat: structured action' })
    assert.strictEqual(commit.body.ok, true)
    assert.strictEqual(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' }).trim(), 'feat: structured action')

    const createBranch = await callHttp(route.handler, { action: 'create-branch', sessionId: 'workbench-session', operationId: 'create-feature-branch', name: 'feat/action-api', base: 'main' })
    assert.strictEqual(createBranch.body.ok, true, JSON.stringify(createBranch.body))
    assert.strictEqual(createBranch.body.data.branch, 'feat/action-api')
    fs.writeFileSync(path.join(dir, 'feature-only.txt'), 'not merged\n')
    execFileSync('git', ['add', 'feature-only.txt'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feat: feature only'], { cwd: dir })

    const switchBranch = await callHttp(route.handler, { action: 'switch-branch', sessionId: 'workbench-session', operationId: 'switch-main', name: 'main' })
    assert.strictEqual(switchBranch.body.ok, true)
    assert.strictEqual(switchBranch.body.data.branch, 'main')

    const commits = await callHttp(route.handler, { action: 'get-commits', sessionId: 'workbench-session', limit: 20 })
    assert.strictEqual(commits.body.ok, true)
    assert.strictEqual(commits.body.data[0].subject, 'feat: structured action', '当前分支的最新提交应显示在顶部')
    assert.ok(commits.body.data[0].parents.length > 0, '提交记录应包含父提交，供前端绘制拓扑图')
    assert.ok(commits.body.data[0].refs.some((ref) => ref.name === 'main' && ref.type === 'branch' && ref.current), '当前分支应带有明确的当前分支引用')
    assert.ok(!commits.body.data.some((entry) => entry.subject === 'feat: feature only'), '当前分支历史不得混入其他分支的独立提交')
    assert.ok(!commits.body.data.some((entry) => entry.refs.some((ref) => ref.name === 'feat/action-api')), '提交记录不得显示其他本地分支标签')

    const commitHash = commits.body.data[0].hash
    const detail = await callHttp(route.handler, { action: 'get-commit-detail', sessionId: 'workbench-session', hash: commitHash })
    assert.strictEqual(detail.body.ok, true, JSON.stringify(detail.body))
    assert.strictEqual(detail.body.data.hash, commitHash)
    assert.strictEqual(detail.body.data.subject, 'feat: structured action')
    assert.strictEqual(detail.body.data.comparisonBase, detail.body.data.parents[0])
    assert.ok(detail.body.data.files.some((file) => file.path === 'work.txt' && file.status === 'A' && file.additions === 1))
    assert.ok(detail.body.data.totals.additions >= 1)

    const commitDiff = await callHttp(route.handler, { action: 'get-commit-diff', sessionId: 'workbench-session', hash: commitHash })
    assert.strictEqual(commitDiff.body.ok, true)
    assert.strictEqual(commitDiff.body.data.comparisonBase, detail.body.data.parents[0])
    assert.match(commitDiff.body.data.diff, /diff --git a\/work\.txt b\/work\.txt/)
    assert.match(commitDiff.body.data.diff, /^\+pending$/m)

    const rootHash = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    const rootDetail = await callHttp(route.handler, { action: 'get-commit-detail', sessionId: 'workbench-session', hash: rootHash })
    assert.strictEqual(rootDetail.body.ok, true)
    assert.strictEqual(rootDetail.body.data.comparisonBase, null)
    assert.ok(rootDetail.body.data.files.some((file) => file.path === 'a.txt' && file.status === 'A'))
    const rootDiff = await callHttp(route.handler, { action: 'get-commit-diff', sessionId: 'workbench-session', hash: rootHash })
    assert.strictEqual(rootDiff.body.ok, true)
    assert.strictEqual(rootDiff.body.data.comparisonBase, null)
    assert.match(rootDiff.body.data.diff, /diff --git a\/a\.txt b\/a\.txt/)

    const invalidCommit = await callHttp(route.handler, { action: 'get-commit-detail', sessionId: 'workbench-session', hash: 'HEAD' })
    assert.deepStrictEqual(invalidCommit.body, { ok: false, code: 'INVALID_ARGUMENT', message: '提交哈希必须是完整的 40 或 64 位十六进制字符' })
    const missingCommit = await callHttp(route.handler, { action: 'get-commit-detail', sessionId: 'workbench-session', hash: '0'.repeat(40) })
    assert.strictEqual(missingCommit.body.ok, false)
    assert.strictEqual(missingCommit.body.code, 'GIT_FAILED')

    execFileSync('git', ['branch', 'merged/delete-me'], { cwd: dir })
    const mergedDelete = await callHttp(route.handler, { action: 'delete-branch', sessionId: 'workbench-session', operationId: 'safe-delete-merged', name: 'merged/delete-me' })
    assert.strictEqual(mergedDelete.body.ok, true, '已合并分支应允许安全删除')

    const safeDelete = await callHttp(route.handler, { action: 'delete-branch', sessionId: 'workbench-session', operationId: 'safe-delete-feature', name: 'feat/action-api' })
    assert.strictEqual(safeDelete.body.ok, false)
    assert.strictEqual(safeDelete.body.code, 'STATE_CONFLICT')
    assert.strictEqual(safeDelete.body.reason, 'UNMERGED_BRANCH')

    const currentDelete = await callHttp(route.handler, { action: 'delete-branch', sessionId: 'workbench-session', operationId: 'delete-current-main', name: 'main' })
    assert.deepStrictEqual(currentDelete.body, {
      ok: false, code: 'STATE_CONFLICT', message: '当前分支不能删除，请先切换到其他分支', reason: 'CURRENT_BRANCH',
    })

    const unconfirmedForceDelete = await callHttp(route.handler, {
      action: 'delete-branch', sessionId: 'workbench-session', operationId: 'unconfirmed-force-delete-feature',
      name: 'feat/action-api', force: true, confirmRisk: false,
    })
    assert.deepStrictEqual(unconfirmedForceDelete.body, {
      ok: false, code: 'PERMISSION_DENIED', message: '强制删除前必须确认未合并提交可能永久丢失',
    })

    const forceDelete = await callHttp(route.handler, {
      action: 'delete-branch', sessionId: 'workbench-session', operationId: 'force-delete-feature',
      name: 'feat/action-api', force: true, confirmRisk: true,
    })
    assert.strictEqual(forceDelete.body.ok, true)
    assert.ok(!execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: dir, encoding: 'utf8' }).split('\n').includes('feat/action-api'))

    execFileSync('git', ['switch', '-q', '-c', 'feat/merge-detail'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'merge-detail.txt'), 'from feature\n')
    execFileSync('git', ['add', 'merge-detail.txt'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'feat: merge detail'], { cwd: dir })
    execFileSync('git', ['switch', '-q', 'main'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'main-detail.txt'), 'from main\n')
    execFileSync('git', ['add', 'main-detail.txt'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'chore: main detail'], { cwd: dir })
    const firstParent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge: detail test', 'feat/merge-detail'], { cwd: dir })
    const mergeHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    const mergeDetail = await callHttp(route.handler, { action: 'get-commit-detail', sessionId: 'workbench-session', hash: mergeHash })
    assert.strictEqual(mergeDetail.body.ok, true)
    assert.strictEqual(mergeDetail.body.data.parents.length, 2)
    assert.strictEqual(mergeDetail.body.data.comparisonBase, firstParent)
    assert.ok(mergeDetail.body.data.files.some((file) => file.path === 'merge-detail.txt'))
    assert.ok(!mergeDetail.body.data.files.some((file) => file.path === 'main-detail.txt'), '合并提交应只与第一父提交比较')
    const mergeDiff = await callHttp(route.handler, { action: 'get-commit-diff', sessionId: 'workbench-session', hash: mergeHash })
    assert.strictEqual(mergeDiff.body.ok, true)
    assert.strictEqual(mergeDiff.body.data.comparisonBase, firstParent)
    assert.match(mergeDiff.body.data.diff, /merge-detail\.txt/)

    forceUnstageFailure = true
    const failedUnstage = await callHttp(route.handler, { action: 'unstage-all', sessionId: 'workbench-session', operationId: 'failed-unstage-all' })
    assert.strictEqual(failedUnstage.body.ok, false)
    assert.strictEqual(failedUnstage.body.code, 'GIT_FAILED')
    assert.strictEqual(failedUnstage.body.message, '取消全部暂存失败')
    assert.strictEqual(failedUnstage.body.diagnostics, 'fatal: simulated unstage failure')
    assert.strictEqual(failedUnstage.body.recovery, undefined, '未知错误不得猜测修正命令')
    assert.strictEqual(failedUnstage.body.failure.command, 'git reset HEAD -- :/')
    assert.strictEqual(failedUnstage.body.failure.code, 'GIT_FAILED')
    assert.strictEqual(failedUnstage.body.failure.stderr, 'fatal: simulated unstage failure')
    assert.match(failedUnstage.body.failure.diagnostics, /--STATUS--/)
    const failedContext = latestPending('workbench-session')
    assert.strictEqual(failedContext.status, 'failed')
    assert.strictEqual(failedContext.failure.command, 'git reset HEAD -- :/')
    assert.strictEqual(failedContext.needsAgentAnalysis, true)
    assert.strictEqual(failedUnstage.body.analysis.proposalId, failedContext.proposalId)

    const analysisRequest = await callHttp(route.handler, {
      action: 'request-analysis', sessionId: 'workbench-session', proposalId: failedContext.proposalId,
    })
    assert.strictEqual(analysisRequest.body.ok, true)
    assert.ok(latestPending('workbench-session').analysisRequestedAt)

    const propose = registered.find((definition) => definition.name === 'git_propose')
    const repaired = await propose.execute({
      intent: '修复取消暂存失败',
      steps: ['git status', 'git reset HEAD -- :/'],
      explanation: '先确认当前冲突状态，再取消暂存，避免在不明状态下重试。',
    }, { agent: { id: 'workbench-session', session }, signal: new AbortController().signal })
    assert.strictEqual(repaired.ok, true)
    const analyzedProposal = latestPending('workbench-session')
    assert.strictEqual(analyzedProposal.status, 'pending')
    assert.deepStrictEqual(analyzedProposal.failure, failedUnstage.body.failure)
    assert.match(analyzedProposal.recoverySuggestion, /先确认当前冲突状态/)
  } finally { cleanup(dir) }
})

test('只读贮藏列表按最新顺序返回并保持仓库状态', async () => {
  const dir = createRepo()
  try {
    let route
    let stashListCommand = ''
    const baseShell = makeShell(dir)
    const shell = {
      resolve: baseShell.resolve,
      run: async (spec) => {
        if (spec.command.startsWith('git stash list ')) stashListCommand = spec.command
        return baseShell.run(spec)
      },
    }
    const session = { cwd: dir }
    plugin.apply({
      get: (key) => {
        if (key === 'shell') return shell
        if (key === 'tools') return { register() {} }
        if (key === 'agents') return { get: (id) => id === 'stash-session' ? { session } : undefined }
        return null
      },
      inject: (_deps, callback) => callback({ get: (key) => key === 'connection' ? { requestRejection: () => undefined } : { register: (definition) => { route = definition } } }),
    })

    const empty = await callHttp(route.handler, { action: 'get-stashes', sessionId: 'stash-session' })
    assert.deepStrictEqual(empty.body, { ok: true, data: [] })

    fs.writeFileSync(path.join(dir, 'a.txt'), 'first stash\n')
    execFileSync('git', ['stash', 'push', '-q', '-m', 'first snapshot'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'second stash\n')
    execFileSync('git', ['stash', 'push', '-q', '-m', 'second snapshot'], { cwd: dir })
    const before = execFileSync('git', ['status', '--porcelain=v1'], { cwd: dir, encoding: 'utf8' })

    const response = await callHttp(route.handler, { action: 'get-stashes', sessionId: 'stash-session' })
    assert.strictEqual(response.body.ok, true)
    assert.strictEqual(response.body.data.length, 2)
    assert.strictEqual(response.body.data[0].selector, 'stash@{0}')
    assert.match(response.body.data[0].subject, /second snapshot/)
    assert.strictEqual(response.body.data[1].selector, 'stash@{1}')
    assert.match(response.body.data[1].subject, /first snapshot/)
    assert.match(response.body.data[0].hash, /^[0-9a-f]{40,64}$/)
    assert.strictEqual(response.body.data[0].author, 'test')
    assert.match(response.body.data[0].date, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(stashListCommand, /--max-count=100/)
    assert.strictEqual(execFileSync('git', ['status', '--porcelain=v1'], { cwd: dir, encoding: 'utf8' }), before)

    const missingSession = await callHttp(route.handler, { action: 'get-stashes', sessionId: 'missing-session' })
    assert.deepStrictEqual(missingSession.body, { ok: false, code: 'SESSION_NOT_FOUND', message: '无法确定当前会话的仓库目录' })
  } finally { cleanup(dir) }
})
