'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

function loadClientPlugin() {
  let clientPlugin
  const react = { createElement: (...args) => ({ args }) }
  global.window = {
    __ModuleLoader__: {
      load(definition) {
        assert.strictEqual(definition.id, 'dsh-easygit-plugin')
        clientPlugin = definition.factory((name) => {
          assert.strictEqual(name, 'react')
          return react
        })
      },
    },
  }
  try {
    delete require.cache[require.resolve('../lib/client')]
    require('../lib/client')
  } finally {
    delete global.window
  }
  return clientPlugin
}

test('Client 注册原生右栏标签、工具栏入口并释放类型', async () => {
  const clientPlugin = loadClientPlugin()
  assert.deepStrictEqual(clientPlugin.inject, ['slots', 'timer', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'conversation'])
  const registrations = []
  const types = []
  const releases = []
  const opened = []
  const sent = []
  let released = false
  let closed = 0
  const services = {
    slots: {
      inject: (_name, callback) => callback(),
      register(definition, renderer) { registrations.push({ definition, renderer }); return () => {} },
    },
    timer: { interval: () => () => {}, timeout: () => () => {} },
    sidebarRightTabs: { register(definition) { types.push(definition); return () => { released = true } } },
    sidebarRight: { openTabIn: (...args) => opened.push(args) },
    sessions: { scope: (id) => ({ conversation: { send: async (text) => { sent.push([id, text]) } } }) },
  }
  clientPlugin.apply({ get: (key) => services[key], effect: (callback) => { releases.push(callback()) } })
  assert.strictEqual(types[0].id, 'dsh-easygit-plugin')
  assert.strictEqual(types[0].kind, 'easygit')
  assert.strictEqual(types[0].title(), 'Git 工作台')
  const body = registrations.find(({ definition }) => definition.name === 'sidebar.right.pane.tab')
  assert.strictEqual(body.definition.key, types[0].id)
  assert.ok(!registrations.some(({ definition }) => definition.name === 'details'))
  const toolbar = registrations.find(({ definition }) => definition.name === 'conversation.input.left')
  const action = toolbar.renderer({ sessionId: 'session-a' })
  action.args[1].openWorkbench('session-a')
  action.args[1].openWorkbench('session-b')
  assert.deepStrictEqual(opened, [['session-a', 'easygit'], ['session-b', 'easygit']])
  assert.throws(() => action.args[1].openWorkbench(''), /当前会话不可用/)
  const tab = { visible: true, actions: { close: () => { closed += 1 } } }
  const panel = body.renderer({ sessionId: 'session-b', useTabInfo: () => ({ tab }) })
  assert.strictEqual(panel.args[1].sessionId, 'session-b')
  panel.args[1].close()
  assert.strictEqual(closed, 1)
  await panel.args[1].sendPrompt('分析 Git 失败')
  assert.deepStrictEqual(sent, [['session-b', '分析 Git 失败']])
  tab.visible = false
  assert.strictEqual(body.renderer({ sessionId: 'session-b', useTabInfo: () => ({ tab }) }), null)
  for (const release of releases) if (typeof release === 'function') release()
  assert.strictEqual(released, true)
})

test('Agent 分析通过指定会话发送并传播会话缺失及业务错误', async () => {
  const { requestAgentAnalysis } = loadClientPlugin().__testing
  await assert.rejects(requestAgentAnalysis({ scope: () => undefined }, 'missing', '分析'), /当前会话不可用/)
  await assert.rejects(requestAgentAnalysis({ scope: () => ({ conversation: { send: async () => { throw new Error('admission denied') } } }) }, 'session-a', '分析'), /admission denied/)
})

test('变更文件按目录树归类，并保留根目录文件', () => {
  const clientPlugin = loadClientPlugin()
  const tree = clientPlugin.__testing.buildFileTree([
    { path: 'src/client/index.ts' },
    { path: 'src/host/index.ts' },
    { path: 'README.md' },
  ])

  assert.deepStrictEqual(tree.files.map((file) => file.path), ['README.md'])
  assert.deepStrictEqual(tree.folders.map((folder) => folder.name), ['src'])
  assert.deepStrictEqual(tree.folders[0].folders.map((folder) => folder.name), ['client', 'host'])
  assert.strictEqual(tree.folders[0].folders[0].files[0].path, 'src/client/index.ts')
})

test('未跟踪目录路径本身也会渲染为可展开文件夹', () => {
  const clientPlugin = loadClientPlugin()
  const tree = clientPlugin.__testing.buildFileTree([{ path: '__pycache__/' }])

  assert.deepStrictEqual(tree.files, [])
  assert.deepStrictEqual(tree.folders.map((folder) => folder.name), ['__pycache__'])
  assert.deepStrictEqual(tree.folders[0].files, [])
})

test('文件审阅行保留双行号、修改内容和被省略的上下文', () => {
  const clientPlugin = loadClientPlugin()
  const rows = clientPlugin.__testing.parseReviewRows([
    'diff --git a/demo.txt b/demo.txt',
    '@@ -2,3 +2,4 @@',
    ' keep',
    '-old value',
    '+new value',
    '+inserted value',
    ' tail',
    '@@ -10,2 +11,2 @@',
    ' later',
    '-before',
    '+after',
  ].join('\n'))

  assert.deepStrictEqual(rows[0], { kind: 'skipped', oldNumber: null, newNumber: null, text: '1 行未修改内容（由 Git 省略）' })
  assert.deepStrictEqual(rows.slice(1, 6), [
    { kind: 'context', oldNumber: 2, newNumber: 2, text: 'keep' },
    { kind: 'deleted', oldNumber: 3, newNumber: null, text: 'old value' },
    { kind: 'added', oldNumber: null, newNumber: 3, text: 'new value' },
    { kind: 'added', oldNumber: null, newNumber: 4, text: 'inserted value' },
    { kind: 'context', oldNumber: 4, newNumber: 5, text: 'tail' },
  ])
  assert.deepStrictEqual(rows[6], { kind: 'skipped', oldNumber: null, newNumber: null, text: '5 行未修改内容（由 Git 省略）' })
  assert.ok(rows.some((row) => row.kind === 'deleted' && row.text === 'before'))
  assert.ok(rows.some((row) => row.kind === 'added' && row.text === 'after'))
})

test('文件审阅在纯删除块之后正确计算省略的未修改行', () => {
  const clientPlugin = loadClientPlugin()
  const rows = clientPlugin.__testing.parseReviewRows([
    '@@ -10 +10,0 @@',
    '-removed',
    '@@ -20 +19 @@',
    '-before',
    '+after',
  ].join('\n'))

  assert.deepStrictEqual(rows[2], { kind: 'skipped', oldNumber: null, newNumber: null, text: '9 行未修改内容（由 Git 省略）' })
})

test('Diff 的审阅与原始视图共享完整滚动宽度', () => {
  const clientPlugin = loadClientPlugin()
  const raw = clientPlugin.__testing.renderRawDiffSurface([
    '@@ -1,2 +1,2 @@',
    '-short',
    '+a very long replacement line that determines the horizontal scroll width',
  ].join('\n'))
  const review = clientPlugin.__testing.renderReviewSurface([
    '@@ -1,2 +1,2 @@',
    '-short',
    '+a very long replacement line that determines the horizontal scroll width',
  ].join('\n'))

  assert.strictEqual(raw.args[0], 'code')
  assert.strictEqual(raw.args[1].className, 'gg-diff-content')
  assert.strictEqual(review.args[0], 'div')
  assert.strictEqual(review.args[1].className, 'gg-review-content')

  let styleTag
  global.document = {
    getElementById: () => null,
    createElement: () => { styleTag = { textContent: '', remove() {} }; return styleTag },
    head: { appendChild() {} },
  }
  try {
    clientPlugin.__testing.injectStyles()
  } finally {
    delete global.document
  }
  assert.match(styleTag.textContent, /\.gg-review-content, \.gg-diff-content \{[^}]*width: max-content;[^}]*min-width: 100%; \}/)
  assert.match(styleTag.textContent, /\.gg-review-line \{[^}]*width: 100%;/)
  assert.match(styleTag.textContent, /\.gg-diff-code span \{[^}]*width: 100%;/)
})

test('Git 工作台入口使用 DSH 风格的无边框悬停反馈', () => {
  const clientPlugin = loadClientPlugin()
  let styleTag
  global.document = {
    getElementById: () => null,
    createElement: () => { styleTag = { textContent: '', remove() {} }; return styleTag },
    head: { appendChild() {} },
  }
  try {
    clientPlugin.__testing.injectStyles()
  } finally {
    delete global.document
  }

  assert.match(styleTag.textContent, /\.gg-workbench-action \{[^}]*height: 28px;[^}]*border: 0;[^}]*background: transparent;/)
  assert.match(styleTag.textContent, /\.gg-workbench-action:hover:not\(:disabled\) \{[^}]*box-shadow: var\(--dsw-shadow-lv1/)
  assert.match(styleTag.textContent, /\.gg-workbench-action\[aria-pressed="true"\] \{[^}]*border: 0;[^}]*button-ghost-active-fill/)
})

test('工作台标题线、命令日志高度和变更页双栏边界使用修正后的布局', () => {
  const clientPlugin = loadClientPlugin()
  let styleTag
  global.document = {
    getElementById: () => null,
    createElement: () => { styleTag = { textContent: '', remove() {} }; return styleTag },
    head: { appendChild() {} },
  }
  try {
    clientPlugin.__testing.injectStyles()
  } finally {
    delete global.document
  }

  assert.match(styleTag.textContent, /\.gg-workbench-head \{[^}]*min-height: 75px;/)
  assert.match(styleTag.textContent, /\.gg-command-log \{[^}]*min-height: 110px;[^}]*max-height: 210px;/)
  assert.match(styleTag.textContent, /\.gg-diff \{[^}]*box-sizing: border-box;/)
  assert.doesNotMatch(styleTag.textContent, /\.gg-diff \{ min-height: 100%; \}/)
})

test('工作台使用原生容器宽高，不修改宿主列布局或隐藏其他面板', () => {
  const clientPlugin = loadClientPlugin()
  let styleTag
  global.document = {
    getElementById: () => null,
    createElement: () => { styleTag = { textContent: '', remove() {} }; return styleTag },
    head: { appendChild() {} },
  }
  try { clientPlugin.__testing.injectStyles() } finally { delete global.document }
  assert.match(styleTag.textContent, /\.gg-workbench \{[^}]*position: relative;[^}]*width: 100%; height: 100%;/)
  assert.doesNotMatch(styleTag.textContent, /data-easygit-workbench|data-side=|gg-workbench-resize/)
})

test('本地分支搜索忽略大小写和首尾空格', () => {
  const clientPlugin = loadClientPlugin()
  const filter = clientPlugin.__testing.filterLocalBranches
  const branches = [
    { name: 'main', current: true },
    { name: 'feature/Login', upstream: 'origin/feature/Login' },
    { name: 'fix/search', upstream: 'origin/fix/search' },
  ]

  assert.strictEqual(filter(branches, ''), branches)
  assert.deepStrictEqual(filter(branches, '  FEATURE  ').map((branch) => branch.name), ['feature/Login'])
  assert.deepStrictEqual(filter(branches, 'search').map((branch) => branch.name), ['fix/search'])
  assert.deepStrictEqual(filter(branches, 'origin').map((branch) => branch.name), [])
})

test('提交详情只接受当前选择的最新请求', () => {
  const clientPlugin = loadClientPlugin()
  const current = clientPlugin.__testing.isCurrentCommitRequest

  assert.strictEqual(current('abc', 'abc', 3, 3), true)
  assert.strictEqual(current('def', 'abc', 3, 3), false)
  assert.strictEqual(current('abc', 'abc', 4, 3), false)
})

test('重复选择当前提交会收起详情', () => {
  const clientPlugin = loadClientPlugin()
  const next = clientPlugin.__testing.nextCommitSelection

  assert.strictEqual(next('', 'abc'), 'abc')
  assert.strictEqual(next('abc', 'def'), 'def')
  assert.strictEqual(next('abc', 'abc'), '')
})

test('提交文件状态映射为增加、删除和修改颜色', () => {
  const clientPlugin = loadClientPlugin()
  const tone = clientPlugin.__testing.commitFileTone

  assert.strictEqual(tone('A'), ' added')
  assert.strictEqual(tone('C100'), ' added')
  assert.strictEqual(tone('D'), ' deleted')
  assert.strictEqual(tone('M'), ' modified')
  assert.strictEqual(tone('R100'), ' modified')
})

test('贮藏列表只接受最新的刷新请求', () => {
  const clientPlugin = loadClientPlugin()
  const latest = clientPlugin.__testing.isLatestRequest

  assert.strictEqual(latest(3, 3), true)
  assert.strictEqual(latest(4, 3), false)
})

test('新只读请求会取消前一个请求，显式取消后拒绝其响应', () => {
  const clientPlugin = loadClientPlugin()
  const { beginTrackedRequest, cancelTrackedRequest, isTrackedRequestCurrent } = clientPlugin.__testing
  const ref = { current: { controller: null, sequence: 0 } }
  const first = beginTrackedRequest(ref)
  assert.strictEqual(isTrackedRequestCurrent(ref, first), true)

  const second = beginTrackedRequest(ref)
  assert.strictEqual(first.signal.aborted, true)
  assert.strictEqual(isTrackedRequestCurrent(ref, first), false)
  assert.strictEqual(isTrackedRequestCurrent(ref, second), true)

  cancelTrackedRequest(ref)
  assert.strictEqual(second.signal.aborted, true)
  assert.strictEqual(isTrackedRequestCurrent(ref, second), false)
})

test('提交图正确表达分叉、合并和根提交', () => {
  const clientPlugin = loadClientPlugin()
  const rows = clientPlugin.__testing.deriveCommitGraph([
    { hash: 'A', parents: ['B', 'C'] },
    { hash: 'B', parents: ['D'] },
    { hash: 'C', parents: ['D'] },
    { hash: 'D', parents: [] },
  ])

  assert.strictEqual(rows[0].lane, 0)
  assert.deepStrictEqual(rows[0].edges, [
    { from: 0, to: 0, active: true },
    { from: 0, to: 1, active: true },
  ])
  assert.strictEqual(rows[2].lane, 1)
  assert.ok(rows[2].edges.some((edge) => edge.from === 1 && edge.to === 0 && edge.active))
  assert.deepStrictEqual(rows[3].edges, [{ from: 0, to: null, active: true }])
})

test('仓库顶层目录可以转换为项目名称', () => {
  const clientPlugin = loadClientPlugin()
  const name = clientPlugin.__testing.repositoryName

  assert.strictEqual(name('/home/user/code/FastAPI/'), 'FastAPI')
  assert.strictEqual(name('C:\\code\\demo'), 'demo')
  assert.strictEqual(name(''), 'Git 仓库')
})

test('修改操作转换为命令日志中的真实 Git 命令', () => {
  const clientPlugin = loadClientPlugin()
  const command = clientPlugin.__testing.mutationCommand

  assert.deepStrictEqual(command('stage-paths', { paths: ['src/a file.ts'] }), {
    label: '暂存文件', command: "git add -- 'src/a file.ts'",
  })
  assert.deepStrictEqual(command('create-branch', { name: 'feature/x', base: 'main' }), {
    label: '新建分支', command: "git switch -c 'feature/x' 'main'",
  })
  assert.deepStrictEqual(command('delete-branch', { name: 'feature/x', force: true }), {
    label: '强制删除分支', command: "git branch -D -- 'feature/x'",
  })
  assert.deepStrictEqual(command('pull'), { label: '安全拉取', command: 'git pull --ff-only' })
  assert.deepStrictEqual(command('push', { remote: 'origin', branch: 'main', setUpstream: true }), {
    label: '推送并建立上游', command: "git push -u 'origin' 'main'",
  })
  assert.deepStrictEqual(command('rebase', { target: 'origin/main' }), {
    label: '变基', command: "git rebase 'origin/main'",
  })
  assert.deepStrictEqual(command('rebase-continue'), {
    label: '继续变基', command: 'git -c core.editor=true rebase --continue',
  })
  assert.strictEqual(command('get-summary'), null)
})

test('仅已登记的修正提议会触发建议页跳转', () => {
  const clientPlugin = loadClientPlugin()
  const proposalId = clientPlugin.__testing.recoveryProposalId
  const openRecovery = clientPlugin.__testing.openRecoveryProposal
  let opened = 0

  assert.strictEqual(proposalId({ ok: false, recovery: { proposalId: 'g-recovery' } }), 'g-recovery')
  assert.strictEqual(openRecovery({ ok: false, recovery: { proposalId: 'g-recovery' } }, () => { opened += 1 }), true)
  assert.strictEqual(openRecovery({ ok: false, recovery: { proposalId: null } }, () => { opened += 1 }), false)
  assert.strictEqual(openRecovery({ ok: false, diagnostics: 'unknown error' }, () => { opened += 1 }), false)
  assert.strictEqual(opened, 1)

  let delayedOpen
  let delayedBy = 0
  assert.strictEqual(openRecovery(
    { ok: false, recovery: { proposalId: 'g-delayed' } },
    () => { opened += 1 },
    (callback, delayMs) => { delayedOpen = callback; delayedBy = delayMs },
  ), true)
  assert.strictEqual(opened, 1, '简单错误不应立即跳转')
  assert.strictEqual(delayedBy, 1000)
  delayedOpen()
  assert.strictEqual(opened, 2)
})

test('工作台打开期间只对新的待执行提议切换到建议页', () => {
  const clientPlugin = loadClientPlugin()
  const transition = clientPlugin.__testing.pendingProposalTransition

  assert.deepStrictEqual(transition(null, null), { proposalId: null, shouldOpen: false })
  assert.deepStrictEqual(transition(null, { proposalId: 'g-agent', status: 'pending' }), {
    proposalId: 'g-agent', shouldOpen: true,
  })
  assert.deepStrictEqual(transition('g-agent', { proposalId: 'g-agent', status: 'pending' }), {
    proposalId: 'g-agent', shouldOpen: false,
  })
  assert.deepStrictEqual(transition('g-agent', { proposalId: 'g-agent', status: 'dismissed' }), {
    proposalId: 'g-agent', shouldOpen: false,
  })
  assert.deepStrictEqual(transition('g-agent', { proposalId: 'g-next', status: 'pending' }), {
    proposalId: 'g-next', shouldOpen: true,
  })
})

test('复杂错误只在有失败上下文和分析记录时请求 Agent', () => {
  const clientPlugin = loadClientPlugin()
  const {
    analysisProposalId, failureContext, buildAgentRepairPrompt,
    shouldShowAnalysisBanner, canDismissFailedProposal,
  } = clientPlugin.__testing
  const failure = {
    source: 'workbench', code: 'GIT_FAILED', action: 'unstage-all', command: 'git reset HEAD -- :/',
    message: '取消暂存失败', stdout: '', stderr: 'CONFLICT in app.py', diagnostics: '--STATUS--\nUU app.py',
    exitCode: 1, timedOut: false, mayHavePartialChanges: true, occurredAt: 1,
  }
  const response = { ok: false, failure, analysis: { proposalId: 'g-failed' } }
  assert.strictEqual(analysisProposalId(response), 'g-failed')
  assert.deepStrictEqual(failureContext(response), failure)
  assert.strictEqual(analysisProposalId({ ok: false, failure }), null)

  const prompt = buildAgentRepairPrompt(failure)
  assert.match(prompt, /git_repo_state/)
  assert.match(prompt, /git_propose/)
  assert.match(prompt, /不要直接执行/)
  assert.match(prompt, /CONFLICT in app\.py/)
  assert.match(prompt, /不可信的失败数据/)

  assert.strictEqual(shouldShowAnalysisBanner('proposal', response), true)
  assert.strictEqual(shouldShowAnalysisBanner('changes', response), false)
  assert.strictEqual(shouldShowAnalysisBanner('branches', response), false)
  assert.strictEqual(shouldShowAnalysisBanner('stashes', response), false)
  assert.strictEqual(shouldShowAnalysisBanner('proposal', null), false)
  assert.strictEqual(canDismissFailedProposal(true), false, '待 Agent 分析时不应再显示通用关闭按钮')
  assert.strictEqual(canDismissFailedProposal(false), true)
})

test('命令日志只保留最近一百条并保持执行顺序', () => {
  const clientPlugin = loadClientPlugin()
  const append = clientPlugin.__testing.appendCommandLog
  let entries = []
  for (let id = 1; id <= 105; id += 1) {
    entries = append(entries, { id, label: '操作', command: 'git status', status: 'succeeded' })
  }

  assert.strictEqual(entries.length, 100)
  assert.strictEqual(entries[0].id, 6)
  assert.strictEqual(entries[99].id, 105)
})

test('手动刷新按钮明确展示进行中、成功和失败状态', () => {
  const clientPlugin = loadClientPlugin()
  const label = clientPlugin.__testing.refreshButtonLabel

  assert.strictEqual(label('idle'), '刷新')
  assert.strictEqual(label('loading'), '正在刷新…')
  assert.strictEqual(label('succeeded'), '已刷新')
  assert.strictEqual(label('failed'), '刷新失败')
})
