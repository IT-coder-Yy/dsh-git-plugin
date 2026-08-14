'use strict'
/**
 * 集成测试：在真实临时 git 仓库里跑插件的核心流程
 * （步骤执行 / 预期结果校验 / 部分执行检测 / 指纹变化），
 * 通过 child_process 提供 shell 适配器代替 harness 的 ctx.get('shell')。
 * 运行：node --test test/
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { helpers } = require('../src/host')
const { makeShell, createRepo, cleanup } = require('./helpers')

const { deriveChecks, runChecks, executeProposalSteps, captureFingerprint, storeProposal, findProposal, proposalView, latestPending } = helpers

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
    execFileSync('git', ['add', '-f', 'b.txt'], { cwd: dir }) // 模拟用户只执行了第一步

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
    // 第二步 commit 一个不存在的文件会失败
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
  const mk = (id, seq) => ({ proposalId: id, sessionId: 's1', closed: false, createdAt: seq, steps: [{ command: 'git status', result: null }] })
  storeProposal('s1', mk('p1', 1))
  storeProposal('s1', mk('p2', 2))
  assert.strictEqual(findProposal('s1', 'p1').proposalId, 'p1')
  const p2 = findProposal('s1', 'p2')
  const view = proposalView(p2)
  assert.strictEqual(view.proposalId, 'p2')
  assert.strictEqual(view.steps.length, 1)
  assert.strictEqual(latestPending('s1').proposalId, 'p2')

  // 模拟 git_propose 顶替：新提议把旧的 pending 全部标记 closed
  const prev = [{ proposalId: 'p1', closed: false }, { proposalId: 'p2', closed: false }]
  for (const pp of prev) pp.closed = true
  storeProposal('s1', mk('p3', 3))
  assert.strictEqual(latestPending('s1').proposalId, 'p3')
})
