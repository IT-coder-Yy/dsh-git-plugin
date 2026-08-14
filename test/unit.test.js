'use strict'
/**
 * 单元测试：src/host.js 导出的纯逻辑（命令校验 / 风险分级 / 预期结果推导等）。
 * 运行：node --test test/
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { helpers } = require('../src/host')

const { splitSegments, validateCommand, classifyRisk, addPathsOf, deriveChecks } = helpers

test('splitSegments 正确处理引号内的 && 和 ;', () => {
  const r = splitSegments('git commit -m "a && b; c" && git push')
  assert.deepStrictEqual(r.segments, ['git commit -m "a && b; c"', 'git push'])
})

test('splitSegments 拆分换行与分号', () => {
  const r = splitSegments('git add -A; git commit -m x\ngit push')
  assert.deepStrictEqual(r.segments, ['git add -A', 'git commit -m x', 'git push'])
})

test('validateCommand 拒绝非 git 命令', () => {
  assert.strictEqual(validateCommand('rm -rf /').ok, false)
  assert.strictEqual(validateCommand('cd /tmp && git status').ok, false)
  assert.strictEqual(validateCommand('npm test && git push').ok, false)
})

test('validateCommand 拒绝管道 / 重定向 / shell 展开', () => {
  assert.strictEqual(validateCommand('git log | head -5').ok, false)
  assert.strictEqual(validateCommand('git log > /tmp/x').ok, false)
  assert.strictEqual(validateCommand('git commit -m "$(whoami)"').ok, false)
  assert.strictEqual(validateCommand('git commit -m "`date`"').ok, false)
  assert.strictEqual(validateCommand('git commit -m "${HOME}"').ok, false)
})

test('validateCommand 接受纯 git 链并拆段', () => {
  const r = validateCommand('git add -A && git commit -m "feat: x"')
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.segments, ['git add -A', 'git commit -m "feat: x"'])
})

test('classifyRisk 高风险命令', () => {
  assert.strictEqual(classifyRisk('git reset --hard HEAD~1').level, 'hard')
  assert.strictEqual(classifyRisk('git push --force origin main').level, 'hard')
  assert.strictEqual(classifyRisk('git push -f origin main').level, 'hard')
  assert.strictEqual(classifyRisk('git rebase -i HEAD~3').level, 'hard')
  assert.strictEqual(classifyRisk('git clean -fd').level, 'hard')
  assert.strictEqual(classifyRisk('git branch -D old').level, 'hard')
  assert.strictEqual(classifyRisk('git checkout -- .').level, 'hard')
  assert.strictEqual(classifyRisk('git restore .').level, 'hard')
  assert.strictEqual(classifyRisk('git stash clear').level, 'hard')
})

test('classifyRisk 常规与安全', () => {
  assert.strictEqual(classifyRisk('git status').level, 'safe')
  assert.strictEqual(classifyRisk('git log --oneline -5').level, 'safe')
  assert.strictEqual(classifyRisk('git diff HEAD').level, 'safe')
  assert.strictEqual(classifyRisk('git add -A && git commit -m "x"').level, 'normal')
  assert.strictEqual(classifyRisk('git push origin main').level, 'normal')
  assert.strictEqual(classifyRisk('git checkout -b feat/x').level, 'normal')
  assert.strictEqual(classifyRisk('git restore --staged a.txt').level, 'normal')
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

  checks = deriveChecks(['git branch -D old'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['branch-gone'])

  checks = deriveChecks(['git stash push'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['stash-nonempty'])

  checks = deriveChecks(['git push origin main'])
  assert.deepStrictEqual(checks.map((c) => c.type), ['no-ahead'])
})
