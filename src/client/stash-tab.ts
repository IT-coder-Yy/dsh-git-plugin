const React = require('react') as typeof import('react')
import type { DiffResult, EasyGitAction, EasyGitRequest, EasyGitResponse, RepositoryFile, StashDetail, StashFile, StashSummary } from '../shared/contracts'
import { beginTrackedRequest, cancelTrackedRequest, isAbortError, isTrackedRequestCurrent, mutationCommand, type RequestSlot } from './view-model'

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
type StashMutation = 'create-stash' | 'apply-stash' | 'pop-stash' | 'drop-stash' | 'branch-stash'
const h = React.createElement
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const failureText = (response: { message: string; diagnostics?: string }) => response.message + (response.diagnostics ? '\n' + response.diagnostics : '')

export function GitStashesTab(props: Props) {
  const [stashes, setStashes] = React.useState<StashSummary[]>([])
  const [files, setFiles] = React.useState<RepositoryFile[]>([])
  const [loading, setLoading] = React.useState(false)
  const [ready, setReady] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [includeUntracked, setIncludeUntracked] = React.useState(false)
  const [allFiles, setAllFiles] = React.useState(true)
  const [paths, setPaths] = React.useState<string[]>([])
  const [selected, setSelected] = React.useState<StashSummary | null>(null)
  const [detail, setDetail] = React.useState<StashDetail | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [file, setFile] = React.useState<StashFile | null>(null)
  const [diff, setDiff] = React.useState<DiffResult | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [reviewMode, setReviewMode] = React.useState(true)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [branchName, setBranchName] = React.useState('')
  const listRequest = React.useRef<RequestSlot>({ controller: null, sequence: 0 })
  const detailRequest = React.useRef<RequestSlot>({ controller: null, sequence: 0 })
  const diffRequest = React.useRef<RequestSlot>({ controller: null, sequence: 0 })
  const mounted = React.useRef(true)
  const mutating = React.useRef(false)
  const eligible = files.filter(item => includeUntracked || item.indexStatus !== '?')
  const chosen = allFiles ? eligible.map(item => item.path) : paths.filter(path => eligible.some(item => item.path === path))

  const resetDetail = () => {
    cancelTrackedRequest(detailRequest)
    cancelTrackedRequest(diffRequest)
    setSelected(null); setDetail(null); setFile(null); setDiff(null)
    setDetailLoading(false); setDiffLoading(false); setConfirmDelete(false); setBranchName('')
  }
  const load = async () => {
    const request = beginTrackedRequest(listRequest)
    setLoading(true); setReady(false); resetDetail()
    try {
      const [list, summary] = await Promise.all([
        props.rpc({ action: 'get-stashes', sessionId: props.sessionId }, request.signal),
        props.rpc({ action: 'get-summary', sessionId: props.sessionId }, request.signal),
      ])
      if (!isTrackedRequestCurrent(listRequest, request)) return
      if (list.ok) setStashes(list.data)
      else { setStashes([]); setMessage(failureText(list)) }
      if (summary.ok) {
        setFiles(summary.data.files); setReady(true)
        setPaths(current => current.filter(path => summary.data.files.some(item => item.path === path)))
      } else { setFiles([]); setMessage(failureText(summary)) }
    } catch (error) {
      if (isTrackedRequestCurrent(listRequest, request) && !isAbortError(error)) setMessage(errorText(error))
    } finally { if (isTrackedRequestCurrent(listRequest, request)) setLoading(false) }
  }
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelTrackedRequest(listRequest); cancelTrackedRequest(detailRequest); cancelTrackedRequest(diffRequest)
    }
  }, [])
  React.useEffect(() => {
    void load()
    return () => { cancelTrackedRequest(listRequest); cancelTrackedRequest(detailRequest); cancelTrackedRequest(diffRequest) }
  }, [props.sessionId, props.revision])

  const selectFile = async (stash: StashSummary, next: StashFile) => {
    const request = beginTrackedRequest(diffRequest)
    setFile(next); setDiff(null); setDiffLoading(true)
    try {
      const response = await props.rpc({ action: 'get-stash-diff', sessionId: props.sessionId, selector: stash.selector, hash: stash.hash, path: next.path, untracked: next.untracked }, request.signal)
      if (!isTrackedRequestCurrent(diffRequest, request)) return
      if (response.ok) setDiff(response.data)
      else setMessage(failureText(response))
    } catch (error) {
      if (isTrackedRequestCurrent(diffRequest, request) && !isAbortError(error)) setMessage(errorText(error))
    } finally { if (isTrackedRequestCurrent(diffRequest, request)) setDiffLoading(false) }
  }
  const selectStash = async (stash: StashSummary) => {
    resetDetail(); setMessage(''); setSelected(stash); setDetailLoading(true)
    const request = beginTrackedRequest(detailRequest)
    try {
      const response = await props.rpc({ action: 'get-stash-detail', sessionId: props.sessionId, selector: stash.selector, hash: stash.hash }, request.signal)
      if (!isTrackedRequestCurrent(detailRequest, request)) return
      if (response.ok) {
        setDetail(response.data)
        if (response.data.files[0]) void selectFile(stash, response.data.files[0])
      } else setMessage(failureText(response))
    } catch (error) {
      if (isTrackedRequestCurrent(detailRequest, request) && !isAbortError(error)) setMessage(errorText(error))
    } finally { if (isTrackedRequestCurrent(detailRequest, request)) setDetailLoading(false) }
  }
  const mutate = async (action: StashMutation) => {
    if (mutating.current || (action !== 'create-stash' && !selected)) return
    mutating.current = true; setBusy(true); setMessage('')
    const payload = action === 'create-stash'
      ? { message: description, includeUntracked, ...(allFiles ? {} : { paths: chosen }) }
      : { selector: selected!.selector, hash: selected!.hash, name: branchName.trim(), confirmRisk: confirmDelete }
    const command = mutationCommand(action, payload)!
    const complete = props.onCommand(command.label, command.command)
    try {
      const response = await props.rpc({ action, sessionId: props.sessionId, operationId: 'ui:' + action + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2), ...payload } as EasyGitRequest<StashMutation>)
      complete(response.ok)
      // Even a failed apply/pop may have changed files or produced conflicts.
      props.onChanged()
      if (!mounted.current) return
      if (response.ok) {
        setMessage(action === 'branch-stash' ? '已创建并切换分支，恢复改动并删除该贮藏。' : command.label + '成功。')
        if (action === 'create-stash') { setDescription(''); setPaths([]); setAllFiles(true) }
      } else setMessage(failureText(response))
      await load()
    } catch (error) {
      complete(false)
      props.onChanged()
      if (mounted.current) { setMessage(errorText(error)); await load() }
    } finally {
      mutating.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const toggleFile = (path: string) => {
    setAllFiles(false)
    setPaths(chosen.includes(path) ? chosen.filter(item => item !== path) : [...chosen, path])
  }
  const button = (text: string, onClick: () => void, disabled = false, extra = '') => h('button', { type: 'button', className: 'gg-btn' + extra, disabled: busy || disabled, onClick }, text)

  return h('section', { className: 'gg-tab-content' },
    h('div', { className: 'gg-tab-toolbar' },
      h('span', { className: 'gg-section-heading' }, '贮藏', h('span', { className: 'gg-section-count' }, String(stashes.length))),
      button(loading ? '正在刷新…' : '刷新', () => { setMessage(''); void load() }, loading),
      button('冲突解决', props.onConflicts),
    ),
    message ? h('div', { className: 'gg-stash-message', role: 'status' }, message) : null,
    h('div', { className: 'gg-commit-form' },
      h('strong', null, '创建贮藏'),
      h('textarea', { className: 'gg-input', 'aria-label': '贮藏说明', placeholder: '贮藏说明（可选）', maxLength: 4096, rows: 2, value: description, disabled: busy, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value) }),
      h('label', { className: 'gg-stash-option' }, h('input', { type: 'checkbox', checked: includeUntracked, disabled: busy, onChange: event => setIncludeUntracked(event.target.checked) }), '包含未跟踪文件'),
      h('div', { className: 'gg-actions' },
        button('选择全部', () => { setAllFiles(true); setPaths([]) }, !ready),
        button('清空选择', () => { setAllFiles(false); setPaths([]) }, !ready),
        h('span', { className: 'gg-idletext' }, '已选 ' + chosen.length + ' / ' + eligible.length),
      ),
      h('div', { className: 'gg-stash-files' }, eligible.length ? eligible.map(item => h('label', { className: 'gg-stash-option', key: item.indexStatus + item.workTreeStatus + item.path },
        h('input', { type: 'checkbox', checked: chosen.includes(item.path), disabled: busy || loading, onChange: () => toggleFile(item.path) }),
        h('code', null, item.indexStatus + item.workTreeStatus), h('span', null, item.originalPath ? item.originalPath + ' → ' + item.path : item.path),
      )) : h('div', { className: 'gg-idletext' }, loading ? '正在读取工作区…' : '没有可贮藏的文件。')),
      button(busy ? '正在执行…' : '创建贮藏', () => { void mutate('create-stash') }, !ready || loading || !chosen.length || (!allFiles && chosen.length > 500), ' primary'),
      h('div', { className: 'gg-idletext' }, '保存所选文件的暂存区与工作区改动；重命名会包含原路径。未跟踪文件需勾选上方选项。'),
    ),
    h('div', { className: 'gg-stash-list' }, stashes.length ? stashes.map(stash => h('button', {
      type: 'button', className: 'gg-stash-row gg-stash-select' + (selected?.selector === stash.selector ? ' active' : ''), key: stash.selector,
      disabled: busy || loading, 'aria-pressed': selected?.selector === stash.selector, onClick: () => { void selectStash(stash) },
    },
    h('code', { className: 'gg-stash-selector' }, stash.selector), h('span', { className: 'gg-stash-subject', title: stash.subject }, stash.subject || '（无贮藏说明）'),
    h('code', { className: 'gg-stash-hash' }, stash.hash.slice(0, 8)),
    h('div', { className: 'gg-stash-meta' }, h('span', { className: 'gg-stash-author' }, stash.author), h('span', { className: 'gg-stash-date' }, stash.date)),
    )) : h('div', { className: 'gg-idletext' }, loading ? '正在读取贮藏列表…' : '当前仓库没有贮藏。')),
    stashes.length === 100 ? h('div', { className: 'gg-idletext' }, '仅显示最近 100 条贮藏。') : null,
    selected ? h('div', { className: 'gg-commit-form' },
      h('strong', null, selected.selector + ' · ' + selected.subject),
      h('div', { className: 'gg-actions' },
        button('应用', () => { void mutate('apply-stash') }),
        button('弹出', () => { void mutate('pop-stash') }),
        button('删除', () => setConfirmDelete(true)),
      ),
      h('div', { className: 'gg-idletext' }, '应用会保留贮藏；弹出仅在恢复成功后删除贮藏。冲突时保留贮藏，请前往“冲突解决”。'),
      confirmDelete ? h('div', { className: 'gg-stash-confirm', role: 'alert' },
        h('p', null, '删除 ' + selected.selector + ' 后，其中尚未恢复的改动可能丢失。确认删除？'),
        button('确认删除贮藏', () => { void mutate('drop-stash') }, false, ' danger'), button('取消', () => setConfirmDelete(false)),
      ) : null,
      h('div', { className: 'gg-actions' },
        h('input', { className: 'gg-input', 'aria-label': '从贮藏创建的分支名', placeholder: '新分支名', value: branchName, disabled: busy, onChange: event => setBranchName(event.target.value) }),
        button('从贮藏创建分支', () => { void mutate('branch-stash') }, !branchName.trim()),
      ),
      h('div', { className: 'gg-idletext' }, '工作区需干净：从贮藏的原始提交创建并切换分支，恢复成功后删除贮藏。'),
      detailLoading ? h('div', { className: 'gg-idletext' }, '正在读取贮藏文件…') : null,
      detail ? h('div', { className: 'gg-stash-files' }, detail.files.map(item => h('button', {
        type: 'button', key: (item.untracked ? 'u:' : 't:') + item.path, className: 'gg-btn gg-stash-file' + (file?.path === item.path && file?.untracked === item.untracked ? ' active' : ''),
        disabled: busy, onClick: () => { void selectFile(selected, item) },
      }, item.status + ' · ' + item.path + (item.untracked ? '（未跟踪）' : '')))) : null,
      detail?.filesTruncated ? h('div', { className: 'gg-idletext' }, '文件列表过大，当前仅显示部分文件。') : null,
      detail && !detail.files.length ? h('div', { className: 'gg-idletext' }, '没有文件内容差异。') : null,
      file ? h('div', null,
        h('div', { className: 'gg-stash-path' }, file.path),
        h('div', { className: 'gg-review-toolbar' },
          button('文件审阅', () => setReviewMode(true), false, ' gg-review-mode' + (reviewMode ? ' active' : '')),
          button('原始 Diff', () => setReviewMode(false), false, ' gg-review-mode' + (!reviewMode ? ' active' : '')),
        ),
        diffLoading ? h('div', { className: 'gg-idletext' }, '正在读取差异…') : null,
        diff?.truncated ? h('div', { className: 'gg-idletext' }, 'Diff 过大，内容已截断。') : null,
        diff ? reviewMode
          ? h('div', { className: 'gg-review' }, props.renderReview(diff.diff), !/^@@ /m.test(diff.diff) ? h('div', { className: 'gg-idletext' }, '二进制、空文件或权限变更可切换“原始 Diff”查看。') : null)
          : h('pre', { className: 'gg-diff-code' }, props.renderRawDiff(diff.diff)) : null,
      ) : null,
    ) : null,
  )
}
