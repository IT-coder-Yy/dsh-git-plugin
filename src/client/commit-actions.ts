const React = require('react') as typeof import('react')
import type { CommitEditAction, CommitEditState, EasyGitAction, EasyGitRequest, EasyGitResponse } from '../shared/contracts'

interface Props {
  sessionId: string
  revision: number
  hash?: string
  parents?: string[]
  disabled?: boolean
  rpc<A extends EasyGitAction>(request: EasyGitRequest<A>, signal?: AbortSignal): Promise<EasyGitResponse<A>>
  onChanged(): void
  onConflicts(): void
  onBusy?(busy: boolean): void
  onCommand(label: string, command: string): (success: boolean) => void
}
const h = React.createElement
const labels: Record<CommitEditAction, string> = {
  'amend-message': '修改最近提交说明',
  'amend-commit': '补充最近提交',
  'undo-commit': '撤销最近提交但保留修改',
  'revert-commit': 'Revert 此提交',
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

export function GitCommitActions(props: Props) {
  const [state, setState] = React.useState<CommitEditState | null>(null)
  const [action, setAction] = React.useState<CommitEditAction | null>(null)
  const [message, setMessage] = React.useState('')
  const [mainline, setMainline] = React.useState(0)
  const [confirmed, setConfirmed] = React.useState(false)
  const [feedback, setFeedback] = React.useState<{ message: string; error: boolean } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const running = React.useRef(false)
  const sequence = React.useRef(0)
  const mounted = React.useRef(false)
  const load = async () => {
    const id = ++sequence.current
    setState(null); setAction(null); setConfirmed(false)
    try {
      const response = await props.rpc({ action: 'get-commit-edit-state', sessionId: props.sessionId })
      if (!mounted.current || id !== sequence.current) return
      if (response.ok) setState(response.data)
      else setFeedback({ message: response.message, error: true })
    } catch (error) {
      if (mounted.current && id === sequence.current) setFeedback({ message: String(error), error: true })
    }
  }
  React.useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; sequence.current++ }
  }, [props.sessionId, props.revision, props.hash])

  const choose = (next: CommitEditAction) => {
    setAction(next); setConfirmed(false); setMainline(0); setFeedback(null)
    setMessage(state?.message ?? '')
  }
  const execute = async () => {
    if (!state || !action || !confirmed || running.current || props.disabled) return
    running.current = true; setBusy(true); props.onBusy?.(true); setFeedback(null)
    const command = action === 'amend-message' ? 'git commit --amend --only --allow-empty --cleanup=verbatim -m ' + quote(message)
      : action === 'amend-commit' ? 'git commit --amend --no-edit --cleanup=verbatim'
        : action === 'undo-commit' ? 'git reset --soft ' + state.parents[0]
          : 'git revert --no-edit ' + (mainline ? '-m ' + mainline + ' ' : '') + props.hash
    const complete = props.onCommand(labels[action], command)
    try {
      const response = await props.rpc({
        action, sessionId: props.sessionId, operationId: 'commit-' + crypto.randomUUID(), token: state.token, confirmRisk: true,
        ...(action === 'amend-message' ? { message } : {}),
        ...(action === 'revert-commit' ? { hash: props.hash, ...(mainline ? { mainline } : {}) } : {}),
      } as EasyGitRequest<CommitEditAction>)
      complete(response.ok)
      props.onChanged()
      if (!mounted.current) return
      if (response.ok) {
        setFeedback({ message: response.data.operation === 'revert' ? 'Revert 尚未完成，请在冲突解决页继续、中止或跳过。' : labels[action] + '已完成。', error: false })
        if (response.data.operation === 'revert') props.onConflicts()
      } else setFeedback({ message: response.message + (response.diagnostics ? '\n' + response.diagnostics : ''), error: true })
      await load()
    } catch (error) {
      complete(false)
      props.onChanged()
      if (mounted.current) { setFeedback({ message: String(error), error: true }); await load() }
    } finally {
      running.current = false; props.onBusy?.(false)
      if (mounted.current) setBusy(false)
    }
  }
  const disabled = busy || !!props.disabled
  const unavailable = disabled || !state || state.blocked || !state.branch
  const latest = !!state && (!props.hash || props.hash === state.head)
  const mergeRevert = action === 'revert-commit' && (props.parents?.length ?? 0) > 1
  const button = (caption: string, onClick: () => void, blocked = false, title?: string) => h('button', {
    type: 'button', className: 'gg-btn', disabled: disabled || blocked, onClick, title,
  }, caption)
  return h('section', { className: 'gg-commit-form', 'aria-label': '提交撤销与修正' },
    h('strong', null, '提交撤销与修正'),
    feedback ? h('pre', { className: feedback.error ? 'gg-workbench-error' : 'gg-idletext', role: 'status', style: { whiteSpace: 'pre-wrap' } }, feedback.message) : null,
    state ? h('p', { className: 'gg-idletext' }, (state.branch || '分离 HEAD') + ' · HEAD ' + state.head.slice(0, 12)) : h('p', null, '正在读取提交状态。可点击刷新重试。'),
    state?.blocked ? h('p', null, '请先完成当前 Git 操作并解决冲突。') : null,
    state && !state.branch ? h('p', null, '请先切换到本地分支。') : null,
    h('div', { className: 'gg-actions' },
      latest ? button(labels['amend-message'], () => choose('amend-message'), unavailable) : null,
      latest ? button(labels['amend-commit'], () => choose('amend-commit'), unavailable || !state?.staged, '仅补充已暂存改动，保留原提交说明') : null,
      latest ? button(labels['undo-commit'], () => choose('undo-commit'), unavailable || !state?.parents.length, '撤销到第一父提交，改动保留在暂存区；根提交不支持') : null,
      props.hash ? button(labels['revert-commit'], () => choose('revert-commit'), unavailable || !!state?.dirty, '生成反向提交；需要工作区和暂存区干净') : null,
      button('刷新操作状态', () => { setFeedback(null); void load() }),
    ),
    props.hash && state?.dirty ? h('p', { className: 'gg-idletext' }, 'Revert 前请先提交或贮藏当前改动。') : null,
    action ? h('div', null,
      h('strong', null, labels[action]),
      h('p', null, action === 'amend-message' ? '仅替换最近提交说明，已暂存和未暂存内容保持不变。'
        : action === 'amend-commit' ? '将全部已暂存改动补充到最近提交，保留原说明；未暂存改动不纳入。'
          : action === 'undo-commit' ? '当前分支退回第一父提交，撤销的改动保留在暂存区，工作区文件保持不变。'
            : '新增一个提交来抵消所选提交的改动，已有提交历史保留。'),
      action === 'amend-message' ? h('textarea', { className: 'gg-input', 'aria-label': '新的提交说明', rows: 5, maxLength: 49152, value: message, disabled, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setMessage(e.currentTarget.value) }) : null,
      mergeRevert ? h('label', { className: 'gg-field' }, '主线父提交（保留哪条主线；撤销相对该父提交的改动）',
        h('select', { className: 'gg-input', 'aria-label': '主线父提交', value: mainline, disabled, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setMainline(Number(e.currentTarget.value)); setConfirmed(false) } },
          h('option', { value: 0 }, '请选择主线父提交'),
          props.parents?.map((parent, index) => h('option', { key: parent, value: index + 1 }, '父提交 ' + (index + 1) + ' · ' + parent.slice(0, 12))),
        )) : null,
      h('label', { className: 'gg-check' }, h('input', { type: 'checkbox', checked: confirmed, disabled, onChange: e => setConfirmed(e.currentTarget.checked) }),
        action === 'revert-commit' ? '我确认撤销此提交的改动，并了解可能产生冲突' : '我了解这会改写本地历史；若提交已推送，会影响与远程的同步'),
      h('div', { className: 'gg-actions' },
        button(busy ? '正在执行…' : '确认' + labels[action], () => { void execute() }, unavailable || !confirmed || (action === 'amend-message' && !message.trim()) || (mergeRevert && !mainline)),
        button('取消', () => { setAction(null); setConfirmed(false) }),
      ),
    ) : null,
  )
}
