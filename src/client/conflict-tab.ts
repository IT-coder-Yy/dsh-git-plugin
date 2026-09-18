const React = require('react') as typeof import('react')
import type { ActionResult, ConflictDetail, ConflictOperation, ConflictState, ConflictVersion, EasyGitAction, EasyGitRequest, EasyGitResponse } from '../shared/contracts'
import { chooseConflictBlock, parseConflictBlocks } from './conflict-model'

interface Props {
  sessionId: string
  revision: number
  rpc<A extends EasyGitAction>(request: EasyGitRequest<A>, signal?: AbortSignal): Promise<EasyGitResponse<A>>
  onChanged(): void
  onDirty(dirty: boolean): void
  onCommand(label: string, command: string): (success: boolean) => void
}
const drafts = new Map<string, { detail: ConflictDetail; text: string }>()
const h = React.createElement
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value)
const label = (operation: ConflictOperation | null) => operation === 'merge' ? 'Merge' : operation === 'rebase' ? 'Rebase' : operation === 'cherry-pick' ? 'Cherry-pick' : '无进行中的操作'

export function GitConflictsTab(props: Props) {
  const [state, setState] = React.useState<ConflictState | null>(null)
  const [detail, setDetail] = React.useState<ConflictDetail | null>(null)
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [risk, setRisk] = React.useState(false)
  const [kind, setKind] = React.useState<ConflictOperation>('merge')
  const [target, setTarget] = React.useState('')
  const sequence = React.useRef(0)
  const mounted = React.useRef(true)
  const editor = React.useRef<HTMLTextAreaElement>(null)
  const nextBlock = React.useRef(0)
  const requestRef = React.useRef<AbortController | null>(null)
  const dirty = !!detail && text !== (detail.result.text ?? '')
  const draftKey = (path: string) => props.sessionId + '\0' + path
  const blocks = parseConflictBlocks(text, detail?.markerSize)

  React.useEffect(() => {
    props.onDirty(dirty)
    if (detail) {
      if (dirty) drafts.set(draftKey(detail.path), { detail, text })
      else drafts.delete(draftKey(detail.path))
    }
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, text, detail])

  const showFailure = (response: { message?: string; error?: string; diagnostics?: string }) => {
    const reason = response.message || response.error || '无法读取冲突数据'
    setMessage((/unknown action|unsupported action/i.test(reason) ? 'Host 尚未加载冲突接口，请重启 Harness 后刷新页面。' : reason) + (response.diagnostics ? '\n' + response.diagnostics : ''))
  }
  const load = async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const response = await props.rpc({ action: 'get-conflicts', sessionId: props.sessionId }, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      if (response.ok) setState(response.data)
      else showFailure(response)
    } catch (error) { if (mounted.current && !controller.signal.aborted) setMessage(errorText(error)) }
  }
  React.useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; sequence.current++; requestRef.current?.abort(); props.onDirty(false) }
  }, [props.sessionId, props.revision])

  const select = async (path: string, discard = false) => {
    if (busy || (dirty && !discard)) return
    const id = ++sequence.current
    if (discard) drafts.delete(draftKey(path))
    setMessage('')
    setBusy(true)
    try {
      const response = await props.rpc({ action: 'get-conflict', sessionId: props.sessionId, path })
      if (!mounted.current || id !== sequence.current) return
      if (response.ok) {
        const draft = drafts.get(draftKey(path))
        setDetail(draft?.detail ?? response.data)
        setText(draft?.text ?? response.data.result.text ?? '')
        if (draft && draft.detail.token !== response.data.token) setMessage('已恢复未保存的草稿，但文件已被外部修改。请复制草稿后重新加载，再合并修改。')
      } else showFailure(response)
    } catch (error) { if (mounted.current && id === sequence.current) setMessage(errorText(error)) }
    finally { if (mounted.current && id === sequence.current) setBusy(false) }
  }

  const mutate = async (action: 'save-conflict' | 'resolve-conflict' | 'start-operation' | 'finish-operation', payload: Record<string, unknown>) => {
    if (busy) return
    setBusy(true); setMessage('')
    const command = action === 'save-conflict' ? '保存工作区文件 ' + String(payload.path)
      : action === 'resolve-conflict' ? '标记解决 ' + String(payload.path) + '（' + String(payload.choice) + '）'
        : 'git ' + String(payload.kind) + ' ' + (action === 'start-operation' ? String(payload.target) : '--' + String(payload.mode))
    const complete = props.onCommand(action === 'save-conflict' ? '保存冲突结果' : '冲突处理', command)
    try {
      const response = await props.rpc({ action, sessionId: props.sessionId, operationId: 'conflict-' + crypto.randomUUID(), ...payload } as EasyGitRequest) as ActionResult<ConflictDetail | ConflictState>
      complete(response.ok)
      if (!mounted.current) return
      if (!response.ok) { showFailure(response); await load(); return }
      if (action === 'save-conflict') {
        const updated = response.data as ConflictDetail
        drafts.delete(draftKey(updated.path)); setDetail(updated); setText(updated.result.text ?? '')
        setMessage('结果已保存。确认内容后点击“标记解决”。')
      } else {
        if (detail) drafts.delete(draftKey(detail.path))
        setDetail(null); setText(''); setState(response.data as ConflictState); setRisk(false)
        const nextState = response.data as ConflictState
        setMessage(nextState.files.length ? '请继续处理下列冲突文件。' : nextState.operation ? '冲突均已标记解决，请继续当前 Git 操作。' : 'Git 操作已完成。')
      }
      props.onChanged()
    } catch (error) { complete(false); if (mounted.current) setMessage(errorText(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const button = (caption: string, action: () => void, disabled = false, primary = false) => h('button', { type: 'button', className: 'gg-btn' + (primary ? ' primary' : ''), disabled: busy || disabled, onClick: action }, caption)
  const version = (title: string, value: ConflictVersion) => h('section', { className: 'gg-conflict-version', key: title },
    h('strong', null, title), value.reason ? h('p', null, value.reason) : !value.exists ? h('p', null, '该版本不存在（删除或新增冲突）')
      : h('pre', { className: 'gg-conflict-code', tabIndex: 0 }, (value.text ?? '').split('\n').map((line, i) => h('span', { className: 'gg-conflict-line', key: i }, h('span', { className: 'gg-conflict-line-number', 'aria-hidden': true }, i + 1), line, '\n'))))
  const ours = detail?.operation === 'rebase' ? '当前方（目标分支及已重放提交）' : '当前方（HEAD）'
  const theirs = detail?.operation === 'rebase' ? '传入方（正在重放的提交）' : '传入方（待合入提交）'
  const resolve = (choice: 'result' | 'ours' | 'theirs' | 'delete') => { if (detail) void mutate('resolve-conflict', { path: detail.path, token: detail.token, choice }) }

  return h('section', { className: 'gg-tab-content gg-conflicts', 'aria-label': '冲突解决' },
    h('div', { className: 'gg-tab-toolbar' }, h('strong', null, state ? label(state.operation) + ' · ' + state.files.length + ' 个冲突' : '正在读取冲突状态…'), button('刷新列表', () => { void load() })),
    message ? h('pre', { className: 'gg-workbench-error', role: 'status', style: { whiteSpace: 'pre-wrap' } }, message) : null,
    state?.operation ? h('div', { className: 'gg-sync-actions' },
      h('p', null, state.files.length ? '逐个保存并标记解决后，继续当前操作。' : '冲突均已暂存，可以继续；若 Git 提示空提交，可跳过当前提交。'),
      h('label', { className: 'gg-check' }, h('input', { type: 'checkbox', checked: risk, disabled: busy, onChange: e => setRisk(e.currentTarget.checked) }), '我了解继续可能创建或重写提交；中止或跳过会丢弃本次处理内容'),
      h('div', { className: 'gg-actions' }, ...(['continue', 'abort', ...(state.operation === 'merge' ? [] : ['skip'])] as const).map(mode => button(mode === 'continue' ? '继续 ' + label(state.operation) : mode === 'abort' ? '中止 ' + label(state.operation) : '跳过当前提交', () => { void mutate('finish-operation', { kind: state.operation, token: state.operationToken, mode, confirmRisk: risk }) }, !risk || dirty || (mode === 'continue' && state.files.length > 0), mode === 'continue'))),
    ) : h('div', { className: 'gg-sync-actions' },
      h('strong', null, '开始 Git 操作'),
      h('div', { className: 'gg-actions' }, h('select', { className: 'gg-input', value: kind, disabled: busy, 'aria-label': '操作类型', onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setKind(e.currentTarget.value as ConflictOperation); setRisk(false) } }, ['merge', 'rebase', 'cherry-pick'].map(value => h('option', { value, key: value }, label(value as ConflictOperation)))),
        h('input', { className: 'gg-input', value: target, disabled: busy, placeholder: kind === 'cherry-pick' ? '提交 SHA 或引用' : '目标分支或引用', 'aria-label': '目标引用', onChange: e => setTarget(e.currentTarget.value) })),
      h('label', { className: 'gg-check' }, h('input', { type: 'checkbox', checked: risk, disabled: busy, onChange: e => setRisk(e.currentTarget.checked) }), '我了解操作会修改工作区和提交历史'),
      button('开始 ' + label(kind), () => { void mutate('start-operation', { kind, target: target.trim(), confirmRisk: risk }) }, !risk || !target.trim() || dirty || !!state?.files.length || !state, true),
    ),
    h('div', { className: 'gg-conflict-files', 'aria-label': '冲突文件列表' }, state?.files.length ? state.files.map(file => h('button', { type: 'button', key: file.path, className: 'gg-btn' + (detail?.path === file.path ? ' primary' : ''), disabled: busy || dirty, onClick: () => { void select(file.path) } }, file.path + ' · ' + file.kind)) : h('p', { className: 'gg-idletext' }, state ? '没有未解决的冲突。' : '正在读取冲突状态…')),
    detail ? h('div', null,
      h('div', { className: 'gg-tab-toolbar' }, h('strong', null, detail.path), h('span', null, dirty ? '有未保存编辑' : '与工作区一致'), button('丢弃草稿并重新加载', () => { if (!dirty || window.confirm('丢弃该文件尚未保存的编辑？')) void select(detail.path, true) })),
      detail.special ? h('p', { className: 'gg-sync-warning' }, '特殊冲突：可选择整份一方版本或删除文件。符号链接、子模块及超限文件请使用外部工具。') : null,
      h('div', { className: 'gg-conflict-grid' }, version('基础版本', detail.base), version(ours, detail.ours), version(theirs, detail.theirs),
        h('section', { className: 'gg-conflict-version' }, h('strong', null, '结果（可编辑）'), detail.editable ? h('textarea', { ref: editor, className: 'gg-conflict-editor', 'aria-label': '冲突解决结果', value: text, disabled: busy, spellCheck: false, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.currentTarget.value) }) : version('工作区', detail.result))),
      h('div', { className: 'gg-actions' }, button('保存结果', () => { void mutate('save-conflict', { path: detail.path, token: detail.token, content: text }) }, !dirty || !detail.editable), button('标记解决', () => resolve('result'), dirty || blocks.length > 0 || detail.result.text === null, true),
        button('采用整份当前方并标记', () => resolve('ours'), dirty || !detail.ours.exists || (!!detail.ours.reason && !detail.ours.reason.startsWith('二进制'))), button('采用整份传入方并标记', () => resolve('theirs'), dirty || !detail.theirs.exists || (!!detail.theirs.reason && !detail.theirs.reason.startsWith('二进制'))),
        button('删除文件并标记', () => { if (window.confirm('删除 ' + detail.path + ' 并将此删除标记为解决？')) resolve('delete') }, dirty)),
      detail.editable ? h('div', { className: 'gg-conflict-blocks' }, h('strong', null, '剩余 ' + blocks.length + ' 个冲突块'), button('下一个冲突块', () => { const index = nextBlock.current % blocks.length; nextBlock.current = index + 1; const block = blocks[index]; if (block) { editor.current?.focus(); editor.current?.setSelectionRange(block.start, block.end); document.getElementById('gg-conflict-block-' + index)?.scrollIntoView({ block: 'nearest' }) } }, !blocks.length), blocks.map((block, index) => h('section', { className: 'gg-conflict-block', id: 'gg-conflict-block-' + index, key: block.start },
        h('strong', null, '冲突块 ' + (index + 1)), h('div', { className: 'gg-conflict-grid' }, h('pre', null, ours + '\n' + block.ours), block.base !== null ? h('pre', null, '基础版本\n' + block.base) : null, h('pre', null, theirs + '\n' + block.theirs)),
        h('div', { className: 'gg-actions' }, ...(['ours', 'theirs', 'both'] as const).map(choice => button(choice === 'ours' ? '采用当前方' : choice === 'theirs' ? '采用传入方' : '保留双方（当前在前）', () => setText(chooseConflictBlock(text, block, choice)))),
          button('定位并编辑', () => { editor.current?.focus(); editor.current?.setSelectionRange(block.start, block.end) })),
      ))) : null,
    ) : null,
  )
}
