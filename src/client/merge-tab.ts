const React = require('react') as typeof import('react')
import type { ConflictState, EasyGitAction, EasyGitRequest, EasyGitResponse, MergeMode, MergePreview, RepositoryReferences } from '../shared/contracts'

interface Props {
  sessionId: string
  revision: number
  rpc<A extends EasyGitAction>(request: EasyGitRequest<A>, signal?: AbortSignal): Promise<EasyGitResponse<A>>
  onChanged(): void
  onConflicts(): void
  onCommand(label: string, command: string): (success: boolean) => void
  renderReview(diff: string): React.ReactNode
  renderRawDiff(diff: string): React.ReactNode
}
const h = React.createElement
const failure = (value: { message: string; diagnostics?: string }) => value.message + (value.diagnostics ? '\n' + value.diagnostics : '')

export function GitMergeTab(props: Props) {
  const [references, setReferences] = React.useState<RepositoryReferences | null>(null)
  const [state, setState] = React.useState<ConflictState | null>(null)
  const [target, setTarget] = React.useState('')
  const [mode, setMode] = React.useState<MergeMode>('normal')
  const [preview, setPreview] = React.useState<MergePreview | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [messageIsError, setMessageIsError] = React.useState(false)
  const showError = (text: string) => { setMessage(text); setMessageIsError(true) }
  const [raw, setRaw] = React.useState(false)
  const [abortConfirmed, setAbortConfirmed] = React.useState(false)
  const mounted = React.useRef(true)
  const mutating = React.useRef(false)
  const request = React.useRef<AbortController | null>(null)
  const previewRequest = React.useRef<AbortController | null>(null)
  const invalidate = () => { previewRequest.current?.abort(); setPreview(null); setLoading(false) }
  const load = async () => {
    request.current?.abort(); invalidate()
    const controller = new AbortController()
    request.current = controller
    setReferences(null); setState(null)
    try {
      const [refs, conflicts] = await Promise.all([
        props.rpc({ action: 'get-branches', sessionId: props.sessionId }, controller.signal),
        props.rpc({ action: 'get-conflicts', sessionId: props.sessionId }, controller.signal),
      ])
      if (!mounted.current || controller.signal.aborted) return
      if (refs.ok) setReferences(refs.data)
      else showError(failure(refs))
      if (conflicts.ok) setState(conflicts.data)
      else showError(failure(conflicts))
    } catch (error) { if (mounted.current && !controller.signal.aborted) showError(String(error)) }
  }
  React.useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; request.current?.abort(); previewRequest.current?.abort() }
  }, [props.sessionId, props.revision])
  const readPreview = async () => {
    invalidate(); setLoading(true); setMessage('')
    const controller = new AbortController()
    previewRequest.current = controller
    try {
      const result = await props.rpc({ action: 'get-merge-preview', sessionId: props.sessionId, target }, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      if (result.ok) setPreview(result.data)
      else showError(failure(result))
    } catch (error) { if (mounted.current && !controller.signal.aborted) showError(String(error)) }
    finally { if (mounted.current && !controller.signal.aborted) setLoading(false) }
  }
  const mutate = async (finish?: 'continue' | 'abort') => {
    if (mutating.current || (!finish && !preview) || (finish && !state?.operation)) return
    mutating.current = true; setBusy(true); setMessage('')
    const command = finish ? (state?.mergeMode === 'squash' ? finish === 'abort' ? 'git reset --merge HEAD' : 'git commit --no-edit -F SQUASH_MSG' : 'git merge --' + finish)
      : 'git merge ' + (mode === 'normal' ? '--ff --no-edit' : '--' + mode) + ' ' + preview!.sourceHead
    const complete = props.onCommand(finish === 'abort' ? '中止合并' : finish ? '完成合并' : '合并分支', command)
    try {
      const operationId = 'merge-' + crypto.randomUUID()
      const response = finish
        ? await props.rpc({ action: 'finish-operation', sessionId: props.sessionId, operationId, kind: 'merge', token: state!.operationToken, mode: finish, confirmRisk: finish === 'continue' || abortConfirmed })
        : await props.rpc({ action: 'merge-branch', sessionId: props.sessionId, operationId, target: preview!.target, token: preview!.token, mode })
      complete(response.ok)
      if (!mounted.current) return
      if (response.ok) {
        setState(response.data); setAbortConfirmed(false); setMessageIsError(false)
        setMessage(response.data.files.length ? '合并暂停，请处理冲突后继续或中止。' : response.data.mergeMode === 'squash' ? '压缩结果已暂存。点击“完成合并”创建一个提交，或中止恢复。' : response.data.operation ? '合并尚未完成，请继续或中止。' : finish === 'abort' ? '已中止合并。' : '合并已完成。')
        if (response.data.files.length) props.onConflicts()
      } else showError(failure(response))
    } catch (error) { complete(false); if (mounted.current) showError(String(error)) }
    finally {
      mutating.current = false
      if (mounted.current) { setBusy(false); invalidate(); void load() }
      props.onChanged()
    }
  }
  const sources = [
    ...(references?.branches.filter(branch => !branch.current).map(branch => ({ ref: 'refs/heads/' + branch.name, label: '本地 · ' + branch.name })) ?? []),
    ...(references?.remotes.filter(branch => !branch.name.endsWith('/HEAD')).map(branch => ({ ref: 'refs/remotes/' + branch.name, label: '远程 · ' + branch.name })) ?? []),
  ]
  const button = (label: string, onClick: () => void, disabled = false, primary = false) => h('button', { type: 'button', className: 'gg-btn' + (primary ? ' primary' : ''), disabled: busy || disabled, onClick }, label)
  return h('section', { className: 'gg-tab-content', 'aria-label': '合并分支' },
    h('div', { className: 'gg-tab-toolbar' }, h('strong', null, '合并到当前分支 · ' + (references?.branches.find(branch => branch.current)?.name || '未选择分支')), button('刷新', () => { void load() })),
    message ? h('pre', { className: messageIsError ? 'gg-workbench-error' : 'gg-idletext', role: 'status', style: { whiteSpace: 'pre-wrap' } }, message) : null,
    state?.operation || state?.files.length ? h('div', { className: 'gg-sync-actions' },
      h('p', null, state.operation === 'merge' ? (state.mergeMode === 'squash' ? '压缩合并' : '普通合并') + '进行中 · ' + state.files.length + ' 个冲突' : '请先处理当前 Git 操作或冲突。'),
      button('处理冲突', props.onConflicts),
      state.operation === 'merge' ? h('div', null,
        button('完成合并', () => { void mutate('continue') }, state.files.length > 0, true),
        h('label', { className: 'gg-check' }, h('input', { type: 'checkbox', checked: abortConfirmed, disabled: busy, onChange: e => setAbortConfirmed(e.currentTarget.checked) }), '确认中止并丢弃本次合并处理内容'),
        button('中止合并', () => { void mutate('abort') }, !abortConfirmed),
      ) : null,
    ) : h('div', { className: 'gg-sync-actions' },
      h('label', { className: 'gg-field' }, '源分支', h('select', { className: 'gg-input', 'aria-label': '源分支', value: target, disabled: busy || !references, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { invalidate(); setTarget(e.currentTarget.value); setMessage('') } },
        h('option', { value: '' }, '请选择要合入的分支'), sources.map(source => h('option', { value: source.ref, key: source.ref }, source.label)))),
      h('label', { className: 'gg-field' }, '合并方式', h('select', { className: 'gg-input', 'aria-label': '合并方式', value: mode, disabled: busy, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setMode(e.currentTarget.value as MergeMode) },
        h('option', { value: 'normal' }, '普通合并'), h('option', { value: 'ff-only' }, '仅快进'), h('option', { value: 'squash' }, '压缩合并'))),
      h('p', { className: 'gg-idletext' }, mode === 'normal' ? '能快进时直接快进；分叉时创建合并提交。' : mode === 'ff-only' ? '仅移动分支指针；分支已分叉时拒绝合并。' : '将源分支改动压缩为暂存结果，确认后创建一个单父提交。'),
      h('div', { className: 'gg-actions' }, button(loading ? '正在预览…' : '预览提交与差异', () => { void readPreview() }, loading || !sources.some(source => source.ref === target) || !state),
        button('执行合并', () => { void mutate() }, !preview || loading || !state || preview.alreadyMerged || (mode === 'ff-only' && !preview.canFastForward), true)),
    ),
    preview ? h('div', null,
      h('p', null, preview.target.replace(/^refs\/(heads|remotes)\//, '') + ' → ' + preview.branch + ' · ' + (preview.alreadyMerged ? '已合入，无需重复合并' : preview.canFastForward ? '可快进' : '已分叉，不能仅快进')),
      h('p', { className: 'gg-idletext' }, '文件差异为源分支相对共同祖先的改动，不代表最终合并结果；实际冲突以执行结果为准。远程分支使用本地已获取的引用。'),
      h('strong', null, '待引入提交（' + preview.commits.length + (preview.commitsTruncated ? '+' : '') + '）'),
      h('div', { className: 'gg-commit-list' }, preview.commits.map(commit => h('div', { key: commit.hash }, h('code', null, commit.hash.slice(0, 8)), ' ' + commit.subject + ' · ' + commit.author))),
      h('strong', null, '改动文件（' + preview.files.length + (preview.filesTruncated ? '+' : '') + '）'),
      h('div', { className: 'gg-file-group', style: { maxHeight: 220, overflow: 'auto' } }, preview.files.map(file => h('code', { key: file }, file))),
      preview.commitsTruncated || preview.filesTruncated || preview.diffTruncated ? h('p', { className: 'gg-sync-warning' }, '预览较大，列表或差异已截断；合并仍处理完整源分支。') : null,
      button(raw ? '审阅视图' : '原始 Diff', () => setRaw(!raw)),
      h('div', { className: raw ? 'gg-diff' : 'gg-review' }, raw ? props.renderRawDiff(preview.diff) : props.renderReview(preview.diff)),
    ) : null,
  )
}
