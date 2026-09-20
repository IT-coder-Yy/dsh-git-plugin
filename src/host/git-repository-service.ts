import { conflictWorkerCommand } from './conflict-worker'
import { createStashCommand } from './stash-worker'
import type {
  ActionErrorCode,
  ActionFailureReason,
  ActionResult,
  BranchSummary,
  CommitDetail,
  CommitDiffResult,
  CommitFileChange,
  CommitRefSummary,
  CommitSummary,
  DiffResult,
  ReferenceSummary,
  RepositoryFile,
  RepositoryReferences,
  RepositorySummary,
  StashSummary,
  StashDetail,
  SyncState,
} from '../shared/contracts'
export type {
  BranchSummary,
  CommitDetail,
  CommitDiffResult,
  CommitFileChange,
  CommitRefSummary,
  CommitSummary,
  DiffResult,
  ReferenceSummary,
  RepositoryFile,
  RepositoryReferences,
  RepositorySummary,
  StashSummary,
  SyncState,
} from '../shared/contracts'
import { quoteShellArg, redactAndLimit, redactSecrets } from './command-policy'

export interface GitRunResult {
  exitCode: number | null
  signal?: string | null
  timedOut?: boolean
  aborted?: boolean
  stdout?: { text?: string }
  stderr?: { text?: string }
}

export interface ShellService {
  resolve(request: Record<string, unknown>): unknown
  run(specification: unknown): Promise<GitRunResult>
}

interface MutationRequest {
  sessionId: string
  workdir: string
  operationId: unknown
  signal?: AbortSignal
  sandboxPolicy?: unknown
}

const MUTATION_OUTPUT_MAX_CHARS = 100_000
const DIFF_MAX_CHARS = 200_000
const COMMIT_DETAIL_MAX_CHARS = 100_000
const COMMIT_DIFF_MAX_CHARS = 300_000
const COMMIT_FILE_MAX = 500
const STASH_MAX = 100
const MAX_PATHS = 100
const OPERATION_TTL_MS = 24 * 60 * 60 * 1000

function errorResult<T>(code: ActionErrorCode, message: string, diagnostics?: string, reason?: ActionFailureReason): ActionResult<T> {
  return {
    ok: false,
    code,
    message,
    ...(diagnostics ? { diagnostics } : {}),
    ...(reason ? { reason } : {}),
  }
}

function outputOf(result: GitRunResult): string {
  return ((result.stdout?.text ?? '') + (result.stderr?.text ?? '')).trim()
}

function mutationErrorCode(result: GitRunResult): ActionErrorCode {
  if (result.timedOut) return 'TIMEOUT'
  return 'GIT_FAILED'
}

function parseStatus(status: string): RepositoryFile[] {
  const files: RepositoryFile[] = []
  const records = status.split('\0')
  // Only consume complete records; Git's -z format never quotes filenames.
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index]!
    if (record.startsWith('## ') || record.length < 4) continue
    const indexStatus = record[0]!
    const workTreeStatus = record[1]!
    const path = record.slice(3)
    if (/[RC]/.test(indexStatus + workTreeStatus)) {
      if (index + 1 >= records.length - 1) break
      files.push({ indexStatus, workTreeStatus, path, originalPath: records[++index]! })
    } else files.push({ indexStatus, workTreeStatus, path })
  }
  return files
}

function validPathspec(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\0\r\n]/.test(path)) return false
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return false
  return !path.split(/[\\/]/).some((part) => part === '..')
}

function validBranchName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 255
    && !/[\0\r\n\s~^:?*\[\\]/.test(name)
    && !name.startsWith('-')
    && !name.startsWith('.')
    && !name.endsWith('.')
    && !name.includes('..')
    && !name.includes('@{')
    && !name.endsWith('.lock')
}

function validRemoteName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 255
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
    && !name.includes('..')
    && !name.includes('@{')
    && !name.endsWith('.lock')
}

function conflictCount(files: RepositoryFile[]): number {
  return files.filter((file) => {
    const status = file.indexStatus + file.workTreeStatus
    return status.includes('U') || status === 'AA' || status === 'DD'
  }).length
}

function validCommitHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)
}

function validStashPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !path.includes('\0') && !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)
    && !path.split(/[\\/]/).some((part) => part === '..')
}

function parseCommitFiles(nameStatus: string, numstat: string): { files: CommitFileChange[]; filesTruncated: boolean; totals: CommitDetail['totals'] } {
  const statusRows = nameStatus.split('\n').filter(Boolean)
  const statRows = numstat.split('\n').filter(Boolean)
  let additions = 0
  let deletions = 0
  let binary = 0
  const files = statusRows.slice(0, COMMIT_FILE_MAX).map((line, index) => {
    const parts = line.split('\t')
    const status = parts[0] ?? ''
    const renamed = /^[RC]/.test(status) && parts.length >= 3
    const path = redactAndLimit(renamed ? parts[2] ?? '' : parts[1] ?? '', 4096)
    const previousPath = renamed ? redactAndLimit(parts[1] ?? '', 4096) : undefined
    const stat = (statRows[index] ?? '').split('\t')
    const added = /^\d+$/.test(stat[0] ?? '') ? Number(stat[0]) : null
    const deleted = /^\d+$/.test(stat[1] ?? '') ? Number(stat[1]) : null
    if (added === null || deleted === null) binary += 1
    else { additions += added; deletions += deleted }
    return { status: redactAndLimit(status, 32), path, ...(previousPath ? { previousPath } : {}), additions: added, deletions: deleted }
  })
  for (const line of statRows.slice(files.length)) {
    const stat = line.split('\t')
    const added = /^\d+$/.test(stat[0] ?? '') ? Number(stat[0]) : null
    const deleted = /^\d+$/.test(stat[1] ?? '') ? Number(stat[1]) : null
    if (added === null || deleted === null) binary += 1
    else { additions += added; deletions += deleted }
  }
  return {
    files,
    filesTruncated: statusRows.length > COMMIT_FILE_MAX,
    totals: { files: statusRows.length, additions, deletions, binary },
  }
}

const repositoryLocks = new Map<string, Promise<void>>()

export class GitRepositoryService {
  private readonly locks = repositoryLocks
  private readonly operations = new Map<string, { createdAt: number; result: Promise<ActionResult<unknown>> }>()

  constructor(private readonly shell: ShellService | undefined) {}

  async run(workdir: string, command: string, timeoutMs = 20_000, stdoutMaxBytes = 30_000, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<GitRunResult> {
    if (!this.shell) return { exitCode: -1, stderr: { text: 'shell 服务不可用' } }
    try {
      const specification = this.shell.resolve({ command, workdir, timeoutMs, stdoutMaxBytes, signal, ...(sandboxPolicy ? { sandboxPolicy } : {}) })
      return await this.shell.run(specification)
    } catch (error) {
      return { exitCode: -1, stderr: { text: error instanceof Error ? error.message : String(error) } }
    }
  }

  async getTopLevel(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<{ topLevel: string }>> {
    const result = await this.run(workdir, 'git rev-parse --show-toplevel', 15_000, 4096, signal, sandboxPolicy)
    const topLevel = redactAndLimit(result.stdout?.text ?? '', 4096).trim()
    if (result.exitCode !== 0 || !topLevel || !(/^\/|^[A-Za-z]:[\\/]/.test(topLevel))) {
      return errorResult('NOT_GIT_REPOSITORY', '目标目录不是 Git 仓库', redactAndLimit(outputOf(result), 4096))
    }
    return { ok: true, data: { topLevel } }
  }

  async getSummary(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<RepositorySummary>> {
    const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy)
    if (!topLevel.ok) return topLevel
    const [branchResult, headResult, statusResult] = await Promise.all([
      this.run(workdir, 'git branch --show-current', 15_000, 4096, signal, sandboxPolicy),
      this.run(workdir, 'git rev-parse --short HEAD', 15_000, 4096, signal, sandboxPolicy),
      this.run(workdir, 'git status --porcelain=v1 --branch --untracked-files=all -z', 15_000, 50_000, signal, sandboxPolicy),
    ])
    if (branchResult.exitCode !== 0 || headResult.exitCode !== 0 || statusResult.exitCode !== 0) {
      return errorResult('GIT_FAILED', '无法读取 Git 仓库摘要', redactAndLimit(outputOf(branchResult) + '\n' + outputOf(headResult) + '\n' + outputOf(statusResult), 8192))
    }
    const rawStatus = statusResult.stdout?.text ?? ''
    const files = parseStatus(rawStatus)
    const status = redactAndLimit(rawStatus.replace(/\0/g, '\n'), 50_000)
    return {
      ok: true,
      data: {
        topLevel: topLevel.data.topLevel,
        branch: redactAndLimit(branchResult.stdout?.text ?? '', 4096).trim(),
        head: redactAndLimit(headResult.stdout?.text ?? '', 4096).trim(),
        status,
        files,
        stagedCount: files.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?').length,
      },
    }
  }

  async getDiff(workdir: string, path: unknown, staged: boolean, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<DiffResult>> {
    if (path !== undefined && path !== null && !validPathspec(path)) return errorResult('INVALID_ARGUMENT', 'path 必须是仓库内的相对路径')
    const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy)
    if (!topLevel.ok) return topLevel
    const pathArgument = typeof path === 'string' ? ' -- ' + quoteShellArg(path) : ''
    const command = 'git diff' + (staged ? ' --cached' : '') + pathArgument
    const result = await this.run(workdir, command, 20_000, DIFF_MAX_CHARS + 1024, signal, sandboxPolicy)
    if (result.exitCode !== 0) return errorResult('GIT_FAILED', '无法读取 Git Diff', redactAndLimit(outputOf(result), 8192))
    let raw = redactSecrets(result.stdout?.text ?? '')
    if (!staged && typeof path === 'string' && raw.length === 0) {
      const tracked = await this.run(workdir, 'git ls-files --error-unmatch -- ' + quoteShellArg(path), 15_000, 4096, signal, sandboxPolicy)
      if (tracked.exitCode !== 0) {
        const untracked = await this.run(workdir, 'git diff --no-index -- /dev/null ' + quoteShellArg(path), 20_000, DIFF_MAX_CHARS + 1024, signal, sandboxPolicy)
        if (untracked.exitCode !== 0 && untracked.exitCode !== 1) {
          return errorResult('GIT_FAILED', '无法读取未跟踪文件的 Diff', redactAndLimit(outputOf(untracked), 8192))
        }
        raw = redactSecrets(untracked.stdout?.text ?? '')
      }
    }
    return { ok: true, data: { path: typeof path === 'string' ? path : null, staged, diff: raw.slice(0, DIFF_MAX_CHARS), truncated: raw.length > DIFF_MAX_CHARS } }
  }

  async getBranches(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<RepositoryReferences>> {
    const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy)
    if (!topLevel.ok) return topLevel
    const branchFormat = '%(HEAD)%09%(refname:lstrip=2)%09%(upstream:short)'
    const referenceFormat = '%(refname)%09%(refname:short)%09%(objectname:short)%09%(*objectname:short)%09%(subject)'
    const [branchResult, referenceResult] = await Promise.all([
      this.run(workdir, 'git branch --format=' + quoteShellArg(branchFormat), 15_000, 30_000, signal, sandboxPolicy),
      this.run(workdir, 'git for-each-ref --format=' + quoteShellArg(referenceFormat) + ' refs/remotes refs/tags', 15_000, 80_000, signal, sandboxPolicy),
    ])
    if (branchResult.exitCode !== 0 || referenceResult.exitCode !== 0) {
      return errorResult('GIT_FAILED', '无法读取分支和标签', redactAndLimit(outputOf(branchResult) + '\n' + outputOf(referenceResult), 8192))
    }
    const branches = (branchResult.stdout?.text ?? '').split('\n').filter(Boolean).map((line) => {
      const [head = '', name = '', upstream = ''] = line.split('\t')
      return { name: redactAndLimit(name, 512), current: head === '*', upstream: redactAndLimit(upstream, 512) }
    })
    const remotes: ReferenceSummary[] = []
    const tags: ReferenceSummary[] = []
    for (const line of (referenceResult.stdout?.text ?? '').split('\n').filter(Boolean)) {
      const [fullName = '', shortName = '', objectHash = '', peeledHash = '', subject = ''] = line.split('\t')
      const entry = {
        // Git's :short adds heads/ or remotes/ when references collide.
        // The UI already distinguishes namespaces, so keep the actual name.
        name: redactAndLimit(fullName.startsWith('refs/remotes/') ? fullName.slice(13) : shortName, 512),
        hash: redactAndLimit(peeledHash || objectHash, 128),
        subject: redactAndLimit(subject, 4096),
      }
      if (fullName.startsWith('refs/remotes/') && !fullName.endsWith('/HEAD')) remotes.push(entry)
      if (fullName.startsWith('refs/tags/')) tags.push(entry)
    }
    return { ok: true, data: { branches, remotes, tags } }
  }

  async getCommits(workdir: string, limit: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<CommitSummary[]>> {
    const resolvedLimit = typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 30
    const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy)
    if (!topLevel.ok) return topLevel
    const logFormat = '%H%x1f%P%x1f%s%x1f%an%x1f%aI'
    const refFormat = '%(objectname)%09%(*objectname)%09%(refname)%09%(HEAD)%09%(upstream:short)'
    const [result, refsResult] = await Promise.all([
      this.run(workdir, 'git log --date-order -n ' + resolvedLimit + ' --format=' + quoteShellArg(logFormat), 15_000, 80_000, signal, sandboxPolicy),
      this.run(workdir, 'git for-each-ref --format=' + quoteShellArg(refFormat) + ' refs/heads refs/remotes refs/tags', 15_000, 80_000, signal, sandboxPolicy),
    ])
    if (result.exitCode !== 0 || refsResult.exitCode !== 0) {
      return errorResult('GIT_FAILED', '无法读取提交记录', redactAndLimit(outputOf(result) + '\n' + outputOf(refsResult), 8192))
    }
    const refLines = (refsResult.stdout?.text ?? '').split('\n').filter(Boolean).map((line) => line.split('\t'))
    const currentRef = refLines.find((parts) => parts[3] === '*')
    const currentUpstream = currentRef?.[4] ?? ''
    const refsByHash = new Map<string, CommitRefSummary[]>()
    for (const parts of refLines) {
      const [objectHash = '', peeledHash = '', fullName = '', head = ''] = parts
      const hash = peeledHash || objectHash
      let ref: CommitRefSummary | null = null
      if (fullName.startsWith('refs/heads/')) ref = { name: fullName.slice(11), type: 'branch', current: head === '*' }
      else if (fullName.startsWith('refs/remotes/') && !fullName.endsWith('/HEAD')) ref = { name: fullName.slice(13), type: 'remote', current: false }
      else if (fullName.startsWith('refs/tags/')) ref = { name: fullName.slice(10), type: 'tag', current: false }
      const relevant = ref?.type === 'tag' || ref?.current === true || (ref?.type === 'remote' && ref.name === currentUpstream)
      if (!ref || !hash || !relevant) continue
      const safeRef = { ...ref, name: redactAndLimit(ref.name, 512) }
      refsByHash.set(hash, [...(refsByHash.get(hash) ?? []), safeRef])
    }
    const commits = (result.stdout?.text ?? '').split('\n').filter(Boolean).map((line) => {
      const [hash = '', parents = '', subject = '', author = '', date = ''] = line.split('\x1f')
      return {
        hash: redactAndLimit(hash, 128),
        parents: parents.split(' ').filter(Boolean).map((parent) => redactAndLimit(parent, 128)),
        subject: redactAndLimit(subject, 4096),
        author: redactAndLimit(author, 512),
        date: redactAndLimit(date, 128),
        refs: refsByHash.get(hash) ?? [],
      }
    })
    return { ok: true, data: commits }
  }

  async getCommitDetail(workdir: string, hash: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<CommitDetail>> {
    if (!validCommitHash(hash)) return errorResult('INVALID_ARGUMENT', '提交哈希必须是完整的 40 或 64 位十六进制字符')
    const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy)
    if (!topLevel.ok) return topLevel
    const format = '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%b%x1e'
    const metadata = await this.run(
      workdir,
      'git show -s --no-show-signature --format=' + quoteShellArg(format) + ' ' + quoteShellArg(hash),
      15_000,
      COMMIT_DETAIL_MAX_CHARS,
      signal,
      sandboxPolicy,
    )
    if (metadata.exitCode !== 0) return errorResult('GIT_FAILED', '无法读取提交详情', redactAndLimit(outputOf(metadata), 8192))
    const fields = (metadata.stdout?.text ?? '').replace(/\x1e\s*$/, '').split('\x1f')
    const resolvedHash = fields[0] ?? ''
    const parents = (fields[1] ?? '').split(' ').filter(Boolean)
    const comparisonBase = parents[0] ?? null
    const common = '--no-ext-diff --no-textconv --find-renames'
    const range = comparisonBase ? quoteShellArg(comparisonBase) + ' ' + quoteShellArg(resolvedHash) : quoteShellArg(resolvedHash)
    const [nameStatusResult, numstatResult] = await Promise.all([
      this.run(workdir, comparisonBase
        ? 'git diff ' + common + ' --name-status ' + range + ' --'
        : 'git diff-tree --root --no-commit-id --name-status -r -M ' + range + ' --', 20_000, COMMIT_DETAIL_MAX_CHARS, signal, sandboxPolicy),
      this.run(workdir, comparisonBase
        ? 'git diff ' + common + ' --numstat ' + range + ' --'
        : 'git diff-tree --root --no-commit-id --numstat -r -M ' + range + ' --', 20_000, COMMIT_DETAIL_MAX_CHARS, signal, sandboxPolicy),
    ])
    if (nameStatusResult.exitCode !== 0 || numstatResult.exitCode !== 0) {
      return errorResult('GIT_FAILED', '无法读取提交变更摘要', redactAndLimit(outputOf(nameStatusResult) + '\n' + outputOf(numstatResult), 8192))
    }
    const parsed = parseCommitFiles(nameStatusResult.stdout?.text ?? '', numstatResult.stdout?.text ?? '')
    return {
      ok: true,
      data: {
        hash: redactAndLimit(resolvedHash, 128),
        parents: parents.map((parent) => redactAndLimit(parent, 128)),
        authorName: redactAndLimit(fields[2] ?? '', 512),
        authorEmail: redactAndLimit(fields[3] ?? '', 512),
        authoredAt: redactAndLimit(fields[4] ?? '', 128),
        committerName: redactAndLimit(fields[5] ?? '', 512),
        committerEmail: redactAndLimit(fields[6] ?? '', 512),
        committedAt: redactAndLimit(fields[7] ?? '', 128),
        subject: redactAndLimit(fields[8] ?? '', 4096),
        body: redactAndLimit(fields[9] ?? '', 50_000),
        comparisonBase,
        ...parsed,
      },
    }
  }

  async getCommitDiff(workdir: string, hash: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<CommitDiffResult>> {
    if (!validCommitHash(hash)) return errorResult('INVALID_ARGUMENT', '提交哈希必须是完整的 40 或 64 位十六进制字符')
    const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy)
    if (!topLevel.ok) return topLevel
    const parentsResult = await this.run(workdir, 'git show -s --format=%P ' + quoteShellArg(hash), 15_000, 4096, signal, sandboxPolicy)
    if (parentsResult.exitCode !== 0) return errorResult('GIT_FAILED', '无法读取提交父节点', redactAndLimit(outputOf(parentsResult), 8192))
    const comparisonBase = (parentsResult.stdout?.text ?? '').trim().split(' ').filter(Boolean)[0] ?? null
    const common = '--no-ext-diff --no-textconv --find-renames --patch'
    const command = comparisonBase
      ? 'git diff ' + common + ' ' + quoteShellArg(comparisonBase) + ' ' + quoteShellArg(hash) + ' --'
      : 'git show --format= ' + common + ' ' + quoteShellArg(hash) + ' --'
    const result = await this.run(workdir, command, 30_000, COMMIT_DIFF_MAX_CHARS + 1024, signal, sandboxPolicy)
    if (result.exitCode !== 0) return errorResult('GIT_FAILED', '无法读取提交 Diff', redactAndLimit(outputOf(result), 8192))
    const raw = redactSecrets(result.stdout?.text ?? '')
    return {
      ok: true,
      data: { hash, comparisonBase, diff: raw.slice(0, COMMIT_DIFF_MAX_CHARS), truncated: raw.length > COMMIT_DIFF_MAX_CHARS },
    }
  }

  async getStashes(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<StashSummary[]>> {
    const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy)
    if (!topLevel.ok) return topLevel
    const format = '%gd%x1f%H%x1f%gs%x1f%an%x1f%aI'
    const result = await this.run(
      workdir,
      'git stash list --max-count=' + STASH_MAX + ' --format=' + quoteShellArg(format),
      15_000,
      COMMIT_DETAIL_MAX_CHARS,
      signal,
      sandboxPolicy,
    )
    if (result.exitCode !== 0) return errorResult('GIT_FAILED', '无法读取贮藏列表', redactAndLimit(outputOf(result), 8192))
    const stashes = (result.stdout?.text ?? '').split('\n').filter(Boolean).slice(0, STASH_MAX).map((line) => {
      const [selector = '', hash = '', subject = '', author = '', date = ''] = line.split('\x1f')
      return {
        selector: redactAndLimit(selector, 128),
        hash: redactAndLimit(hash, 128),
        subject: redactAndLimit(subject, 4096),
        author: redactAndLimit(author, 512),
        date: redactAndLimit(date, 128),
      }
    })
    return { ok: true, data: stashes }
  }

  private async resolveStash(workdir: string, selector: unknown, hash: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<{ topLevel: string; hash: string; parents: string[] }>> {
    if (typeof selector !== 'string' || !/^stash@\{\d{1,9}\}$/.test(selector) || !validCommitHash(hash)) {
      return errorResult('INVALID_ARGUMENT', '必须提供有效的贮藏编号和完整哈希')
    }
    const root = await this.getTopLevel(workdir, signal, sandboxPolicy)
    if (!root.ok) return root
    const resolved = await this.run(root.data.topLevel, 'git rev-parse --verify ' + quoteShellArg(selector), 15_000, 4096, signal, sandboxPolicy)
    if (resolved.exitCode !== 0 || (resolved.stdout?.text ?? '').trim() !== hash) {
      return errorResult('STATE_CONFLICT', '贮藏列表已经变化，请刷新后重新选择')
    }
    const metadata = await this.run(root.data.topLevel, 'git show -s --format=%P ' + quoteShellArg(hash), 15_000, 4096, signal, sandboxPolicy)
    const parents = (metadata.stdout?.text ?? '').trim().split(' ').filter(validCommitHash)
    if (metadata.exitCode !== 0 || parents.length < 2) return errorResult('GIT_FAILED', '无法读取贮藏父节点')
    return { ok: true, data: { topLevel: root.data.topLevel, hash, parents } }
  }

  async getStashDetail(workdir: string, selector: unknown, hash: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<StashDetail>> {
    const stash = await this.resolveStash(workdir, selector, hash, signal, sandboxPolicy)
    if (!stash.ok) return stash
    const { topLevel, parents } = stash.data
    const commands = ['git diff --no-ext-diff --no-textconv --no-renames --name-status -z ' + quoteShellArg(parents[0]!) + ' ' + quoteShellArg(stash.data.hash) + ' --']
    if (parents[2]) commands.push('git diff-tree --root --no-commit-id --no-renames --name-status -r -z ' + quoteShellArg(parents[2]) + ' --')
    const results = await Promise.all(commands.map((command) => this.run(topLevel, command, 20_000, COMMIT_DETAIL_MAX_CHARS, signal, sandboxPolicy)))
    const failure = results.find((result) => result.exitCode !== 0)
    if (failure) return errorResult('GIT_FAILED', '无法读取贮藏文件', redactAndLimit(outputOf(failure), 8192))
    const files: StashDetail['files'] = []
    let filesTruncated = false
    results.forEach((result, index) => {
      const raw = result.stdout?.text ?? ''
      const parts = raw.split('\0')
      if (raw.length >= COMMIT_DETAIL_MAX_CHARS || (raw && !raw.endsWith('\0'))) filesTruncated = true
      for (let i = 0; i + 2 < parts.length; i += 2) {
        if (files.length >= COMMIT_FILE_MAX) { filesTruncated = true; break }
        files.push({ status: parts[i]!, path: parts[i + 1]!, untracked: index === 1 })
      }
    })
    return { ok: true, data: { hash: stash.data.hash, files, filesTruncated } }
  }

  async getStashDiff(workdir: string, selector: unknown, hash: unknown, path: unknown, untracked: boolean, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<DiffResult>> {
    if (!validStashPath(path)) return errorResult('INVALID_ARGUMENT', '请选择仓库内的文件路径')
    const stash = await this.resolveStash(workdir, selector, hash, signal, sandboxPolicy)
    if (!stash.ok) return stash
    const { topLevel, parents } = stash.data
    if (untracked && !parents[2]) return errorResult('INVALID_ARGUMENT', '该贮藏不包含未跟踪文件')
    const common = '--no-color --no-ext-diff --no-textconv --no-renames --patch '
    const command = untracked
      ? 'git --literal-pathspecs diff-tree --root --no-commit-id -r ' + common + quoteShellArg(parents[2]!)
      : 'git --literal-pathspecs diff ' + common + quoteShellArg(parents[0]!) + ' ' + quoteShellArg(stash.data.hash)
    const result = await this.run(topLevel, command + ' -- ' + quoteShellArg(path), 30_000, DIFF_MAX_CHARS + 1024, signal, sandboxPolicy)
    if (result.exitCode !== 0) return errorResult('GIT_FAILED', '无法读取贮藏 Diff', redactAndLimit(outputOf(result), 8192))
    const raw = redactSecrets(result.stdout?.text ?? '')
    return { ok: true, data: { path, staged: false, diff: raw.slice(0, DIFF_MAX_CHARS), truncated: raw.length > DIFF_MAX_CHARS } }
  }

  async createStash(request: MutationRequest, message: unknown, paths: unknown, includeUntracked: boolean): Promise<ActionResult<RepositorySummary>> {
    if (typeof message !== 'string' || message.length > 4096 || message.includes('\0')) return errorResult('INVALID_ARGUMENT', '贮藏说明不能超过 4096 字符或包含空字符')
    if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.length > 500 || !paths.every(validStashPath))) {
      return errorResult('INVALID_ARGUMENT', '请选择 1–500 个文件，或贮藏全部文件')
    }
    return this.withMutation(request, async () => {
      const result = await this.run(request.workdir, createStashCommand(message, paths as string[] | undefined, includeUntracked), 120_000, MUTATION_OUTPUT_MAX_CHARS, request.signal, request.sandboxPolicy)
      if (result.exitCode !== 0) return errorResult(mutationErrorCode(result), '创建贮藏失败，请刷新确认当前状态', redactAndLimit(outputOf(result), 8192))
      try {
        const response = JSON.parse(result.stdout?.text ?? '') as ActionResult<unknown>
        if (!response.ok) return errorResult(response.code, response.message, redactAndLimit(response.diagnostics ?? '', 8192))
      } catch { return errorResult('GIT_FAILED', '无法确认贮藏创建结果，请刷新') }
      const summary = await this.getSummary(request.workdir, request.signal, request.sandboxPolicy)
      return summary.ok ? { ...summary, operationId: String(request.operationId) } : summary
    })
  }

  async mutateStash(request: MutationRequest, action: 'apply-stash' | 'pop-stash' | 'drop-stash' | 'branch-stash', selector: unknown, hash: unknown, name?: unknown, confirmRisk = false): Promise<ActionResult<RepositorySummary>> {
    if (action === 'drop-stash' && !confirmRisk) return errorResult('PERMISSION_DENIED', '删除贮藏前必须确认其中的改动可能丢失')
    if (action === 'branch-stash' && !validBranchName(name)) return errorResult('INVALID_ARGUMENT', '请输入有效的新分支名')
    return this.withMutation(request, async () => {
      const stash = await this.resolveStash(request.workdir, selector, hash, request.signal, request.sandboxPolicy)
      if (!stash.ok) return stash
      const root = stash.data.topLevel
      // Dropping a stash does not touch the worktree. Other operations must not
      // overlap an unfinished merge/rebase or unresolved stash conflict.
      if (action !== 'drop-stash') {
        const state = await this.conflictAction('get-conflicts', root, {}, undefined, request.sandboxPolicy)
        if (!state.ok) return state as ActionResult<RepositorySummary>
        const data = state.data as { operation: string | null; files: unknown[] }
        if (data.operation || data.files.length) return errorResult('STATE_CONFLICT', '请先完成当前 Git 操作并解决冲突')
        if (action === 'branch-stash') {
          const summary = await this.getSummary(root, request.signal, request.sandboxPolicy)
          if (!summary.ok) return summary
          if (summary.data.files.length) return errorResult('STATE_CONFLICT', '从贮藏创建分支前，请先提交或贮藏当前改动', undefined, 'DIRTY_WORKTREE')
        }
      }
      const command = action === 'branch-stash'
        // Restore the saved index verbatim; apply.whitespace=fix/error must not
        // rewrite its content or reject it during stash branch's --index apply.
        ? 'git -c apply.whitespace=nowarn stash branch ' + quoteShellArg(name as string) + ' ' + quoteShellArg(selector as string)
        : 'git stash ' + ({ 'apply-stash': 'apply', 'pop-stash': 'pop', 'drop-stash': 'drop' } as const)[action] + ' ' + quoteShellArg(action === 'apply-stash' ? stash.data.hash : selector as string)
      const result = await this.run(root, command, 120_000, MUTATION_OUTPUT_MAX_CHARS, request.signal, request.sandboxPolicy)
      if (result.exitCode !== 0) return errorResult(mutationErrorCode(result), '贮藏操作未完成；如有冲突，请在“冲突解决”中处理。失败的弹出会保留贮藏。', redactAndLimit(outputOf(result), 8192))
      const summary = await this.getSummary(root, request.signal, request.sandboxPolicy)
      return summary.ok ? { ...summary, operationId: String(request.operationId) } : summary
    })
  }

  async getSyncState(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<SyncState>> {
    const summary = await this.getSummary(workdir, signal, sandboxPolicy)
    if (!summary.ok) return summary
    const [remoteResult, upstreamResult, rebaseResult] = await Promise.all([
      this.run(workdir, 'git remote', 15_000, 20_000, signal, sandboxPolicy),
      this.run(workdir, 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}', 15_000, 4096, signal, sandboxPolicy),
      this.run(workdir, 'test -d "$(git rev-parse --git-path rebase-merge)" || test -d "$(git rev-parse --git-path rebase-apply)"', 15_000, 4096, signal, sandboxPolicy),
    ])
    if (remoteResult.exitCode !== 0) {
      return errorResult('GIT_FAILED', '无法读取远程仓库', redactAndLimit(outputOf(remoteResult), 8192))
    }
    const remotes = (remoteResult.stdout?.text ?? '').split('\n').map((entry) => redactAndLimit(entry.trim(), 255)).filter(Boolean)
    const upstream = upstreamResult.exitCode === 0
      ? redactAndLimit(upstreamResult.stdout?.text ?? '', 512).trim()
      : ''
    let ahead = 0
    let behind = 0
    if (upstream) {
      const counts = await this.run(workdir, 'git rev-list --left-right --count HEAD...@{upstream}', 15_000, 4096, signal, sandboxPolicy)
      if (counts.exitCode !== 0) return errorResult('GIT_FAILED', '无法计算本地与上游的提交差异', redactAndLimit(outputOf(counts), 8192))
      const [aheadText = '0', behindText = '0'] = (counts.stdout?.text ?? '').trim().split(/\s+/)
      ahead = /^\d+$/.test(aheadText) ? Number(aheadText) : 0
      behind = /^\d+$/.test(behindText) ? Number(behindText) : 0
    }
    const conflicts = conflictCount(summary.data.files)
    return {
      ok: true,
      data: {
        topLevel: summary.data.topLevel,
        branch: summary.data.branch,
        head: summary.data.head,
        upstream,
        remotes,
        ahead,
        behind,
        dirty: summary.data.files.length > 0,
        conflictCount: conflicts,
        rebaseInProgress: rebaseResult.exitCode === 0,
        files: summary.data.files,
      },
    }
  }

  async fetchRemote(request: MutationRequest, remote: unknown): Promise<ActionResult<SyncState>> {
    if (!validRemoteName(remote)) return errorResult('INVALID_ARGUMENT', '远程仓库名称不合法')
    const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy)
    if (!state.ok) return state
    if (!state.data.remotes.includes(remote)) return errorResult('STATE_CONFLICT', '远程仓库不存在', undefined, 'NO_REMOTE')
    return this.mutateSync(request, 'git fetch ' + quoteShellArg(remote), '获取远程更新失败')
  }

  async pullFfOnly(request: MutationRequest): Promise<ActionResult<SyncState>> {
    const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy)
    if (!state.ok) return state
    if (!state.data.branch) return errorResult('STATE_CONFLICT', '分离 HEAD 状态不能直接拉取', undefined, 'DETACHED_HEAD')
    if (!state.data.upstream) return errorResult('STATE_CONFLICT', '当前分支没有上游跟踪分支', undefined, 'NO_UPSTREAM')
    if (state.data.rebaseInProgress) return errorResult('STATE_CONFLICT', 'Rebase 进行中，请先继续或中止', undefined, 'REBASE_IN_PROGRESS')
    if (state.data.conflictCount > 0) return errorResult('STATE_CONFLICT', '存在尚未解决的冲突', undefined, 'CONFLICTS_PRESENT')
    return this.mutateSync(request, 'git pull --ff-only', '拉取远程更新失败')
  }

  async pushCurrent(request: MutationRequest, remote: unknown, branch: unknown, setUpstream: boolean): Promise<ActionResult<SyncState>> {
    const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy)
    if (!state.ok) return state
    if (!state.data.branch) return errorResult('STATE_CONFLICT', '分离 HEAD 状态不能直接推送', undefined, 'DETACHED_HEAD')
    if (state.data.rebaseInProgress) return errorResult('STATE_CONFLICT', 'Rebase 进行中，请先继续或中止', undefined, 'REBASE_IN_PROGRESS')
    if (setUpstream) {
      if (state.data.upstream) return errorResult('STATE_CONFLICT', '当前分支已经有上游，请使用普通推送')
      if (!validRemoteName(remote) || !state.data.remotes.includes(remote)) return errorResult('STATE_CONFLICT', '请选择存在的远程仓库', undefined, 'NO_REMOTE')
      if (!validBranchName(branch) || branch !== state.data.branch) return errorResult('INVALID_ARGUMENT', '只能为当前本地分支建立上游')
      return this.mutateSync(request, 'git push -u ' + quoteShellArg(remote) + ' ' + quoteShellArg(branch), '推送并建立上游失败')
    }
    if (!state.data.upstream) return errorResult('STATE_CONFLICT', '当前分支没有上游跟踪分支', undefined, 'NO_UPSTREAM')
    return this.mutateSync(request, 'git push', '推送失败')
  }

  async rebaseOnto(request: MutationRequest, target: unknown, confirmRisk: boolean): Promise<ActionResult<SyncState>> {
    if (!validBranchName(target)) return errorResult('INVALID_ARGUMENT', 'Rebase 目标必须是安全的本地或远程分支引用')
    if (!confirmRisk) return errorResult('PERMISSION_DENIED', 'Rebase 会重写本地提交历史，执行前必须确认风险')
    const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy)
    if (!state.ok) return state
    if (!state.data.branch) return errorResult('STATE_CONFLICT', '分离 HEAD 状态不能开始 Rebase', undefined, 'DETACHED_HEAD')
    if (state.data.rebaseInProgress) return errorResult('STATE_CONFLICT', '已有 Rebase 正在进行', undefined, 'REBASE_IN_PROGRESS')
    if (state.data.dirty) return errorResult('STATE_CONFLICT', 'Rebase 前需要提交或贮藏工作区改动', undefined, 'DIRTY_WORKTREE')
    const exists = await this.run(request.workdir, 'git rev-parse --verify --quiet ' + quoteShellArg(target + '^{commit}'), 15_000, 4096, request.signal, request.sandboxPolicy)
    if (exists.exitCode !== 0) return errorResult('STATE_CONFLICT', 'Rebase 目标引用不存在', undefined, 'REF_NOT_FOUND')
    return this.mutateSync(request, 'git rebase ' + quoteShellArg(target), 'Rebase 失败')
  }

  async continueRebase(request: MutationRequest, confirmRisk: boolean): Promise<ActionResult<SyncState>> {
    if (!confirmRisk) return errorResult('PERMISSION_DENIED', '继续 Rebase 前必须确认历史重写风险')
    const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy)
    if (!state.ok) return state
    if (!state.data.rebaseInProgress) return errorResult('STATE_CONFLICT', '当前没有正在进行的 Rebase', undefined, 'NO_REBASE_IN_PROGRESS')
    if (state.data.conflictCount > 0) return errorResult('STATE_CONFLICT', '仍有冲突文件，请解决并暂存后再继续', undefined, 'CONFLICTS_PRESENT')
    return this.mutateSync(request, 'git -c core.editor=true rebase --continue', '继续 Rebase 失败')
  }

  async abortRebase(request: MutationRequest, confirmRisk: boolean): Promise<ActionResult<SyncState>> {
    if (!confirmRisk) return errorResult('PERMISSION_DENIED', '中止 Rebase 会丢弃本次变基过程中的修改，执行前必须确认风险')
    const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy)
    if (!state.ok) return state
    if (!state.data.rebaseInProgress) return errorResult('STATE_CONFLICT', '当前没有正在进行的 Rebase', undefined, 'NO_REBASE_IN_PROGRESS')
    return this.mutateSync(request, 'git rebase --abort', '中止 Rebase 失败')
  }

  async stagePaths(request: MutationRequest, paths: unknown): Promise<ActionResult<RepositorySummary>> {
    const valid = this.validatePaths(paths)
    if (!valid.ok) return valid
    return this.mutate(request, 'git add -- ' + valid.data.map(quoteShellArg).join(' '), false, '暂存文件失败')
  }

  async unstagePaths(request: MutationRequest, paths: unknown): Promise<ActionResult<RepositorySummary>> {
    const valid = this.validatePaths(paths)
    if (!valid.ok) return valid
    return this.mutate(request, 'git reset HEAD -- ' + valid.data.map(quoteShellArg).join(' '), false, '取消暂存文件失败')
  }

  async stageAll(request: MutationRequest): Promise<ActionResult<RepositorySummary>> {
    return this.mutate(request, 'git add -A', false, '全部暂存失败')
  }

  async unstageAll(request: MutationRequest): Promise<ActionResult<RepositorySummary>> {
    return this.mutate(request, 'git reset HEAD -- :/', false, '取消全部暂存失败')
  }

  async commit(request: MutationRequest, message: unknown): Promise<ActionResult<RepositorySummary>> {
    if (typeof message !== 'string' || !message.trim() || message.length > 4096 || /[\0\r\n]/.test(message)) {
      return errorResult('INVALID_ARGUMENT', '提交信息必须为 1–4096 个非换行字符')
    }
    return this.mutate(request, 'git commit -m ' + quoteShellArg(message.trim()), true, '提交失败')
  }

  async createBranch(request: MutationRequest, name: unknown, base: unknown): Promise<ActionResult<RepositorySummary>> {
    if (!validBranchName(name) || !validBranchName(base)) return errorResult('INVALID_ARGUMENT', '分支名和基础分支必须是安全的本地 Git 引用')
    const repository = await this.getTopLevel(request.workdir, request.signal, request.sandboxPolicy)
    if (!repository.ok) return repository
    const exists = await this.run(
      request.workdir,
      'git show-ref --verify --quiet ' + quoteShellArg('refs/heads/' + name),
      15_000,
      4096,
      request.signal,
      request.sandboxPolicy,
    )
    if (exists.exitCode === 0) return errorResult('STATE_CONFLICT', '同名本地分支已经存在', undefined, 'BRANCH_EXISTS')
    if (exists.exitCode !== 1) return errorResult('GIT_FAILED', '无法检查目标分支是否存在', redactAndLimit(outputOf(exists), 8192))
    return this.mutate(request, 'git switch -c ' + quoteShellArg(name) + ' ' + quoteShellArg(base), false, '创建分支失败')
  }

  async switchBranch(request: MutationRequest, name: unknown): Promise<ActionResult<RepositorySummary>> {
    if (!validBranchName(name)) return errorResult('INVALID_ARGUMENT', '分支名必须是安全的本地 Git 引用')
    return this.mutate(request, 'git switch ' + quoteShellArg(name), false, '切换分支失败')
  }

  async deleteBranch(request: MutationRequest, name: unknown, force: boolean, confirmRisk: boolean): Promise<ActionResult<RepositorySummary>> {
    if (!validBranchName(name)) return errorResult('INVALID_ARGUMENT', '分支名必须是安全的本地 Git 引用')
    const topLevel = await this.getTopLevel(request.workdir, request.signal, request.sandboxPolicy)
    if (!topLevel.ok) return topLevel
    const [currentResult, existsResult] = await Promise.all([
      this.run(request.workdir, 'git branch --show-current', 15_000, 4096, request.signal, request.sandboxPolicy),
      this.run(request.workdir, 'git show-ref --verify --quiet ' + quoteShellArg('refs/heads/' + name), 15_000, 4096, request.signal, request.sandboxPolicy),
    ])
    if (currentResult.exitCode !== 0) return errorResult('GIT_FAILED', '无法检查当前分支', redactAndLimit(outputOf(currentResult), 8192))
    if (redactAndLimit(currentResult.stdout?.text ?? '', 4096).trim() === name) {
      return errorResult('STATE_CONFLICT', '当前分支不能删除，请先切换到其他分支', undefined, 'CURRENT_BRANCH')
    }
    if (existsResult.exitCode !== 0) return errorResult('STATE_CONFLICT', '要删除的本地分支不存在', undefined, 'BRANCH_NOT_FOUND')
    if (force && !confirmRisk) return errorResult('PERMISSION_DENIED', '强制删除前必须确认未合并提交可能永久丢失')

    const command = 'git branch ' + (force ? '-D' : '-d') + ' -- ' + quoteShellArg(name)
    const deleted = await this.mutate(request, command, false, force ? '强制删除分支失败' : '安全删除分支失败')
    if (deleted.ok || force || deleted.code !== 'GIT_FAILED') return deleted
    const merged = await this.run(request.workdir, 'git merge-base --is-ancestor ' + quoteShellArg(name) + ' HEAD', 15_000, 4096, request.signal, request.sandboxPolicy)
    if (merged.exitCode === 1) {
      return errorResult('STATE_CONFLICT', '分支包含尚未合并的提交，安全删除已拒绝', deleted.diagnostics, 'UNMERGED_BRANCH')
    }
    return deleted
  }

  private validatePaths(paths: unknown): ActionResult<string[]> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS || !paths.every(validPathspec)) {
      return errorResult('INVALID_ARGUMENT', 'paths 必须包含 1–100 个仓库内相对路径')
    }
    return { ok: true, data: paths }
  }

  private mutate(request: MutationRequest, command: string, requiresStagedContent = false, failureMessage = 'Git 操作失败'): Promise<ActionResult<RepositorySummary>> {
    return this.mutateAndRead(request, command, failureMessage, requiresStagedContent, () => this.getSummary(request.workdir, request.signal, request.sandboxPolicy))
  }

  private mutateSync(request: MutationRequest, command: string, failureMessage: string): Promise<ActionResult<SyncState>> {
    return this.mutateAndRead(request, command, failureMessage, false, () => this.getSyncState(request.workdir, request.signal, request.sandboxPolicy))
  }

  private async mutateAndRead<T>(
    request: MutationRequest,
    command: string,
    failureMessage: string,
    requiresStagedContent: boolean,
    readResult: () => Promise<ActionResult<T>>,
  ): Promise<ActionResult<T>> {
    return this.withMutation(request, async () => {
      if (requiresStagedContent) {
        const staged = await this.run(request.workdir, 'git diff --cached --quiet', 15_000, 4096, request.signal, request.sandboxPolicy)
        if (staged.exitCode === 0) return errorResult<T>('STATE_CONFLICT', '没有已暂存的改动，无法提交')
        if (staged.exitCode !== 1) return errorResult<T>('GIT_FAILED', '无法检查暂存区', redactAndLimit(outputOf(staged), 8192))
      }
      const executed = await this.run(request.workdir, command, 120_000, MUTATION_OUTPUT_MAX_CHARS, request.signal, request.sandboxPolicy)
      if (executed.exitCode !== 0) return errorResult<T>(mutationErrorCode(executed), failureMessage, redactAndLimit(outputOf(executed), 8192))
      const result = await readResult()
      return result.ok ? { ...result, operationId: String(request.operationId) } : result
    })
  }

  async conflictAction(action: string, workdir: string, payload: Record<string, unknown>, request?: MutationRequest, sandboxPolicy?: unknown): Promise<ActionResult<unknown>> {
    if (action === 'save-conflict' && (typeof payload.content !== 'string' || Buffer.byteLength(payload.content) > 48 * 1024)) {
      return errorResult('INVALID_ARGUMENT', '结果必须是 48 KiB 以内的文本')
    }
    const run = async (): Promise<ActionResult<unknown>> => {
      const result = await this.run(workdir, conflictWorkerCommand(action, payload), 120_000, 2 * 1024 * 1024, request?.signal, request?.sandboxPolicy ?? sandboxPolicy)
      if (result.exitCode !== 0) return errorResult(mutationErrorCode(result), '冲突操作失败', redactAndLimit(outputOf(result), 8192))
      try {
        const response = JSON.parse(result.stdout?.text ?? '') as ActionResult<unknown>
        if (!response.ok && response.diagnostics) response.diagnostics = redactAndLimit(response.diagnostics, 8192)
        if (!response.ok) response.message = redactAndLimit(response.message, 8192)
        return response
      } catch { return errorResult('GIT_FAILED', '无法读取完整的冲突数据') }
    }
    return request ? this.withMutation(request, run) : run()
  }

  private async withMutation<T>(request: MutationRequest, task: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
    if (!request.sessionId || !request.workdir) return errorResult('SESSION_NOT_FOUND', '无法确定当前会话的仓库目录')
    if (typeof request.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.operationId)) {
      return errorResult('INVALID_ARGUMENT', 'operationId 必须是 1–128 个安全字符')
    }
    this.pruneOperations()
    const repository = await this.getTopLevel(request.workdir, request.signal, request.sandboxPolicy)
    if (!repository.ok) return repository
    const key = request.sessionId + '\u0000' + repository.data.topLevel + '\u0000' + request.operationId
    const existing = this.operations.get(key)
    if (existing) return existing.result as Promise<ActionResult<T>>

    const lockKey = repository.data.topLevel
    const previous = this.locks.get(lockKey) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => current)
    this.locks.set(lockKey, queued)
    const result = previous.then(async () => {
      try {
        return await task()
      } finally {
        release()
        if (this.locks.get(lockKey) === queued) this.locks.delete(lockKey)
      }
    })
    this.operations.set(key, { createdAt: Date.now(), result: result as Promise<ActionResult<unknown>> })
    return result
  }

  private pruneOperations(now = Date.now()): void {
    for (const [key, entry] of this.operations) if (now - entry.createdAt > OPERATION_TTL_MS) this.operations.delete(key)
  }
}
