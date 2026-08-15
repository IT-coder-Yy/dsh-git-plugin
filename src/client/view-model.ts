import type { BranchSummary, CommitSummary, RepositoryFile } from '../shared/contracts'

export type AnyRecord = Record<string, any>
export type RepositoryMutationAction =
  | 'stage-paths'
  | 'unstage-paths'
  | 'stage-all'
  | 'unstage-all'
  | 'commit'
  | 'create-branch'
  | 'switch-branch'
  | 'delete-branch'

export interface CommandLogEntry {
  id: number
  label: string
  command: string
  status: 'running' | 'succeeded' | 'failed'
}

export interface RequestSlot {
  controller: AbortController | null
  sequence: number
}

export interface TrackedRequest {
  sequence: number
  signal: AbortSignal
}

export interface FileTreeNode {
  name: string
  path: string
  folders: FileTreeNode[]
  files: RepositoryFile[]
}

export interface ReviewRow {
  kind: 'context' | 'added' | 'deleted' | 'skipped' | 'annotation'
  oldNumber: number | null
  newNumber: number | null
  text: string
}

export interface CommitGraphEdge {
  from: number
  to: number | null
  active: boolean
}

export interface CommitGraphRow {
  commit: CommitSummary
  lane: number
  laneCount: number
  edges: CommitGraphEdge[]
}

export interface HostSplitLayout {
  frame: HTMLElement
  sidebar: HTMLElement
  center: HTMLElement
  details: HTMLElement
}

export interface ActiveHostSplit {
  layout: HostSplitLayout
  splitColumns: string
  previousGridTemplateColumns: string
  previousTrack: string
  previousDetailsWidth: string
  previousDetailsMinWidth: string
  previousDetailsMaxWidth: string
  previousDetailsBorderLeft: string
}

export interface ResizeDrag {
  pointerId: number
  startX: number
  startWidth: number
  currentRatio: number
}

export const WORKBENCH_RATIO_KEY = 'dsh-easygit-plugin:workbench-ratio'
export const WORKBENCH_TRACK = '--dsh-easygit-plugin-workbench-width'
export const WORKBENCH_DEFAULT_RATIO = 0.36
export const WORKBENCH_MIN_RATIO = 0.24
export const WORKBENCH_MAX_RATIO = 0.75

export function appendCommandLog(current: CommandLogEntry[], entry: CommandLogEntry): CommandLogEntry[] {
  return [...current, entry].slice(-100)
}

export function filterLocalBranches(branches: BranchSummary[], query: string): BranchSummary[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return branches
  return branches.filter((branch) => String(branch.name || '').toLocaleLowerCase().includes(normalized))
}

export function isCurrentCommitRequest(selectedHash: string, requestedHash: string, currentSequence: number, requestSequence: number): boolean {
  return selectedHash === requestedHash && currentSequence === requestSequence
}

export function nextCommitSelection(currentHash: string, requestedHash: string): string {
  return currentHash === requestedHash ? '' : requestedHash
}

export function commitFileTone(status: string): string {
  if (/^[AC]/.test(status)) return ' added'
  if (/^D/.test(status)) return ' deleted'
  return ' modified'
}

export function isLatestRequest(currentSequence: number, requestSequence: number): boolean {
  return currentSequence === requestSequence
}

export function beginTrackedRequest(ref: { current: RequestSlot }): TrackedRequest {
  ref.current.controller?.abort()
  const controller = new AbortController()
  const sequence = ref.current.sequence + 1
  ref.current = { controller, sequence }
  return { sequence, signal: controller.signal }
}

export function cancelTrackedRequest(ref: { current: RequestSlot }): void {
  ref.current.controller?.abort()
  ref.current = { controller: null, sequence: ref.current.sequence + 1 }
}

export function isTrackedRequestCurrent(ref: { current: RequestSlot }, request: TrackedRequest): boolean {
  return ref.current.sequence === request.sequence && !request.signal.aborted
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function deriveCommitGraph(commits: CommitSummary[]): CommitGraphRow[] {
  let lanes: string[] = []
  return commits.map((commit) => {
    const hash = String(commit.hash || '')
    let lane = lanes.indexOf(hash)
    if (lane < 0) {
      lane = lanes.length
      lanes.push(hash)
    }
    const before = [...lanes]
    const parents = Array.isArray(commit.parents) ? commit.parents.map(String).filter(Boolean) : []
    let after = [...before]
    if (parents.length === 0) after.splice(lane, 1)
    else {
      after[lane] = parents[0]!
      for (let index = 1; index < parents.length; index += 1) {
        const parent = parents[index]!
        if (!after.includes(parent)) after.splice(lane + index, 0, parent)
      }
    }
    after = after.filter((value, index) => value && after.indexOf(value) === index)
    const edges: CommitGraphEdge[] = []
    before.forEach((value, from) => {
      if (value === hash) {
        if (parents.length === 0) edges.push({ from, to: null, active: true })
        else parents.forEach((parent) => edges.push({ from, to: after.indexOf(parent), active: true }))
      } else {
        const to = after.indexOf(value)
        if (to >= 0) edges.push({ from, to, active: false })
      }
    })
    const row = { commit, lane, laneCount: Math.max(1, before.length, after.length), edges }
    lanes = after
    return row
  })
}

export function clampWorkbenchRatio(value: number): number {
  return Math.min(WORKBENCH_MAX_RATIO, Math.max(WORKBENCH_MIN_RATIO, value))
}

export function readWorkbenchRatio(): number {
  if (typeof window === 'undefined' || !window.localStorage) return WORKBENCH_DEFAULT_RATIO
  try {
    const value = Number(window.localStorage.getItem(WORKBENCH_RATIO_KEY))
    return Number.isFinite(value) && value > 0 ? clampWorkbenchRatio(value) : WORKBENCH_DEFAULT_RATIO
  } catch (error) {
    return WORKBENCH_DEFAULT_RATIO
  }
}

export function persistWorkbenchRatio(value: number | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    if (value === null) window.localStorage.removeItem(WORKBENCH_RATIO_KEY)
    else window.localStorage.setItem(WORKBENCH_RATIO_KEY, String(value))
  } catch (error) {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function workbenchTrackForRatio(ratio: number): string {
  return `${Number((ratio * 100).toFixed(2))}vw`
}

export function repositoryName(topLevel: unknown): string {
  const normalized = String(topLevel || '').replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || normalized || 'Git 仓库'
}

function displayShellArg(value: unknown): string {
  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'"
}

export function mutationCommand(action: string, payload: AnyRecord = {}): { label: string; command: string } | null {
  const paths = Array.isArray(payload.paths) ? payload.paths.map(displayShellArg).join(' ') : ''
  if (action === 'stage-paths') return { label: '暂存文件', command: 'git add -- ' + paths }
  if (action === 'unstage-paths') return { label: '取消暂存文件', command: 'git reset HEAD -- ' + paths }
  if (action === 'stage-all') return { label: '全部暂存', command: 'git add -A' }
  if (action === 'unstage-all') return { label: '取消全部暂存', command: 'git reset HEAD -- :/' }
  if (action === 'commit') return { label: '提交变更', command: 'git commit -m ' + displayShellArg(payload.message) }
  if (action === 'create-branch') return { label: '新建分支', command: 'git switch -c ' + displayShellArg(payload.name) + ' ' + displayShellArg(payload.base) }
  if (action === 'switch-branch') return { label: '切换分支', command: 'git switch ' + displayShellArg(payload.name) }
  if (action === 'delete-branch') return {
    label: payload.force ? '强制删除分支' : '安全删除分支',
    command: 'git branch ' + (payload.force ? '-D' : '-d') + ' -- ' + displayShellArg(payload.name),
  }
  return null
}

export function viewportWidth(): number {
  return typeof window === 'undefined' ? 0 : Math.max(1, window.innerWidth)
}

export function sidebarTrackWidth(layout: HostSplitLayout): number {
  const rectWidth = layout.sidebar.getBoundingClientRect().width
  if (rectWidth > 0) return rectWidth
  const styleWidth = Number.parseFloat(window.getComputedStyle(layout.sidebar).width)
  return Number.isFinite(styleWidth) ? styleWidth : 0
}

export function findWorkbenchHostSplit(anchor: HTMLElement): HostSplitLayout | null {
  if (typeof window === 'undefined') return null
  const detailsRoot = anchor.closest("[data-side='details']")
  let directChild = detailsRoot instanceof HTMLElement ? detailsRoot : anchor
  for (let candidate = directChild.parentElement; candidate; candidate = candidate.parentElement) {
    if (window.getComputedStyle(candidate).display === 'grid') {
      const children = Array.from(candidate.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
      const detailsIndex = children.indexOf(directChild)
      const sidebar = children[0]
      const center = children[detailsIndex - 1]
      if (detailsIndex >= 2 && sidebar && center) return { frame: candidate, sidebar, center, details: directChild }
    }
    directChild = candidate
  }
  return null
}

export function buildFileTree(files: RepositoryFile[]): FileTreeNode {
  const root: FileTreeNode = { name: '', path: '', folders: [], files: [] }
  const folder = (parent: FileTreeNode, name: string): FileTreeNode => {
    const existing = parent.folders.find((entry) => entry.name === name)
    if (existing) return existing
    const created: FileTreeNode = { name, path: parent.path ? parent.path + '/' + name : name, folders: [], files: [] }
    parent.folders.push(created)
    return created
  }
  for (const file of files) {
    const sourcePath = String(file.path || '')
    const directory = /[\\/]$/.test(sourcePath)
    const parts = sourcePath.split(String.fromCharCode(92)).join('/').split('/').filter(Boolean)
    if (!parts.length) continue
    let current = root
    const folderCount = directory ? parts.length : parts.length - 1
    for (let index = 0; index < folderCount; index += 1) current = folder(current, parts[index]!)
    if (!directory) current.files.push(file)
  }
  const sort = (node: FileTreeNode): void => {
    node.folders.sort((left, right) => left.name.localeCompare(right.name))
    node.files.sort((left, right) => String(left.path || '').localeCompare(String(right.path || '')))
    node.folders.forEach(sort)
  }
  sort(root)
  return root
}

export function parseReviewRows(diff: string): ReviewRow[] {
  const rows: ReviewRow[] = []
  let inHunk = false
  let oldLine = 0
  let newLine = 0
  let previousOldNext = 1
  let previousNewNext = 1
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      const oldStart = Number(hunk[1])
      const newStart = Number(hunk[3])
      const skipped = Math.max(oldStart - previousOldNext, newStart - previousNewNext)
      if (skipped > 0) rows.push({ kind: 'skipped', oldNumber: null, newNumber: null, text: skipped + ' 行未修改内容（由 Git 省略）' })
      oldLine = oldStart
      newLine = newStart
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.charCodeAt(0) === 92) {
      rows.push({ kind: 'annotation', oldNumber: null, newNumber: null, text: line.slice(1).trim() || '文件末尾没有换行符' })
      continue
    }
    if (line.startsWith(' ')) {
      rows.push({ kind: 'context', oldNumber: oldLine, newNumber: newLine, text: line.slice(1) })
      oldLine += 1
      newLine += 1
      previousOldNext = oldLine
      previousNewNext = newLine
      continue
    }
    if (line.startsWith('-')) {
      rows.push({ kind: 'deleted', oldNumber: oldLine, newNumber: null, text: line.slice(1) })
      oldLine += 1
      previousOldNext = oldLine
      previousNewNext = newLine
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'added', oldNumber: null, newNumber: newLine, text: line.slice(1) })
      newLine += 1
      previousOldNext = oldLine
      previousNewNext = newLine
    }
  }
  return rows
}

export function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) return 'gg-diff-meta'
  if (line.startsWith('@@')) return 'gg-diff-modified'
  if (line.startsWith('+')) return 'gg-diff-added'
  if (line.startsWith('-')) return 'gg-diff-deleted'
  return 'gg-diff-context'
}
