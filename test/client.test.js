'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

function loadClientPlugin(reactOverrides = {}) {
  let clientPlugin
  const react = { createElement: (...args) => ({ args }), ...reactOverrides }
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

test('逐块选择保留 CRLF、非冲突内容、diff3 基础段及文件末尾', () => {
  const { parseConflictBlocks, chooseConflictBlock } = loadClientPlugin().__testing
  const text = 'before\r\n<<<<<<< HEAD\r\nours\r\n||||||| base\r\nbase\r\n=======\r\ntheirs\r\n>>>>>>> other\r\nafter'
  const [block] = parseConflictBlocks(text)
  assert.strictEqual(block.base, 'base\r\n')
  assert.strictEqual(chooseConflictBlock(text, block, 'ours'), 'before\r\nours\r\nafter')
  assert.strictEqual(chooseConflictBlock(text, block, 'theirs'), 'before\r\ntheirs\r\nafter')
  assert.strictEqual(chooseConflictBlock(text, block, 'both'), 'before\r\nours\r\ntheirs\r\nafter')
  assert.deepStrictEqual(parseConflictBlocks('<<<<<<< HEAD\nincomplete'), [])
  const custom = '<<<<<<<<<< HEAD\na\n==========\nb\n>>>>>>>>>> other'
  assert.strictEqual(parseConflictBlocks(custom, 10).length, 1)
  assert.strictEqual(parseConflictBlocks(custom).length, 0)
  const multiple = custom + '\n' + custom
  const remaining = chooseConflictBlock(multiple, parseConflictBlocks(multiple, 10)[0], 'theirs')
  assert.strictEqual(parseConflictBlocks(remaining, 10).length, 1)
})

test('冲突行范围包含标记，兼容 CRLF、多块、空行及缺失末尾换行', () => {
  const { parseConflictBlocks, conflictLineRanges, chooseConflictBlock } = loadClientPlugin().__testing
  const block = '<<<<<<< HEAD\r\nours\r\n||||||| base\r\nbase\r\n=======\r\n\r\n>>>>>>> other'
  const text = 'before\r\n' + block + '\r\nbetween\r\n' + block
  assert.deepStrictEqual(conflictLineRanges(text, parseConflictBlocks(text)), [{ start: 2, end: 8 }, { start: 10, end: 16 }])
  const resolved = chooseConflictBlock(text, parseConflictBlocks(text)[0], 'ours')
  assert.deepStrictEqual(conflictLineRanges(resolved, parseConflictBlocks(resolved)), [{ start: 4, end: 10 }])
  assert.deepStrictEqual(conflictLineRanges('', parseConflictBlocks('')), [])
})

test('三方冲突界面显示来源和行号，按块选择、保存后才标记解决', async () => {
  const slots = []
  let cursor = 0
  const pending = []
  let tree
  const component = loadClientPlugin({
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        pending.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() } })
      }
    },
  }).__testing.GitConflictsTab
  const original = 'before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> incoming\nafter\n'
  const version = text => ({ exists: true, text, mode: '100644', reason: null })
  const detail = { path: 'a.txt', operation: 'merge', token: 'initial', base: version('base\n'), ours: version('ours\n'), theirs: version('theirs\n'), result: version(original), editable: true, special: false, markerSize: 7 }
  detail.ours.source = 'HEAD · 0123456789ab'
  detail.theirs.source = 'MERGE_HEAD · abcdef012345'
  const state = { operation: 'merge', operationToken: 'op', files: [{ path: 'a.txt', kind: '双方修改', stages: [1, 2, 3] }] }
  const requests = []
  let dirty = false
  const props = {
    sessionId: 'ui-conflict-test', revision: 0, onChanged() {}, onDirty(value) { dirty = value }, onCommand() { return () => {} },
    async rpc(request) {
      requests.push(request)
      if (request.action === 'get-conflicts') return { ok: true, data: state }
      if (request.action === 'get-conflict') return { ok: true, data: detail }
      if (request.action === 'save-conflict') return { ok: true, data: { ...detail, token: 'saved', result: version(request.content) } }
      if (request.action === 'resolve-conflict') return { ok: true, data: { ...state, files: [] } }
      throw new Error('Unexpected ' + request.action)
    },
  }
  const render = async () => {
    cursor = 0; tree = component(props)
    while (pending.length) pending.shift()()
    await new Promise(resolve => setImmediate(resolve))
  }
  const nodes = value => !value ? [] : Array.isArray(value) ? value.flatMap(nodes) : value.args ? [value, ...value.args.slice(2).flatMap(nodes)] : []
  const button = caption => nodes(tree).find(node => node.args[0] === 'button' && node.args[2] === caption)
  global.window = { addEventListener() {}, removeEventListener() {}, confirm: () => true }
  try {
    await render(); await render()
    button('a.txt · 双方修改').args[1].onClick()
    await render(); await render()
    assert.equal(nodes(tree).filter(node => node.args[1]?.className === 'gg-conflict-version').length, 3)
    assert.ok(!nodes(tree).some(node => node.args[0] === 'strong' && node.args[2] === '基础版本'))
    assert.ok(nodes(tree).some(node => node.args[2] === detail.theirs.source))
    assert.ok(nodes(tree).some(node => node.args[2] === '冲突块 1 · 结果第 2–6 行（5 行，含冲突标记）'))
    const gutter = () => nodes(tree).find(node => node.args[1]?.className === 'gg-conflict-gutter')
    const lineNumbers = () => nodes(gutter()).filter(node => node.args[0] === 'span')
    assert.deepStrictEqual(lineNumbers().map(node => node.args[2]), [1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(lineNumbers().filter(node => node.args[1].className.includes('unresolved')).length, 5)
    const editor = nodes(tree).find(node => node.args[0] === 'textarea')
    assert.equal(editor.args[1].wrap, 'off')
    gutter().args[1].ref.current = { scrollTop: 0 }
    editor.args[1].onScroll({ currentTarget: { scrollTop: 120 } })
    assert.equal(gutter().args[1].ref.current.scrollTop, 120)
    assert.equal(button('标记解决').args[1].disabled, true)
    button('采用当前方').args[1].onClick()
    await render(); await render()
    assert.equal(dirty, true)
    assert.deepStrictEqual(lineNumbers().map(node => node.args[2]), [1, 2, 3, 4])
    assert.equal(lineNumbers().filter(node => node.args[1].className.includes('unresolved')).length, 0)
    assert.equal(button('标记解决').args[1].disabled, true)
    button('保存结果').args[1].onClick()
    await render(); await render()
    assert.equal(dirty, false)
    const saved = requests.find(request => request.action === 'save-conflict')
    assert.equal(saved.content, 'before\nours\nafter\n')
    assert.equal(saved.token, 'initial')
    assert.equal(button('标记解决').args[1].disabled, false)
    button('标记解决').args[1].onClick()
    await render(); await render()
    const resolved = requests.find(request => request.action === 'resolve-conflict')
    assert.equal(resolved.token, 'saved')
    assert.equal(resolved.choice, 'result')
    assert.equal(button('继续 Merge').args[1].disabled, true, '继续操作还需要明确风险确认')
  } finally {
    for (const slot of slots) slot?.cleanup?.()
    delete global.window
  }
})

function stashHarness(rpc, componentName = 'GitStashesTab') {
  const slots = []
  let cursor = 0
  let tree
  const pending = []
  const component = loadClientPlugin({
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        pending.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() } })
      }
    },
  }).__testing[componentName]
  const requests = []
  const props = {
    sessionId: 'stash-ui', revision: 0, onChanged() {}, onConflicts() {}, onCommand: () => () => {},
    renderReview: diff => 'review:' + diff, renderRawDiff: diff => 'raw:' + diff,
    rpc(request, signal) { requests.push(request); return rpc(request, signal) },
  }
  const nodes = value => !value ? [] : Array.isArray(value) ? value.flatMap(nodes) : value.args ? [value, ...value.args.slice(2).flatMap(nodes)] : []
  return {
    requests, props,
    async render() {
      cursor = 0; tree = component(props)
      while (pending.length) pending.shift()()
      await new Promise(resolve => setImmediate(resolve))
    },
    nodes: () => nodes(tree),
    button: label => nodes(tree).find(node => node.args[0] === 'button' && node.args[2] === label),
    cleanup() { slots.forEach(slot => slot?.cleanup?.()) },
  }
}

test('贮藏表单传递说明、精确文件选择及未跟踪选项，空选择不能提交', async () => {
  const files = [{ path: 'a.txt', indexStatus: ' ', workTreeStatus: 'M' }, { path: 'new.txt', indexStatus: '?', workTreeStatus: '?' }]
  const ui = stashHarness(async request => {
    if (request.action === 'get-stashes') return { ok: true, data: [] }
    if (request.action === 'get-summary') return { ok: true, data: { files } }
    if (request.action === 'create-stash') return { ok: true, data: { files: [] } }
    throw Error(request.action)
  })
  await ui.render(); await ui.render()
  const input = label => ui.nodes().find(node => node.args[1]?.['aria-label'] === label)
  input('贮藏说明').args[1].onChange({ target: { value: '我的说明' } })
  const include = ui.nodes().find(node => node.args[0] === 'input' && node.args[1]?.type === 'checkbox')
  include.args[1].onChange({ target: { checked: true } })
  await ui.render()
  ui.button('清空选择').args[1].onClick()
  await ui.render()
  assert.equal(ui.button('创建贮藏').args[1].disabled, true)
  const newFileLabel = ui.nodes().find(node => node.args[0] === 'label' && node.args[4]?.args?.[2] === 'new.txt')
  newFileLabel.args[2].args[1].onChange()
  await ui.render()
  ui.button('创建贮藏').args[1].onClick()
  // A second click before React renders must not send another mutation.
  ui.button('创建贮藏').args[1].onClick()
  await ui.render(); await ui.render()
  const mutations = ui.requests.filter(request => request.action === 'create-stash')
  assert.equal(mutations.length, 1)
  assert.deepStrictEqual(mutations[0].paths, ['new.txt'])
  assert.equal(mutations[0].includeUntracked, true)
  assert.equal(mutations[0].message, '我的说明')
  assert.ok(mutations[0].operationId)
  ui.cleanup()
})

test('贮藏详情支持文件审阅和原始 Diff，删除需确认且携带当前哈希', async () => {
  const stash = { selector: 'stash@{0}', hash: 'a'.repeat(40), subject: 'snapshot', author: 'test', date: 'today' }
  const file = { path: 'new.txt', status: 'A', untracked: true }
  const ui = stashHarness(async request => {
    if (request.action === 'get-stashes') return { ok: true, data: [stash] }
    if (request.action === 'get-summary') return { ok: true, data: { files: [] } }
    if (request.action === 'get-stash-detail') return { ok: true, data: { hash: stash.hash, files: [file] } }
    if (request.action === 'get-stash-diff') return { ok: true, data: { diff: '@@ -0,0 +1 @@\n+new', truncated: true } }
    if (request.action === 'drop-stash') return { ok: true, data: {} }
    throw Error(request.action)
  })
  await ui.render(); await ui.render()
  ui.nodes().find(node => node.args[1]?.className?.includes('gg-stash-select')).args[1].onClick()
  await ui.render(); await ui.render()
  assert.ok(ui.nodes().some(node => node.args[2] === 'review:@@ -0,0 +1 @@\n+new'))
  assert.ok(ui.nodes().some(node => node.args[2] === 'Diff 过大，内容已截断。'))
  ui.button('原始 Diff').args[1].onClick()
  await ui.render()
  assert.ok(ui.nodes().some(node => node.args[2] === 'raw:@@ -0,0 +1 @@\n+new'))
  const diffRequest = ui.requests.find(request => request.action === 'get-stash-diff')
  assert.equal(diffRequest.untracked, true)
  assert.equal(diffRequest.path, 'new.txt')
  ui.button('删除').args[1].onClick()
  await ui.render()
  assert.ok(!ui.requests.some(request => request.action === 'drop-stash'))
  ui.button('确认删除贮藏').args[1].onClick()
  await ui.render(); await ui.render()
  const drop = ui.requests.find(request => request.action === 'drop-stash')
  assert.equal(drop.hash, stash.hash)
  assert.equal(drop.selector, stash.selector)
  assert.equal(drop.confirmRisk, true)
  ui.cleanup()
})

test('快速切换贮藏时旧详情不能覆盖当前选择', async () => {
  const stashes = [0, 1].map(index => ({ selector: 'stash@{' + index + '}', hash: String(index).repeat(40), subject: 'stash ' + index }))
  let resolveOld
  const ui = stashHarness(async request => {
    if (request.action === 'get-stashes') return { ok: true, data: stashes }
    if (request.action === 'get-summary') return { ok: true, data: { files: [] } }
    if (request.action === 'get-stash-detail') {
      if (request.selector === stashes[0].selector) return new Promise(resolve => { resolveOld = resolve })
      return { ok: true, data: { hash: stashes[1].hash, files: [{ path: 'current.txt', status: 'M', untracked: false }] } }
    }
    if (request.action === 'get-stash-diff') return { ok: true, data: { diff: 'current diff' } }
    throw Error(request.action)
  })
  await ui.render(); await ui.render()
  const rows = () => ui.nodes().filter(node => node.args[0] === 'button' && node.args[1]?.className?.includes('gg-stash-select'))
  rows()[0].args[1].onClick()
  await ui.render()
  rows()[1].args[1].onClick()
  await ui.render(); await ui.render()
  resolveOld({ ok: true, data: { files: [{ path: 'old.txt', status: 'D', untracked: false }] } })
  await ui.render(); await ui.render()
  assert.ok(ui.button('M · current.txt'))
  assert.ok(!ui.button('D · old.txt'))
  assert.equal(ui.requests.filter(request => request.action === 'get-stash-diff').length, 1)
  ui.cleanup()
})

function mergeHarness(rpc) { return stashHarness(rpc, 'GitMergeTab') }

test('提交修正预填完整说明，要求确认，携带快照并防止双击重复执行', async () => {
  const state = { head: 'a'.repeat(40), branch: 'main', message: '标题\n\n正文', parents: ['b'.repeat(40)], token: 'snapshot', staged: true, dirty: true, blocked: false }
  const ui = stashHarness(async request => request.action === 'get-commit-edit-state'
    ? { ok: true, data: state } : { ok: true, data: { operation: null, files: [] } }, 'GitCommitActions')
  await ui.render(); await ui.render()
  ui.button('修改最近提交说明').args[1].onClick()
  await ui.render()
  const input = ui.nodes().find(node => node.args[1]?.['aria-label'] === '新的提交说明')
  assert.equal(input.args[1].value, state.message)
  assert.equal(ui.button('确认修改最近提交说明').args[1].disabled, true)
  input.args[1].onChange({ currentTarget: { value: 'new\n\nbody' } })
  ui.nodes().find(node => node.args[1]?.type === 'checkbox').args[1].onChange({ currentTarget: { checked: true } })
  await ui.render()
  ui.button('确认修改最近提交说明').args[1].onClick()
  ui.button('确认修改最近提交说明').args[1].onClick()
  await ui.render(); await ui.render()
  const requests = ui.requests.filter(request => request.action === 'amend-message')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].message, 'new\n\nbody')
  assert.equal(requests[0].token, state.token)
  assert.equal(requests[0].confirmRisk, true)
  assert.equal(ui.nodes().find(node => node.args[1]?.role === 'status').args[1].className, 'gg-idletext')
  ui.cleanup()
})

test('历史合并提交只提供 Revert，主线选择必填，冲突后切换到解决页', async () => {
  const state = { head: 'a'.repeat(40), branch: 'main', parents: [], token: 'snapshot', dirty: false, blocked: false }
  let conflicts = 0
  const ui = stashHarness(async request => request.action === 'get-commit-edit-state'
    ? { ok: true, data: state } : { ok: true, data: { operation: 'revert', files: [{ path: 'a.txt' }] } }, 'GitCommitActions')
  ui.props.hash = 'b'.repeat(40)
  ui.props.parents = ['c'.repeat(40), 'd'.repeat(40)]
  ui.props.onConflicts = () => { conflicts++ }
  await ui.render(); await ui.render()
  assert.equal(ui.button('修改最近提交说明'), undefined)
  ui.button('Revert 此提交').args[1].onClick()
  await ui.render()
  const check = () => ui.nodes().find(node => node.args[1]?.type === 'checkbox').args[1].onChange({ currentTarget: { checked: true } })
  check(); await ui.render()
  assert.equal(ui.button('确认Revert 此提交').args[1].disabled, true)
  ui.nodes().find(node => node.args[1]?.['aria-label'] === '主线父提交').args[1].onChange({ currentTarget: { value: '2' } })
  await ui.render()
  assert.equal(ui.button('确认Revert 此提交').args[1].disabled, true)
  check(); await ui.render()
  assert.equal(ui.button('确认Revert 此提交').args[1].disabled, false)
  ui.button('确认Revert 此提交').args[1].onClick()
  await ui.render(); await ui.render()
  const request = ui.requests.find(request => request.action === 'revert-commit')
  assert.equal(request.hash, ui.props.hash)
  assert.equal(request.mainline, 2)
  assert.equal(conflicts, 1)
  ui.cleanup()
})

test('根提交禁用 soft 撤销，无暂存改动禁用补充，脏工作区禁用 Revert', async () => {
  const state = { head: 'a'.repeat(40), branch: 'main', message: 'root', parents: [], token: 'snapshot', staged: false, dirty: true, blocked: false }
  const ui = stashHarness(async () => ({ ok: true, data: state }), 'GitCommitActions')
  ui.props.hash = state.head
  await ui.render(); await ui.render()
  assert.equal(ui.button('撤销最近提交但保留修改').args[1].disabled, true)
  assert.equal(ui.button('补充最近提交').args[1].disabled, true)
  assert.equal(ui.button('Revert 此提交').args[1].disabled, true)
  assert.equal(ui.button('修改最近提交说明').args[1].disabled, false)
  ui.cleanup()
})

test('提交操作刷新忽略旧响应，失败显示诊断并重置确认', async () => {
  let resolveOld
  let reads = 0
  const state = { head: 'a'.repeat(40), branch: 'main', message: 'message', parents: ['b'.repeat(40)], token: 'new', staged: true, blocked: false }
  const ui = stashHarness(async request => {
    if (request.action === 'get-commit-edit-state') {
      if (++reads === 1) return new Promise(resolve => { resolveOld = resolve })
      return { ok: true, data: state }
    }
    return { ok: false, code: 'STATE_CONFLICT', message: '暂存区已变化', diagnostics: 'diagnostic details' }
  }, 'GitCommitActions')
  await ui.render()
  ui.button('刷新操作状态').args[1].onClick()
  await ui.render(); await ui.render()
  resolveOld({ ok: true, data: { ...state, token: 'old', head: 'c'.repeat(40) } })
  await ui.render()
  ui.button('补充最近提交').args[1].onClick(); await ui.render()
  ui.nodes().find(node => node.args[1]?.type === 'checkbox').args[1].onChange({ currentTarget: { checked: true } })
  await ui.render()
  ui.button('确认补充最近提交').args[1].onClick(); await ui.render(); await ui.render()
  assert.equal(ui.requests.find(request => request.action === 'amend-commit').token, 'new')
  assert.ok(ui.nodes().some(node => node.args[2] === '暂存区已变化\ndiagnostic details'))
  assert.equal(ui.nodes().find(node => node.args[1]?.role === 'status').args[1].className, 'gg-workbench-error')
  assert.equal(ui.button('确认补充最近提交'), undefined)
  ui.cleanup()
})

test('合并界面要求有效预览，拒绝过期响应，携带模式和快照并防止重复执行', async () => {
  let resolveOld
  const preview = { branch: 'main', target: 'refs/heads/incoming', head: 'a'.repeat(40), sourceHead: 'b'.repeat(40), token: 'snapshot', base: 'a'.repeat(40), canFastForward: false, alreadyMerged: false, commits: [{ hash: 'b'.repeat(40), subject: 'incoming', author: 'test' }], files: ['a.txt'], diff: '+incoming', commitsTruncated: false, filesTruncated: false, diffTruncated: false }
  const ui = mergeHarness(async request => {
    if (request.action === 'get-branches') return { ok: true, data: { branches: [{ name: 'main', current: true }, { name: 'incoming', current: false }], remotes: [{ name: 'origin/incoming' }], tags: [] } }
    if (request.action === 'get-conflicts') return { ok: true, data: { operation: null, files: [], operationToken: 'state' } }
    if (request.action === 'get-merge-preview') {
      if (request.target.startsWith('refs/remotes/')) return new Promise(resolve => { resolveOld = resolve })
      return { ok: true, data: preview }
    }
    if (request.action === 'merge-branch') return { ok: true, data: { operation: 'merge', files: [{ path: 'a.txt' }], operationToken: 'merge' } }
    throw Error(request.action)
  })
  let conflicts = 0
  ui.props.onConflicts = () => { conflicts++ }
  const select = label => ui.nodes().find(node => node.args[1]?.['aria-label'] === label)
  await ui.render(); await ui.render()
  assert.equal(ui.button('执行合并').args[1].disabled, true)
  const source = select('源分支')
  assert.ok(JSON.stringify(source).includes('refs/remotes/origin/incoming'))
  assert.ok(!JSON.stringify(source).includes('refs/heads/main'))
  source.args[1].onChange({ currentTarget: { value: 'refs/remotes/origin/incoming' } })
  await ui.render()
  ui.button('预览提交与差异').args[1].onClick()
  await ui.render()
  select('源分支').args[1].onChange({ currentTarget: { value: 'refs/heads/incoming' } })
  await ui.render()
  resolveOld({ ok: true, data: { ...preview, target: 'refs/remotes/origin/incoming' } })
  await ui.render(); await ui.render()
  assert.equal(ui.button('执行合并').args[1].disabled, true)
  ui.button('预览提交与差异').args[1].onClick()
  await ui.render(); await ui.render()
  assert.equal(ui.button('执行合并').args[1].disabled, false)
  select('合并方式').args[1].onChange({ currentTarget: { value: 'ff-only' } })
  await ui.render()
  assert.equal(ui.button('执行合并').args[1].disabled, true)
  select('合并方式').args[1].onChange({ currentTarget: { value: 'squash' } })
  await ui.render()
  ui.button('执行合并').args[1].onClick()
  ui.button('执行合并').args[1].onClick()
  await ui.render(); await ui.render()
  const mutations = ui.requests.filter(request => request.action === 'merge-branch')
  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].mode, 'squash')
  assert.equal(mutations[0].token, preview.token)
  assert.equal(mutations[0].target, preview.target)
  assert.equal(conflicts, 1)
  ui.cleanup()
})

test('压缩合并可完成或中止，存在冲突时阻止完成，中止必须确认', async () => {
  let conflicts = [{ path: 'a.txt' }]
  const ui = mergeHarness(async request => {
    if (request.action === 'get-branches') return { ok: true, data: { branches: [{ name: 'main', current: true }], remotes: [], tags: [] } }
    if (request.action === 'get-conflicts') return { ok: true, data: { operation: 'merge', mergeMode: 'squash', files: conflicts, operationToken: 'squash-state' } }
    if (request.action === 'finish-operation') return { ok: true, data: { operation: null, files: [], operationToken: 'done' } }
    throw Error(request.action)
  })
  await ui.render(); await ui.render()
  assert.equal(ui.button('完成合并').args[1].disabled, true)
  assert.equal(ui.button('中止合并').args[1].disabled, true)
  conflicts = []
  ui.button('刷新').args[1].onClick()
  await ui.render(); await ui.render()
  assert.equal(ui.button('完成合并').args[1].disabled, false)
  const checkbox = ui.nodes().find(node => node.args[0] === 'input' && node.args[1]?.type === 'checkbox')
  checkbox.args[1].onChange({ currentTarget: { checked: true } })
  await ui.render()
  assert.equal(ui.button('中止合并').args[1].disabled, false)
  ui.button('中止合并').args[1].onClick()
  await ui.render(); await ui.render()
  const request = ui.requests.find(request => request.action === 'finish-operation')
  assert.equal(request.mode, 'abort')
  assert.equal(request.token, 'squash-state')
  assert.equal(request.confirmRisk, true)
  assert.equal(ui.nodes().find(node => node.args[1]?.role === 'status').args[1].className, 'gg-idletext')
  ui.cleanup()
})
