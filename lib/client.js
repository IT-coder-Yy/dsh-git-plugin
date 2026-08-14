/**
 * deepseek-git-guide — Client 半区（静态 Cordis 插件 / npm 包形态）
 *
 * 产物格式与 DeepSeek Harness 内置客户端包一致：
 *   window.__ModuleLoader__.load({ id, factory }) —— 由 web shell 的模块加载器执行，
 *   factory 内通过 require("react") 获取 React，module.exports 导出 Cordis 插件对象。
 *
 * Client→Host 通信走同源 HTTP：POST /git-guide，body.action 分发（见 lib/index.js）。
 * 面板注册在 conversation.input.dock（输入框上方通栏）：
 *   - 空闲：一行提示，等待 git_propose 登记新提议
 *   - 有提议：步骤列表 + 风险徽标 + [直接执行] / [复制命令（手动执行）]
 *   - 手动执行：复制后进入“待执行”，按命令类型校验预期结果（verified / partial）
 *   - 执行成功/验证通过：展示结果数秒后自动关闭，回到空闲
 */
window.__ModuleLoader__.load({
  id: "deepseek-git-guide",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    const RPC_URL = '/git-guide'

    function rpc(body) {
      return fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then((r) => r.json())
    }

    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById('deepseek-git-guide-css')) return
      const tag = document.createElement('style')
      tag.id = 'deepseek-git-guide-css'
      tag.textContent = `
        .gg-dock { margin: 2px 0; padding: 6px 10px; font-size: 13px; line-height: 1.5; color: inherit; }
        .gg-dock-full { border: 1px solid rgba(127,127,127,.35); border-radius: 8px; background: rgba(127,127,127,.06); }
        .gg-idle { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .gg-idletext { opacity: .65; font-size: 12px; }
        .gg-head { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; }
        .gg-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; font-weight: 600; }
        .gg-badge.safe { color: #0a7d33; background: rgba(10,125,51,.15); }
        .gg-badge.normal { color: #b26a00; background: rgba(178,106,0,.15); }
        .gg-badge.hard { color: #c62828; background: rgba(198,40,40,.18); }
        .gg-intent { opacity: .75; font-size: 12px; margin-bottom: 6px; }
        .gg-steps { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; }
        .gg-step { display: flex; gap: 6px; align-items: baseline; }
        .gg-stepnum { flex: none; font-weight: 600; opacity: .6; font-size: 12px; }
        .gg-stepcode { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; background: rgba(127,127,127,.12); border-radius: 4px; padding: 3px 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; user-select: all; }
        .gg-stepres { display: flex; gap: 6px; align-items: baseline; font-size: 12px; }
        .gg-expl { opacity: .9; margin: 8px 0; }
        .gg-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .gg-btn { border: 1px solid rgba(127,127,127,.4); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12.5px; background: transparent; color: inherit; }
        .gg-btn:disabled { opacity: .45; cursor: not-allowed; }
        .gg-btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
        .gg-btn.danger { background: #c62828; border-color: #c62828; color: #fff; }
        .gg-riskline { font-size: 12px; color: #c62828; margin: 6px 0; }
        .gg-check { display: flex; gap: 6px; align-items: center; cursor: pointer; font-size: 12.5px; margin: 6px 0; }
        .gg-out { margin-top: 8px; font-size: 12px; }
        .gg-ran { margin: 8px 0; }
        .gg-pre { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; background: rgba(127,127,127,.1); border-radius: 6px; padding: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 4px 0; }
        .gg-ok { color: #0a7d33; font-weight: 600; }
        .gg-fail { color: #c62828; font-weight: 600; }
      `
      document.head.appendChild(tag)
    }

    function GitDock(props) {
      const sessionId = props.sessionId || ''
      const intervalFn = props.intervalFn || null
      const timeoutFn = props.timeoutFn || null
      const [view, setView] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [understood, setUnderstood] = React.useState(false)
      const [outcome, setOutcome] = React.useState(null)
      const [ranInfo, setRanInfo] = React.useState(null)
      const [partialInfo, setPartialInfo] = React.useState(null)
      const [verifyMsg, setVerifyMsg] = React.useState(null)

      const refresh = () => {
        rpc({ action: 'state', sessionId: String(sessionId) })
          .then((res) => {
            if (res && res.ok === true) {
              setView(res.proposal)
              if (res.verified === true && res.proposal && res.proposal.proposalId) {
                setRanInfo(res.changedState || '检测到预期结果已达成')
                scheduleClose(res.proposal.proposalId)
              } else if (res.partial === true && res.proposal && res.proposal.proposalId) {
                setPartialInfo({ message: res.message || '预期结果未达成', state: res.changedState || '' })
              }
            }
          })
          .catch((err) => { console.log('git-guide state 调用失败', String((err && err.message) || err)) })
      }

      React.useEffect(() => {
        refresh()
        if (!intervalFn) return undefined
        const disp = intervalFn(refresh, 1200)
        return () => { try { if (typeof disp === 'function') disp() } catch (e) { /* ignore */ } }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const doDismiss = (pid) => {
        rpc({ action: 'dismiss', sessionId: String(sessionId), proposalId: pid })
          .then(refresh)
          .catch(refresh)
      }
      const scheduleClose = (pid) => {
        if (timeoutFn) timeoutFn(() => doDismiss(pid), 4000)
        else doDismiss(pid)
      }

      if (!view) {
        return React.createElement('div', { className: 'gg-dock' },
          React.createElement('div', { className: 'gg-idle' },
            React.createElement('span', { className: 'gg-badge normal' }, 'Git 操作建议 · 空闲'),
            React.createElement('span', { className: 'gg-idletext' }, '等待新的 git 操作提议…（git_propose 登记后这里会出现命令与按钮）'),
          ),
        )
      }

      const proposal = view
      const steps = proposal.steps && proposal.steps.length ? proposal.steps : [{ command: proposal.command, result: null }]
      const isHard = proposal.risk === 'hard'
      const isCopied = proposal.copied === true
      const canRun = !busy && (!isHard || understood)

      const onRun = () => {
        if (!canRun) return
        setBusy(true)
        setOutcome(null)
        rpc({ action: 'execute', sessionId: String(sessionId), proposalId: proposal.proposalId, confirm: understood })
          .then((res) => {
            setOutcome(res || { ok: false, error: '无返回' })
            if (res && res.ok === true) scheduleClose(proposal.proposalId)
          })
          .catch((err) => { setOutcome({ ok: false, error: String((err && err.message) || err) }) })
          .then(() => setBusy(false))
      }
      const onCopy = () => {
        try {
          const nav = typeof navigator !== 'undefined' ? navigator : null
          if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
            const text = steps.map((s) => s.command).join(' && ')
            nav.clipboard.writeText(text)
              .then(() => rpc({ action: 'mark-copied', sessionId: String(sessionId), proposalId: proposal.proposalId }).then(refresh).catch(refresh))
              .catch(() => {})
          }
        } catch (e) { /* ignore */ }
      }
      const onVerify = () => {
        setVerifyMsg(null)
        setPartialInfo(null)
        rpc({ action: 'verify', sessionId: String(sessionId), proposalId: proposal.proposalId })
          .then((res) => {
            if (res && res.verified === true) {
              setRanInfo((res && res.changedState) || '检测到预期结果已达成')
              scheduleClose(proposal.proposalId)
            } else if (res && res.partial === true) {
              setPartialInfo({ message: res.message || '预期结果未达成', state: (res && res.changedState) || '' })
            } else {
              setVerifyMsg((res && res.message) || '未检测到预期结果，看起来还没有执行')
            }
          })
          .catch((err) => { setVerifyMsg(String((err && err.message) || err)) })
      }

      const riskLabel = isHard ? '高风险' : proposal.risk === 'safe' ? '安全' : '常规'
      const badgeCls = isHard ? 'gg-badge hard' : proposal.risk === 'safe' ? 'gg-badge safe' : 'gg-badge normal'

      const renderSteps = () => steps.map((s, i) => React.createElement('div', { className: 'gg-step', key: 'step' + i },
        React.createElement('span', { className: 'gg-stepnum' }, String(i + 1) + '.'),
        React.createElement('code', { className: 'gg-stepcode' }, String(s.command)),
      ))

      const lines = []
      lines.push(React.createElement('div', { className: 'gg-head', key: 'head' },
        React.createElement('span', null, 'Git 操作建议'),
        React.createElement('span', { className: badgeCls }, riskLabel),
      ))
      if (proposal.intent) lines.push(React.createElement('div', { className: 'gg-intent', key: 'intent' }, String(proposal.intent)))
      lines.push(React.createElement('div', { className: 'gg-steps', key: 'steps' }, renderSteps()))
      if (proposal.explanation) lines.push(React.createElement('div', { className: 'gg-expl', key: 'expl' }, String(proposal.explanation)))

      if (ranInfo) {
        lines.push(React.createElement('div', { className: 'gg-ok gg-ran', key: 'ran' }, '✔ 检测到预期结果已达成（已执行），即将关闭此建议'))
        lines.push(React.createElement('pre', { className: 'gg-pre', key: 'ranstate' }, String(ranInfo)))
        return React.createElement('div', { className: 'gg-dock gg-dock-full' }, lines)
      }

      if (partialInfo) {
        lines.push(React.createElement('div', { className: 'gg-riskline', key: 'pmsg' }, '⚠ ' + String(partialInfo.message)))
        if (partialInfo.state) lines.push(React.createElement('pre', { className: 'gg-pre', key: 'pstate' }, String(partialInfo.state)))
        const acts = []
        acts.push(React.createElement('button', { key: 'verify', className: 'gg-btn primary', onClick: onVerify }, '重新检测'))
        acts.push(React.createElement('button', { key: 'drop', className: 'gg-btn', onClick: () => doDismiss(proposal.proposalId) }, '放弃建议'))
        lines.push(React.createElement('div', { className: 'gg-actions', key: 'actions' }, acts))
        return React.createElement('div', { className: 'gg-dock gg-dock-full' }, lines)
      }

      if (isCopied) {
        lines.push(React.createElement('div', { className: 'gg-intent', key: 'copied' }, '命令已复制到剪贴板（多步用 && 连接）。请在终端按顺序执行；面板会自动检测预期结果。'))
        if (verifyMsg) lines.push(React.createElement('div', { className: 'gg-riskline', key: 'vmsg' }, verifyMsg))
        const acts = []
        acts.push(React.createElement('button', { key: 'verify', className: 'gg-btn primary', onClick: onVerify }, '重新检测'))
        acts.push(React.createElement('button', { key: 'drop', className: 'gg-btn', onClick: () => doDismiss(proposal.proposalId) }, '放弃建议'))
        lines.push(React.createElement('div', { className: 'gg-actions', key: 'actions' }, acts))
        return React.createElement('div', { className: 'gg-dock gg-dock-full' }, lines)
      }

      if (isHard) {
        lines.push(React.createElement('div', { className: 'gg-riskline', key: 'risk' }, '⚠ ' + ((proposal.reasons && proposal.reasons.length) ? proposal.reasons.join('；') : '该操作风险较高，可能造成不可逆的改动')))
        lines.push(React.createElement('label', { className: 'gg-check', key: 'ck' },
          React.createElement('input', { type: 'checkbox', checked: understood, onChange: (e) => setUnderstood(e.target.checked) }),
          React.createElement('span', null, '我已了解风险，确认执行'),
        ))
      }
      const actions = []
      actions.push(React.createElement('button', { key: 'run', className: 'gg-btn ' + (isHard ? 'danger' : 'primary'), disabled: !canRun, onClick: onRun },
        busy ? '执行中…' : (isHard ? '确认并直接执行' : '直接执行')))
      actions.push(React.createElement('button', { key: 'copy', className: 'gg-btn', disabled: busy, onClick: onCopy }, '复制命令（手动执行）'))
      lines.push(React.createElement('div', { className: 'gg-actions', key: 'actions' }, actions))

      if (outcome) {
        const ok = outcome.ok === true
        const oLines = []
        if (outcome.error) oLines.push(String(outcome.error))
        if (outcome.stdout) oLines.push(String(outcome.stdout))
        if (outcome.stderr) oLines.push(String(outcome.stderr))
        const text = oLines.join('\n').trim() || '（无输出）'
        lines.push(React.createElement('div', { className: 'gg-out', key: 'out' },
          React.createElement('div', { className: ok ? 'gg-ok' : 'gg-fail' }, ok ? '✔ 执行成功' : '✘ 执行失败'),
          React.createElement('pre', null, text),
        ))
        if (outcome.steps && outcome.steps.length) {
          const stepLines = outcome.steps.map((s, i) => React.createElement('div', { className: 'gg-stepres', key: 'sr' + i },
            React.createElement('span', { className: s.ok ? 'gg-ok' : 'gg-fail' }, s.ok ? '✓' : '✗'),
            React.createElement('code', { className: 'gg-stepcode' }, String(s.command)),
          ))
          lines.push(React.createElement('div', { className: 'gg-out', key: 'stepsout' }, stepLines))
        }
        if (!ok) {
          if (outcome.diagnostics) lines.push(React.createElement('div', { className: 'gg-out', key: 'diag' },
            React.createElement('div', { className: 'gg-intent' }, '仓库诊断信息：'),
            React.createElement('pre', null, String(outcome.diagnostics)),
          ))
          lines.push(React.createElement('div', { className: 'gg-intent', key: 'hint' }, '执行失败。你可以描述下一步，或让我分析原因并给出修正命令。'))
        }
      }

      return React.createElement('div', { className: 'gg-dock gg-dock-full' }, lines)
    }

    module.exports = {
      inject: ['timer'],
      apply(ctx) {
        injectStyles()

        const slots = ctx.get('slots')
        if (!slots) return

        const timer = ctx.get('timer') || ctx.timer
        const intervalFn = timer && typeof timer.interval === 'function' ? timer.interval.bind(timer) : null
        const timeoutFn = timer && typeof timer.timeout === 'function' ? timer.timeout.bind(timer) : null

        slots.inject('conversation.input.dock', () => slots.register(
          { name: 'conversation.input.dock', id: 'git-guide', order: 30, label: 'Git 操作建议' },
          (props) => React.createElement(GitDock, { sessionId: props.sessionId, intervalFn, timeoutFn }),
        ))
      },
    }

    return module.exports
  },
})
