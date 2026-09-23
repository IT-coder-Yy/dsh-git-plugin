import { GitConflictsTab } from './conflict-tab'
import { GitStashesTab } from './stash-tab'
import { GitMergeTab } from './merge-tab'
import { GitCommitActions } from './commit-actions'
import { parseConflictBlocks, chooseConflictBlock, conflictLineRanges } from './conflict-model'
/**
 * dsh-easygit-plugin Client half as a static Cordis plugin package.
 *
 * The build script wraps this module in Harness's ModuleLoader factory format;
 * source code exports only the Cordis plugin object. Client-to-Host traffic
 * uses same-origin POST /easygit actions. The workbench is mounted in the
 * native right-sidebar tab and controlled from the composer tool row.
 */
const React = require('react')
import { registerWorkbench, requestAgentAnalysis, type Dispose } from './panel-controller'
import {
  appendCommandLog,
  analysisProposalId,
  beginTrackedRequest,
  buildAgentRepairPrompt,
  canDismissFailedProposal,
  buildFileTree,
  cancelTrackedRequest,
  commitFileTone,
  deriveCommitGraph,
  diffLineClass,
  filterLocalBranches,
  failureContext,
  isAbortError,
  isCurrentCommitRequest,
  isLatestRequest,
  isTrackedRequestCurrent,
  mutationCommand,
  nextCommitSelection,
  openRecoveryProposal,
  parseReviewRows,
  pendingProposalTransition,
  recoveryProposalId,
  repositoryName,
  shouldShowAnalysisBanner,
  type AnyRecord,
  type CommandLogEntry,
  type CommitGraphRow,
  type FileTreeNode,
  type RepositoryMutationAction,
  type RequestSlot,
} from './view-model'
import type {
  ActionResult,
  BranchSummary,
  CommitDetail,
  CommitDiffResult,
  CommitSummary,
  DiffResult,
  EasyGitAction,
  EasyGitRequest,
  EasyGitResponse,
  GitFailureContext,
  ProposalExecutionResponse,
  ProposalStateResponse,
  ProposalView,
  ReferenceSummary,
  RepositoryFile,
  RepositorySummary,
  SyncState,
} from '../shared/contracts'

type TimerFn = (callback: () => void, delayMs: number) => Dispose | void

interface GitWorkbenchActionProps {
  sessionId?: unknown
  openWorkbench(sessionId: string): void
  intervalFn?: TimerFn | null
}

interface GitWorkbenchPanelProps {
  sessionId: string
  close: Dispose
  sendPrompt(text: string): Promise<void>
  intervalFn?: TimerFn | null
  timeoutFn?: TimerFn | null
}

interface GitDockProps {
  sessionId?: unknown
  onFailure: FailureHandler
  intervalFn?: TimerFn | null
  timeoutFn?: TimerFn | null
}

interface RepositoryTabProps {
  onConflicts(): void
  sessionId: string
  intervalFn?: TimerFn | null
  revision: number
  onChanged: Dispose
  onCommand: CommandReporter
  onFailure: FailureHandler
}

interface BranchTabProps {
  sessionId: string
  revision: number
  onChanged: Dispose
  onCommand: CommandReporter
  onFailure: FailureHandler
}

type CommandReporter = (label: string, command: string) => (succeeded: boolean) => void
type FailureHandler = (response: AnyRecord) => void
type RefreshState = 'idle' | 'loading' | 'succeeded' | 'failed'

interface CommitTabProps {
  sessionId: string
  revision: number
  onChanged: Dispose
  onCommand: CommandReporter
  onConflicts(): void
}

interface SyncTabProps extends RepositoryTabProps {}

    const RPC_URL = '/easygit'

    function rpc<A extends EasyGitAction>(body: EasyGitRequest<A>, signal?: AbortSignal): Promise<EasyGitResponse<A>> {
      return fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal,
      }).then((r) => r.json() as Promise<EasyGitResponse<A>>)
    }

    function rpcRepositoryMutation(action: RepositoryMutationAction, sessionId: string, payload: AnyRecord = {}): Promise<ActionResult<RepositorySummary>> {
      const request = { action, sessionId, operationId: operationId(action), ...payload } as EasyGitRequest<RepositoryMutationAction>
      return rpc(request) as Promise<ActionResult<RepositorySummary>>
    }

    function errorText(error: unknown): string {
      return error instanceof Error ? error.message : String(error)
    }

    function injectStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById('dsh-easygit-plugin-css')) return () => {}
      const tag = document.createElement('style')
      tag.id = 'dsh-easygit-plugin-css'
      tag.textContent = `
        .gg-conflict-files { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
        .gg-conflict-files button { text-align: left; overflow-wrap: anywhere; }
        .gg-conflict-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 12px 0; overflow-x: auto; }
        .gg-conflict-version { min-width: 0; border: 1px solid rgba(127,127,127,.3); border-radius: 6px; padding: 8px; }
        .gg-conflict-version > strong { display: block; min-height: 40px; line-height: 20px; }
        .gg-conflict-source { min-height: 32px; margin-top: 4px; font-size: 11px; line-height: 16px; color: var(--gg-text-muted); overflow-wrap: anywhere; }
        .gg-conflict-code, .gg-conflict-editor, .gg-conflict-gutter { box-sizing: border-box; margin: 0; font: 12px/20px monospace; tab-size: 4; white-space: pre; }
        .gg-conflict-code { height: 260px; overflow: auto; padding: 8px 0; border: 1px solid transparent; background: var(--gg-surface-inset); }
        .gg-conflict-line { display: block; width: max-content; min-width: 100%; }
        .gg-conflict-edit-surface { display: flex; height: 260px; border: 1px solid rgba(127,127,127,.4); background: var(--gg-surface-inset); }
        .gg-conflict-editor { display: block; min-width: 0; width: 100%; height: 100%; overflow: auto; color: inherit; background: transparent; border: 0; padding: 8px; resize: none; }
        .gg-conflict-line-number { display: inline-block; box-sizing: border-box; min-width: 4em; padding: 0 .75em; color: var(--gg-text-muted); user-select: none; text-align: right; }
        .gg-conflict-gutter { flex: none; height: 100%; overflow: hidden; padding: 8px 0 28px; border-right: 1px solid rgba(127,127,127,.2); }
        .gg-conflict-gutter .gg-conflict-line-number { display: block; height: 20px; }
        .gg-conflict-line-number.unresolved { color: var(--gg-warning-label); background: color-mix(in srgb, var(--gg-warning) 22%, transparent); box-shadow: inset 3px 0 var(--gg-warning); }
        .gg-conflict-block { border-left: 3px solid #d09b38; padding: 10px; margin: 12px 0; background: rgba(127,127,127,.06); }
        .gg-conflict-block-sides { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
        .gg-conflict-block pre { overflow: auto; max-height: 220px; padding: 8px; font: 12px/20px monospace; }
        .gg-dock { margin: 2px 0; padding: 6px 10px; font-size: 13px; line-height: 1.5; color: inherit; }
        .gg-dock-full { border: 1px solid rgba(127,127,127,.35); border-radius: 8px; background: rgba(127,127,127,.06); }
        .gg-idle { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .gg-idletext { opacity: .65; font-size: 12px; }
        .gg-head { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; }
        .gg-toggle { margin-left: auto; padding: 0 8px; font-size: 12px; line-height: 18px; }
        .gg-recovery { margin-top: 8px; }
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
        .gg-expl { opacity: .9; margin: 8px 0; white-space: pre-wrap; }
        .gg-failure-card { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; border: 1px solid rgba(255,108,108,.65); border-radius: 6px; padding: 8px; background: rgba(135,22,22,.12); }
        .gg-failure-row { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .gg-failure-label { color: #ffb0b0; font-size: 11px; font-weight: 600; }
        .gg-failure-value { margin: 0; overflow-x: auto; color: #f1f3f4; white-space: pre-wrap; overflow-wrap: anywhere; }
        .gg-analysis { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; border: 1px solid rgba(255,193,7,.62); border-radius: 6px; padding: 8px; background: rgba(139,101,8,.13); }
        .gg-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .gg-btn { border: 1px solid rgba(180,180,180,.48); border-radius: 4px; padding: 5px 8px; cursor: pointer; font-size: 12px; background: transparent; color: inherit; }
        .gg-btn:disabled { opacity: .45; cursor: not-allowed; }
        .gg-btn.primary { background: rgba(0,197,139,.14); border-color: #00c58b; color: #53f1bc; }
        .gg-btn.danger { background: #c62828; border-color: #c62828; color: #fff; }
        .gg-riskline { font-size: 12px; color: #c62828; margin: 6px 0; }
        .gg-check { display: flex; gap: 6px; align-items: center; cursor: pointer; font-size: 12.5px; margin: 6px 0; }
        .gg-out { margin-top: 8px; font-size: 12px; }
        .gg-ran { margin: 8px 0; }
        .gg-pre { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; background: rgba(127,127,127,.1); border-radius: 6px; padding: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 4px 0; }
        .gg-ok { color: #0a7d33; font-weight: 600; }
        .gg-fail { color: #c62828; font-weight: 600; }
        .gg-workbench-action { position: relative; display: inline-flex; height: 28px; align-items: center; gap: 5px; border: 0; border-radius: 8px; padding: 0 8px; background: transparent; color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; line-height: 20px; font-weight: 500; transition: background-color 100ms ease, box-shadow 100ms ease, color 100ms ease; }
        .gg-workbench-action:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.12)); }
        .gg-workbench-action:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3964fe); outline-offset: 2px; }
        .gg-workbench-action[aria-pressed="true"] { border: 0; background: var(--dsw-alias-button-ghost-active-fill, rgba(127,127,127,.16)); color: var(--dsw-alias-state-business-primary, #3964fe); }
        .gg-workbench-action[aria-pressed="true"]:hover:not(:disabled) { background: var(--dsw-alias-button-ghost-active-hover, rgba(127,127,127,.22)); }
        .gg-workbench-action-dot { width: 6px; height: 6px; border-radius: 50%; background: #e17b00; display: inline-block; }
        .gg-workbench { position: relative; box-sizing: border-box; width: 100%; height: 100%; min-height: 0; min-width: 0; display: flex; flex-direction: column; border-left: 1px solid rgba(174,180,184,.75); color: #e9ecef; background: #202224; box-shadow: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
        .gg-workbench-head { box-sizing: border-box; display: flex; min-height: 75px; flex: none; align-items: center; gap: 8px; padding: 14px 12px 12px; border-bottom: 1px solid #aeb4b8; }
        .gg-workbench-title { font-size: 14px; line-height: 20px; font-weight: 500; color: #f4f4f4; }
        .gg-workbench-close { display: grid; width: 28px; height: 28px; margin-left: auto; place-items: center; border: 0; border-radius: 999px; padding: 0; background: transparent; color: var(--dsw-alias-label-secondary, inherit); }
        .gg-workbench-close:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
        .gg-workbench-body { min-height: 0; flex: 1; overflow: auto; padding: 7px; }
        .gg-command-log { display: flex; min-height: 110px; max-height: 210px; flex: 0 0 auto; flex-direction: column; border-top: 1px solid #aeb4b8; background: #181a1b; }
        .gg-command-log-head { flex: none; padding: 5px 8px 3px; color: #dce1e4; font-size: 11px; }
        .gg-command-log-body { min-height: 0; overflow: auto; padding: 0 8px 6px; }
        .gg-command-entry { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 2px 8px; padding: 3px 0; font-size: 11px; }
        .gg-command-label { overflow: hidden; color: #ff8a24; text-overflow: ellipsis; white-space: nowrap; }
        .gg-command-status { font-size: 10px; }
        .gg-command-status.running { color: #ffd166; }
        .gg-command-status.succeeded { color: #55e58b; }
        .gg-command-status.failed { color: #ff7878; }
        .gg-command-code { grid-column: 1 / -1; overflow-wrap: anywhere; color: #e3e7e9; white-space: pre-wrap; }
        .gg-workbench-error { color: #ff6c6c; font-size: 12px; margin: 2px 0 0; }
        .gg-diagnostics { max-height: 120px; margin: 0; overflow: auto; border: 1px solid rgba(255,108,108,.7); border-radius: 3px; padding: 6px; color: #ffb0b0; background: rgba(135,22,22,.22); font-size: 11px; white-space: pre-wrap; }
        .gg-tabs { display: flex; gap: 4px; overflow-x: auto; border-bottom: 1px solid #aeb4b8; padding-bottom: 7px; }
        .gg-tab { flex: none; border: 1px solid transparent; border-radius: 3px; padding: 4px 7px; background: transparent; color: #d4d9dc; font-size: 12px; cursor: pointer; }
        .gg-tab.active { border-color: #00c58b; color: #54f0bd; background: rgba(0,197,139,.12); }
        .gg-tab-content { display: flex; min-height: 0; flex-direction: column; gap: 8px; padding-top: 8px; }
        .gg-tab-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .gg-change-layout { display: flex; min-width: 0; flex-direction: column; gap: 8px; }
        .gg-change-files { display: flex; min-width: 0; flex-direction: column; gap: 8px; }
        .gg-file-group, .gg-branch-list, .gg-commit-list, .gg-stash-list, .gg-commit-form, .gg-branch-form { display: flex; flex-direction: column; gap: 5px; border: 1px solid rgba(215,220,222,.72); border-radius: 3px; padding: 6px; }
        .gg-file-group > strong { color: #51efba; font-size: 12px; }
        .gg-file-tree { display: flex; flex-direction: column; min-width: 0; }
        .gg-tree-folder { display: flex; flex-direction: column; min-width: 0; }
        .gg-folder-toggle { display: flex; min-width: 0; align-items: center; gap: 4px; border: 0; padding: 4px 2px; background: transparent; color: #dfe7e8; text-align: left; cursor: pointer; font: inherit; font-size: 12px; }
        .gg-folder-arrow { width: 12px; flex: none; color: #85d7c0; }
        .gg-folder-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gg-file, .gg-branch-row { display: flex; min-width: 0; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid rgba(200,200,200,.15); }
        .gg-file.active { background: rgba(0,197,139,.12); }
        .gg-file.added code { color: #55e58b; }
        .gg-file.deleted code { color: #ff7878; }
        .gg-file.modified code { color: #ffd166; }
        .gg-file-path { min-width: 0; flex: 1; overflow: hidden; border: 0; background: transparent; color: inherit; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
        .gg-branch-row code { flex: none; font-size: 11px; }
        .gg-branch-row .gg-idletext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gg-reference-tabs { display: flex; gap: 4px; }
        .gg-local-branches { display: flex; flex-direction: column; gap: 6px; }
        .gg-reference-empty { padding: 6px 0; }
        .gg-reference-row code:first-child { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gg-reference-hash { color: #7f8a91; }
        .gg-branch-row.confirming { flex-wrap: wrap; }
        .gg-branch-confirm { display: flex; width: 100%; flex-direction: column; gap: 5px; padding: 6px; border: 1px solid rgba(198,40,40,.65); border-radius: 4px; background: rgba(198,40,40,.1); }
        .gg-branch-confirm-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .gg-commit-layout { display: flex; min-width: 0; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
        .gg-commit-list { min-width: 0; flex: 1 1 280px; gap: 0; overflow-x: hidden; padding: 4px 2px; }
        .gg-commit-row { display: grid; width: 100%; min-width: 0; min-height: 36px; grid-template-columns: auto minmax(0, 1fr); border: 0; padding: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
        .gg-commit-row:hover, .gg-commit-row.active { background: rgba(0,197,139,.12); }
        .gg-commit-row:focus-visible { outline: 1px solid #00c58b; outline-offset: -1px; }
        .gg-commit-graph { display: block; align-self: stretch; overflow: visible; }
        .gg-commit-copy { display: flex; min-width: 0; flex-direction: column; justify-content: center; padding: 2px 4px 2px 3px; }
        .gg-commit-main { display: flex; min-width: 0; align-items: center; gap: 5px; }
        .gg-commit-subject { min-width: 36px; flex: 0 1 auto; overflow: hidden; color: #e7e9ea; text-overflow: ellipsis; white-space: nowrap; }
        .gg-commit-refs { display: flex; min-width: 0; flex: 0 1 auto; gap: 4px; overflow: hidden; }
        .gg-ref { max-width: 190px; flex: 0 1 auto; overflow: hidden; border: 1px solid currentColor; border-radius: 999px; padding: 0 7px; font-size: 10.5px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
        .gg-ref.branch { color: #62a9ff; background: rgba(56,132,224,.18); }
        .gg-ref.current { color: #83bdff; background: rgba(54,142,247,.34); }
        .gg-ref.remote { color: #ff8a24; background: rgba(230,100,0,.22); }
        .gg-ref.tag { color: #ce8cff; background: rgba(153,73,212,.22); }
        .gg-commit-meta { display: flex; min-width: 0; gap: 7px; color: #8f979d; font-size: 10.5px; }
        .gg-commit-author { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gg-commit-hash { flex: none; color: #737d84; }
        .gg-commit-detail { display: flex; min-width: 0; flex: 1 1 340px; flex-direction: column; gap: 7px; border: 1px solid rgba(215,220,222,.72); border-radius: 3px; padding: 8px; background: #1b1d1f; }
        .gg-commit-detail-head { display: flex; min-width: 0; align-items: flex-start; gap: 8px; }
        .gg-commit-detail-title { min-width: 0; flex: 1; overflow-wrap: anywhere; color: #f0f2f3; }
        .gg-commit-detail-hash { flex: none; color: #879198; font-size: 10.5px; }
        .gg-commit-detail-close { flex: none; min-width: 26px; padding: 1px 6px; }
        .gg-commit-detail-meta { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 8px; font-size: 11px; }
        .gg-commit-detail-meta dt { color: #8f979d; }
        .gg-commit-detail-meta dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
        .gg-commit-message { max-height: 130px; margin: 0; overflow: auto; border-radius: 3px; padding: 6px; background: #151718; color: #d8dde0; white-space: pre-wrap; }
        .gg-commit-summary { display: flex; gap: 9px; color: #aeb8c2; font-size: 11px; flex-wrap: wrap; }
        .gg-additions { color: #55e58b; }
        .gg-deletions { color: #ff7878; }
        .gg-commit-files { display: flex; max-height: 210px; min-width: 0; flex-direction: column; overflow: auto; border: 1px solid rgba(180,180,180,.25); border-radius: 3px; }
        .gg-commit-file { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 6px; padding: 3px 5px; border-bottom: 1px solid rgba(180,180,180,.12); font-size: 11px; }
        .gg-commit-file:last-child { border-bottom: 0; }
        .gg-commit-file.added { color: #55e58b; }
        .gg-commit-file.deleted { color: #ff7878; }
        .gg-commit-file.modified { color: #ffd166; }
        .gg-commit-file-path { min-width: 0; overflow: hidden; color: #d8dde0; text-overflow: ellipsis; white-space: nowrap; }
        .gg-commit-diff { max-height: 430px; overflow: auto; }
        .gg-stash-files { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow: auto; }
        .gg-stash-option { display: flex; align-items: baseline; gap: 8px; padding: 4px; overflow-wrap: anywhere; }
        .gg-stash-option input { flex: none; }
        .gg-stash-option code { white-space: pre; }
        .gg-stash-select { border: 0; background: transparent; text-align: left; font: inherit; cursor: pointer; }
        .gg-stash-select.active, .gg-stash-file.active { background: var(--gg-accent-soft); outline: 1px solid var(--gg-accent); outline-offset: -1px; }
        .gg-stash-select:disabled { cursor: default; opacity: .6; }
        .gg-stash-file { text-align: left; white-space: normal; overflow-wrap: anywhere; }
        .gg-stash-path, .gg-stash-confirm { overflow-wrap: anywhere; }
        .gg-stash-message { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
        .gg-stash-list { gap: 0; }
        .gg-stash-row { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 8px; padding: 6px 3px; border-bottom: 1px solid rgba(180,180,180,.16); }
        .gg-stash-row:last-child { border-bottom: 0; }
        .gg-stash-selector { color: #ce8cff; }
        .gg-stash-subject { min-width: 0; overflow: hidden; color: #e7e9ea; text-overflow: ellipsis; white-space: nowrap; }
        .gg-stash-hash { color: #737d84; font-size: 10.5px; }
        .gg-stash-meta { display: flex; min-width: 0; grid-column: 1 / -1; gap: 8px; color: #8f979d; font-size: 10.5px; }
        .gg-stash-author { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gg-stash-date { flex: none; }
        .gg-input { min-width: 0; width: 100%; box-sizing: border-box; border: 1px solid rgba(200,200,200,.55); border-radius: 3px; padding: 6px 8px; background: #181a1b; color: inherit; font-size: 12px; }
        .gg-sync-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
        .gg-sync-card { display: flex; min-width: 0; flex-direction: column; gap: 4px; border: 1px solid rgba(215,220,222,.45); border-radius: 4px; padding: 7px; background: rgba(127,127,127,.05); }
        .gg-sync-card strong { color: #51efba; font-size: 11px; }
        .gg-sync-value { min-width: 0; overflow-wrap: anywhere; color: #e7e9ea; font-size: 12px; }
        .gg-sync-actions { display: flex; flex-direction: column; gap: 7px; border: 1px solid rgba(215,220,222,.72); border-radius: 3px; padding: 7px; }
        .gg-sync-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; }
        .gg-sync-note { color: #9ca5aa; font-size: 11px; line-height: 1.45; }
        .gg-sync-warning { border: 1px solid rgba(255,193,7,.55); border-radius: 4px; padding: 7px; color: #ffe08a; background: rgba(139,101,8,.13); font-size: 11.5px; }
        .gg-diff { box-sizing: border-box; display: flex; min-width: 0; flex-direction: column; border: 1px solid rgba(215,220,222,.72); border-radius: 3px; padding: 6px; }
        .gg-review-toolbar { display: flex; gap: 5px; align-items: center; margin-bottom: 6px; }
        .gg-review-mode { padding: 3px 6px; font-size: 11px; }
        .gg-review-mode.active { border-color: #00c58b; color: #53f1bc; background: rgba(0,197,139,.12); }
        .gg-review { min-height: 180px; overflow: auto; border-radius: 3px; background: #181a1b; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.55; }
        .gg-review-content, .gg-diff-content { display: block; box-sizing: border-box; width: max-content; min-width: 100%; }
        .gg-review-line { display: grid; box-sizing: border-box; width: 100%; grid-template-columns: 38px 38px minmax(0, 1fr); }
        .gg-review-number { padding: 0 5px; color: #97a2aa; background: rgba(127,127,127,.09); text-align: right; user-select: none; }
        .gg-review-code { min-width: 0; padding: 0 6px; color: #d8dde0; white-space: pre; }
        .gg-review-line.added { color: #b7f6c6; background: rgba(27,142,72,.35); }
        .gg-review-line.deleted { color: #ffb5b5; background: rgba(173,38,38,.38); }
        .gg-review-line.added .gg-review-number, .gg-review-line.added .gg-review-code,
        .gg-review-line.deleted .gg-review-number, .gg-review-line.deleted .gg-review-code { color: inherit; background: transparent; }
        .gg-review-skip { box-sizing: border-box; width: 100%; padding: 4px 8px; color: #ffe18a; background: rgba(181,132,13,.25); font-size: 11px; }
        .gg-review-annotation { box-sizing: border-box; width: 100%; padding: 1px 8px; color: #aeb8c2; background: rgba(132,146,162,.12); font-size: 11px; }
        .gg-diff-code { min-height: 180px; margin: 0; background: #181a1b; color: #d8dde0; white-space: pre; word-break: normal; }
        .gg-diff-code span { display: block; box-sizing: border-box; width: 100%; padding: 0 3px; }
        .gg-diff-meta { color: #aeb8c2; background: rgba(132,146,162,.12); }
        .gg-diff-added { color: #b7f6c6; background: rgba(27,142,72,.35); }
        .gg-diff-deleted { color: #ffb5b5; background: rgba(173,38,38,.38); }
        .gg-diff-modified { color: #ffe18a; background: rgba(181,132,13,.34); }
        .gg-diff-context { color: #d8dde0; }
        @media (min-width: 440px) {
          .gg-change-layout { display: grid; grid-template-columns: minmax(175px, 38%) minmax(0, 1fr); align-items: stretch; }
          .gg-diff { min-height: 0; }
        }

        /* EasyGit visual foundation: dense developer tooling, aligned with the host UI. */
        .gg-workbench {
          --gg-bg: var(--dsw-alias-bg-base, #f7f7f8);
          --gg-surface: var(--dsw-alias-bg-layer-1, #fff);
          --gg-surface-raised: var(--dsw-alias-bg-layer-2, #f1f2f3);
          --gg-surface-inset: var(--dsw-alias-markdown-code-block, var(--gg-surface-raised));
          --gg-border: var(--dsw-alias-border-l2, rgba(15, 17, 21, .12));
          --gg-border-strong: var(--dsw-alias-border-l3, rgba(15, 17, 21, .18));
          --gg-text: var(--dsw-alias-label-primary, #0f1115);
          --gg-text-secondary: var(--dsw-alias-label-secondary, #353638);
          --gg-text-muted: var(--dsw-alias-label-tertiary, #666a70);
          --gg-text-caption: var(--dsw-alias-label-caption, #81858c);
          --gg-accent: var(--dsw-alias-state-business-primary, #3964fe);
          --gg-accent-strong: var(--dsw-alias-state-business-primary, #3964fe);
          --gg-accent-soft: color-mix(in srgb, var(--gg-accent) 14%, transparent);
          --gg-success: var(--dsw-alias-state-success-primary, #169c46);
          --gg-success-label: color-mix(in srgb, var(--gg-success) 64%, var(--gg-text));
          --gg-warning: var(--dsw-alias-state-warn-primary, #b66a00);
          --gg-warning-label: var(--dsw-alias-state-warn-label, #9d5d00);
          --gg-danger: var(--dsw-alias-state-error-primary, #d13f3f);
          --gg-danger-label: color-mix(in srgb, var(--gg-danger) 82%, var(--gg-text));
          --gg-text-subtle: color-mix(in srgb, var(--gg-text-muted) 72%, var(--gg-text));
          --gg-radius: 8px;
          --gg-radius-control: 6px;
          --gg-focus: 0 0 0 2px color-mix(in srgb, var(--gg-accent) 28%, transparent);
          container-name: easygit-workbench;
          container-type: inline-size;
          border-left-color: var(--gg-border-strong);
          color: var(--gg-text);
          background: var(--gg-bg);
          box-shadow: var(--dsw-shadow-lv1, -12px 0 32px rgba(0, 0, 0, .12));
          font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
          font-size: 13px;
          line-height: 1.5;
          color-scheme: inherit;
        }
        .gg-workbench *, .gg-dock * { box-sizing: border-box; }
        .gg-workbench code, .gg-workbench pre, .gg-dock code, .gg-dock pre,
        .gg-command-code, .gg-review, .gg-diff-code, .gg-stepcode {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
        .gg-workbench ::selection, .gg-dock ::selection { color: var(--gg-text, #0f1115); background: color-mix(in srgb, var(--gg-accent, #3964fe) 28%, transparent); }
        .gg-workbench ::-webkit-scrollbar { width: 9px; height: 9px; }
        .gg-workbench ::-webkit-scrollbar-track { background: transparent; }
        .gg-workbench ::-webkit-scrollbar-thumb { border: 3px solid transparent; border-radius: 999px; background: var(--dsw-alias-scrollbar-bg-l2, var(--gg-border-strong)); background-clip: padding-box; }
        .gg-workbench ::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, var(--gg-text-caption)); background-clip: padding-box; }

        .gg-workbench-head {
          min-height: 74px;
          padding: 14px 16px;
          border-bottom-color: var(--gg-border);
          background: var(--gg-bg);
        }
        .gg-workbench-title { color: var(--gg-text); font-size: 16px; line-height: 22px; font-weight: 650; letter-spacing: -.015em; }
        .gg-workbench-close {
          width: 32px;
          height: 32px;
          border-radius: var(--gg-radius-control);
          color: var(--gg-text-muted);
          font-size: 21px;
          line-height: 1;
          transition: color 120ms ease, background-color 120ms ease, transform 120ms ease;
        }
        .gg-workbench-close:hover:not(:disabled) { color: var(--gg-text); background: var(--gg-surface-raised); }
        .gg-workbench-close:active:not(:disabled) { transform: translateY(1px); }
        .gg-workbench-body { padding: 0 12px 12px; }
          background: var(--gg-accent);
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--gg-accent) 18%, transparent);
        }

        .gg-tabs {
          position: sticky;
          top: 0;
          z-index: 2;
          gap: 2px;
          overflow-x: auto;
          margin: 0 -12px;
          padding: 8px 12px 0;
          border-bottom-color: var(--gg-border);
          background: var(--gg-bg);
          scrollbar-width: none;
        }
        .gg-tabs::-webkit-scrollbar { display: none; }
        .gg-tab {
          min-height: 34px;
          border: 0;
          border-bottom: 2px solid transparent;
          border-radius: 0;
          padding: 6px 9px 7px;
          color: var(--gg-text-muted);
          font-size: 12.5px;
          font-weight: 500;
          transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease;
        }
        .gg-tab:hover:not(:disabled) { color: var(--gg-text-secondary); background: var(--dsw-alias-interactive-bg-hover, var(--gg-accent-soft)); }
        .gg-tab.active { border-color: var(--gg-accent); color: var(--gg-text); background: transparent; font-weight: 650; }
        .gg-tab:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: -3px; }
        .gg-tab:active:not(:disabled) { transform: translateY(1px); }
        .gg-tab-content { gap: 12px; padding-top: 12px; }
        .gg-tab-panel { min-height: 0; }
        .gg-tab-toolbar { min-height: 34px; gap: 8px; }
        .gg-tab-toolbar > .gg-idletext:first-child, .gg-repository-identity { margin-right: auto; }
        .gg-section-heading { margin-right: auto; color: var(--gg-text); font-size: 14px; line-height: 22px; font-weight: 680; letter-spacing: -.01em; }
        .gg-section-count { display: inline-grid; min-width: 21px; height: 21px; margin-left: 7px; place-items: center; border-radius: 999px; padding: 0 6px; color: var(--gg-text-secondary); background: var(--gg-surface-raised); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; line-height: 21px; font-weight: 650; }
        .gg-repository-identity { display: flex; min-width: 0; align-items: center; gap: 8px; padding: 2px 0; }
        .gg-repository-name { min-width: 0; overflow: hidden; color: var(--gg-text); font-size: 16px; line-height: 24px; font-weight: 680; letter-spacing: -.015em; text-overflow: ellipsis; white-space: nowrap; }
        .gg-repository-arrow { flex: none; color: var(--gg-text-caption); font-size: 13px; }
        .gg-repository-branch { min-width: 0; overflow: hidden; border-radius: 5px; padding: 2px 6px; color: var(--gg-accent); background: var(--gg-accent-soft); font-size: 13px; line-height: 20px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }

        .gg-btn {
          min-height: 30px;
          border-color: var(--gg-border-strong);
          border-radius: var(--gg-radius-control);
          padding: 5px 10px;
          color: var(--gg-text-secondary);
          background: var(--gg-surface);
          font-family: inherit;
          font-size: 12px;
          line-height: 18px;
          font-weight: 550;
          white-space: nowrap;
          transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
        }
        .gg-btn:hover:not(:disabled) { border-color: var(--gg-border-strong); color: var(--gg-text); background: var(--dsw-alias-interactive-bg-hover, var(--gg-surface-raised)); }
        .gg-btn:focus-visible { outline: none; box-shadow: var(--gg-focus); }
        .gg-btn:active:not(:disabled) { transform: translateY(1px); }
        .gg-btn:disabled { opacity: .42; }
        .gg-btn.primary {
          border-color: var(--dsw-alias-button-primary-fill, var(--gg-accent));
          color: var(--dsw-alias-label-primary-foreground, #fff);
          background: var(--dsw-alias-button-primary-fill, var(--gg-accent));
        }
        .gg-btn.primary:hover:not(:disabled) { border-color: var(--dsw-alias-button-primary-hover, var(--gg-accent-strong)); color: var(--dsw-alias-label-primary-foreground, #fff); background: var(--dsw-alias-button-primary-hover, var(--gg-accent-strong)); }
        .gg-btn.danger { border-color: var(--gg-danger); color: var(--dsw-alias-label-primary-foreground, #fff); background: var(--gg-danger); }
        .gg-btn.danger:hover:not(:disabled) { border-color: var(--gg-danger); color: var(--dsw-alias-label-primary-foreground, #fff); background: color-mix(in srgb, var(--gg-danger) 86%, var(--gg-text)); }
        .gg-review-mode { min-height: 28px; padding: 4px 8px; font-size: 11.5px; }
        .gg-review-mode.active { border-color: var(--gg-accent); color: var(--gg-accent-strong); background: var(--gg-accent-soft); }

        .gg-input, .gg-sync-row select, .gg-sync-actions > select {
          min-height: 34px;
          border: 1px solid var(--gg-border-strong);
          border-radius: var(--gg-radius-control);
          padding: 6px 9px;
          color: var(--gg-text);
          background: var(--gg-surface-inset);
          font-family: inherit;
          font-size: 12px;
          line-height: 20px;
          transition: border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
        }
        .gg-input::placeholder { color: var(--gg-text-muted); opacity: .9; }
        .gg-input:hover:not(:disabled), .gg-sync-row select:hover:not(:disabled), .gg-sync-actions > select:hover:not(:disabled) { border-color: var(--gg-text-caption); }
        .gg-input:focus, .gg-sync-row select:focus, .gg-sync-actions > select:focus {
          outline: none;
          border-color: var(--gg-accent);
          box-shadow: var(--gg-focus);
          background: var(--gg-bg);
        }
        .gg-field { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
        .gg-field-label { color: var(--gg-text-secondary); font-size: 11.5px; line-height: 17px; font-weight: 620; }
        .gg-field-help { color: var(--gg-text-subtle); font-size: 11px; line-height: 16px; }
        .gg-branch-form .gg-btn.primary { align-self: end; }
        .gg-loading { display: grid; min-height: 180px; place-items: center; border: 1px solid var(--gg-border); border-radius: var(--gg-radius); background: var(--gg-surface); }
        .gg-loading-inner { display: flex; width: min(260px, 72%); flex-direction: column; gap: 9px; }
        .gg-loading-label { margin-bottom: 2px; color: var(--gg-text-subtle); font-size: 12px; text-align: center; }
        .gg-loading-bar { height: 8px; border-radius: 999px; background: var(--gg-surface-raised); transform-origin: left center; }
        .gg-loading-bar:nth-child(2) { width: 100%; }
        .gg-loading-bar:nth-child(3) { width: 78%; }
        .gg-loading-bar:nth-child(4) { width: 56%; }
        @media (prefers-reduced-motion: no-preference) {
          .gg-loading-bar { animation: gg-loading-pulse 1.4s ease-in-out infinite alternate; }
          .gg-loading-bar:nth-child(3) { animation-delay: 100ms; }
          .gg-loading-bar:nth-child(4) { animation-delay: 200ms; }
        }
        @keyframes gg-loading-pulse { from { opacity: .45; transform: scaleX(.94); } to { opacity: 1; transform: scaleX(1); } }
        .gg-check { min-height: 30px; gap: 8px; color: var(--gg-text-secondary); }
        .gg-check input { width: 15px; height: 15px; accent-color: var(--gg-accent); }

        .gg-idletext, .gg-intent, .gg-sync-note { color: var(--gg-text-subtle); opacity: 1; }
        .gg-workbench-error, .gg-fail, .gg-riskline { color: var(--gg-danger-label); }
        .gg-ok { color: var(--gg-success-label); }
        .gg-badge { padding: 2px 8px; line-height: 18px; }
        .gg-badge.safe { color: var(--gg-success); background: color-mix(in srgb, var(--gg-success) 12%, transparent); }
        .gg-badge.normal { color: var(--gg-warning-label); background: color-mix(in srgb, var(--gg-warning) 12%, transparent); }
        .gg-badge.hard { color: var(--gg-danger); background: color-mix(in srgb, var(--gg-danger) 12%, transparent); }

        .gg-file-group, .gg-branch-list, .gg-commit-list, .gg-stash-list,
        .gg-commit-form, .gg-branch-form, .gg-sync-actions, .gg-diff, .gg-commit-detail {
          border-color: var(--gg-border);
          border-radius: var(--gg-radius);
          background: var(--gg-surface);
        }
        .gg-file-group, .gg-branch-list, .gg-commit-form, .gg-branch-form, .gg-sync-actions, .gg-diff { padding: 9px; }
        .gg-file-group > strong, .gg-sync-card strong, .gg-sync-actions > strong { color: var(--gg-text-secondary); font-size: 13.5px; line-height: 21px; font-weight: 680; }
        .gg-file-group > strong { display: flex; align-items: center; }
        .gg-folder-toggle { min-height: 30px; border-radius: 5px; color: var(--gg-text-secondary); }
        .gg-folder-toggle:hover { color: var(--gg-text); background: var(--dsw-alias-interactive-bg-hover, var(--gg-accent-soft)); }
        .gg-folder-toggle:focus-visible, .gg-file-path:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; }
        .gg-folder-arrow { color: var(--gg-text-muted); }
        .gg-file, .gg-branch-row { min-height: 34px; border-bottom-color: var(--dsw-alias-border-l1, var(--gg-border)); }
        .gg-file.active { border-radius: 5px; background: var(--gg-accent-soft); }
        .gg-file-path code { color: inherit; font-size: 12.25px; line-height: 19px; }
        .gg-file.added code { color: var(--gg-success-label); }
        .gg-file.deleted code { color: var(--gg-danger-label); }
        .gg-file.modified code { color: var(--gg-warning); }
        .gg-branch-row.current { border-radius: 6px; padding-right: 6px; padding-left: 6px; background: var(--gg-accent-soft); }
        .gg-branch-row.current > code:first-child { color: var(--gg-accent); font-size: 13px; font-weight: 700; }
        .gg-reference-hash { color: var(--gg-text-caption); }

        .gg-sync-grid { gap: 8px; }
        .gg-sync-card { min-height: 68px; border-color: var(--gg-border); border-radius: var(--gg-radius); padding: 10px; background: var(--gg-surface); }
        .gg-sync-value { color: var(--gg-text); font-size: 14px; line-height: 21px; font-weight: 620; }
        .gg-sync-row { align-items: end; }
        .gg-sync-warning, .gg-analysis, .gg-failure-card, .gg-branch-confirm, .gg-diagnostics {
          border-radius: var(--gg-radius);
        }
        .gg-sync-warning { border-color: color-mix(in srgb, var(--gg-warning) 34%, transparent); color: var(--gg-warning-label); background: color-mix(in srgb, var(--gg-warning) 8%, transparent); }
        .gg-analysis { border-color: color-mix(in srgb, var(--gg-warning) 34%, transparent); background: color-mix(in srgb, var(--gg-warning) 7%, transparent); }
        .gg-failure-card, .gg-branch-confirm, .gg-diagnostics { border-color: color-mix(in srgb, var(--gg-danger) 38%, transparent); background: color-mix(in srgb, var(--gg-danger) 7%, transparent); }

        .gg-review, .gg-diff-code, .gg-pre, .gg-commit-message { border-radius: 6px; background: var(--gg-surface-inset); }
        .gg-diff > .gg-intent { color: var(--gg-text); font-size: 13.5px; line-height: 21px; font-weight: 650; }
        .gg-review { line-height: 1.6; }
        .gg-review-number { color: var(--gg-text-caption); background: color-mix(in srgb, var(--gg-text) 3%, transparent); }
        .gg-review-code, .gg-diff-context { color: var(--gg-text-secondary); }
        .gg-review-line.added, .gg-diff-added { color: var(--gg-success-label); background: color-mix(in srgb, var(--gg-success) 18%, transparent); }
        .gg-review-line.deleted, .gg-diff-deleted { color: var(--gg-danger-label); background: color-mix(in srgb, var(--gg-danger) 18%, transparent); }
        .gg-review-skip, .gg-diff-modified { color: var(--gg-warning-label); background: color-mix(in srgb, var(--gg-warning) 14%, transparent); }
        .gg-review-annotation, .gg-diff-meta { color: var(--gg-text-muted); background: color-mix(in srgb, var(--gg-text) 5%, transparent); }

        .gg-command-log { min-height: 144px; max-height: 260px; border-top-color: var(--gg-border); background: var(--gg-surface-inset); }
        .gg-command-log-head { padding: 8px 12px 4px; color: var(--gg-text-secondary); font-size: 11.5px; letter-spacing: .01em; }
        .gg-command-log-body { padding: 0 12px 9px; }
        .gg-command-entry { padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, var(--gg-border)); }
        .gg-command-entry:last-child { border-bottom: 0; }
        .gg-command-label { color: var(--gg-warning); }
        .gg-command-status.running { color: var(--gg-warning); }
        .gg-command-status.succeeded { color: var(--gg-success-label); }
        .gg-command-status.failed { color: var(--gg-danger-label); }
        .gg-command-code { color: var(--gg-text-secondary); }

        .gg-head { color: var(--gg-text); font-size: 14px; line-height: 22px; font-weight: 680; }
        .gg-stepcode { color: var(--gg-text-secondary); background: var(--gg-surface-raised); }
        .gg-failure-label { color: var(--gg-danger-label); }
        .gg-failure-value, .gg-diagnostics { color: var(--gg-text-secondary); }
        .gg-commit-row:hover, .gg-commit-row.active { background: var(--gg-accent-soft); }
        .gg-commit-row:focus-visible { outline-color: var(--gg-accent); }
        .gg-commit-subject { color: var(--gg-text); font-size: 13.25px; line-height: 19px; font-weight: 620; }
        .gg-commit-meta, .gg-commit-detail-meta dt, .gg-commit-summary, .gg-stash-meta { color: var(--gg-text-muted); }
        .gg-commit-hash, .gg-commit-detail-hash, .gg-stash-hash { color: var(--gg-text-caption); }
        .gg-commit-detail-title { color: var(--gg-text); font-size: 15px; line-height: 22px; font-weight: 680; }
        .gg-commit-message, .gg-commit-file-path { color: var(--gg-text-secondary); }
        .gg-commit-files { border-color: var(--gg-border); border-radius: 6px; }
        .gg-commit-file, .gg-stash-row { border-bottom-color: var(--dsw-alias-border-l1, var(--gg-border)); }
        .gg-commit-file.added, .gg-additions { color: var(--gg-success-label); }
        .gg-commit-file.deleted, .gg-deletions { color: var(--gg-danger-label); }
        .gg-commit-file.modified { color: var(--gg-warning); }
        .gg-stash-selector { color: var(--gg-accent); font-size: 12.5px; font-weight: 650; }
        .gg-stash-subject { color: var(--gg-text); font-size: 13px; line-height: 20px; font-weight: 580; }
        .gg-ref.branch, .gg-ref.current { color: var(--gg-accent); background: var(--gg-accent-soft); }
        .gg-ref.remote { color: var(--gg-warning-label); background: color-mix(in srgb, var(--gg-warning) 12%, transparent); }
        .gg-ref.tag { color: color-mix(in srgb, #9d5bd2 72%, var(--gg-text)); background: color-mix(in srgb, #9d5bd2 12%, transparent); }

        .gg-dock-full { border-color: var(--gg-border, rgba(127, 127, 127, .35)); border-radius: var(--gg-radius, 8px); background: var(--gg-surface, rgba(127, 127, 127, .06)); }
        .gg-workbench-action:active:not(:disabled) { transform: translateY(1px); }

        /* Container width, not viewport width, decides when the two-pane change view is safe. */
        .gg-change-layout { display: flex; }
        @container easygit-workbench (min-width: 560px) {
          .gg-change-layout { display: grid; grid-template-columns: minmax(210px, 36%) minmax(0, 1fr); align-items: stretch; }
          .gg-diff { min-height: 0; }
        }
        @container easygit-workbench (max-width: 380px) {
          .gg-workbench-head { min-height: 74px; padding: 11px 12px; }
          .gg-workbench-body { padding-right: 8px; padding-left: 8px; }
          .gg-tabs { margin-right: -8px; margin-left: -8px; padding-right: 8px; padding-left: 8px; }
          .gg-tab { padding-right: 8px; padding-left: 8px; }
          .gg-sync-grid { grid-template-columns: 1fr; }
        }
        @container easygit-workbench (max-width: 520px) {
          .gg-tab-toolbar .gg-repository-identity, .gg-tab-toolbar .gg-section-heading { width: 100%; flex-basis: 100%; }
          .gg-repository-name { font-size: 15px; }
          .gg-branch-form { display: grid; grid-template-columns: 1fr; }
          .gg-branch-form .gg-btn.primary { width: 100%; }
          .gg-sync-row { grid-template-columns: 1fr; }
        }

        @media (prefers-reduced-motion: reduce) {
          .gg-workbench *, .gg-workbench *::before, .gg-workbench *::after,
          .gg-dock *, .gg-dock *::before, .gg-dock *::after {
            scroll-behavior: auto !important;
            transition-duration: .01ms !important;
            animation-duration: .01ms !important;
            animation-iteration-count: 1 !important;
          }
        }
      `
      document.head.appendChild(tag)
      return () => { try { tag.remove() } catch (e) { /* ignore */ } }
    }

    function GitWorkbenchAction(props: GitWorkbenchActionProps) {
      const sessionId = String(props.sessionId || '')
      const intervalFn = props.intervalFn || null
      const [error, setError] = React.useState('')
      const openWorkbench = () => {
        try { props.openWorkbench(sessionId); setError('') }
        catch (caught) { setError(errorText(caught)) }
      }
      const [pending, setPending] = React.useState(false)
      const pendingProposalId = React.useRef(null)
      const stateRequestRef = React.useRef({ controller: null, sequence: 0 } as RequestSlot)

      React.useEffect(() => {
        const refresh = () => {
          const request = beginTrackedRequest(stateRequestRef)
          rpc({ action: 'state', sessionId }, request.signal)
            .then((res) => {
              if (!isTrackedRequestCurrent(stateRequestRef, request) || !res || res.ok !== true) return
              const proposal = res.proposal
              const isPending = !!(proposal && proposal.status === 'pending' && proposal.proposalId)
              setPending(isPending)
              const proposalId = isPending ? proposal.proposalId : null
              if (proposalId && proposalId !== pendingProposalId.current) openWorkbench()
              pendingProposalId.current = proposalId
            })
            .catch((error) => {
              if (isTrackedRequestCurrent(stateRequestRef, request) && !isAbortError(error)) setPending(false)
            })
        }
        refresh()
        const stop = intervalFn ? intervalFn(refresh, 1500) : null
        return () => {
          cancelTrackedRequest(stateRequestRef)
          if (typeof stop === 'function') {
            try { stop() } catch (err) { /* ignore */ }
          }
        }
      }, [props.openWorkbench, intervalFn, sessionId])

      return React.createElement('button', {
        type: 'button',
        className: 'gg-btn gg-workbench-action',
        title: error || '打开 Git 工作台',
        'aria-label': error || 'Git 工作台',
        disabled: !sessionId,
        onClick: openWorkbench,
      },
      React.createElement('span', null, 'Git'),
      pending ? React.createElement('span', { className: 'gg-workbench-action-dot', 'aria-hidden': true }) : null,
      )
    }

    function actionError(response: AnyRecord): string {
      return String(response && (response.message || response.error) || '请求失败')
    }

    function actionDiagnostics(response: AnyRecord): string {
      return typeof (response && response.diagnostics) === 'string' ? response.diagnostics : ''
    }

    function failureError(failure: GitFailureContext): string {
      const message = String(failure.message || '').trim()
      const stderr = String(failure.stderr || '').trim()
      if (!stderr || stderr === message) return message || '（无错误输出）'
      return message ? message + '\n' + stderr : stderr
    }

    function renderFailureDetails(failure: GitFailureContext, recoveryReason = '') {
      const details = [
        '错误码：' + String(failure.code || 'GIT_FAILED'),
        '退出码：' + (failure.exitCode === null ? '未提供' : String(failure.exitCode)),
        failure.timedOut ? '命令已超时' : '',
        failure.mayHavePartialChanges ? '命令可能已部分修改仓库' : '',
        failure.stdout ? '\n[stdout]\n' + failure.stdout : '',
        failure.stderr ? '\n[stderr]\n' + failure.stderr : '',
        failure.diagnostics ? '\n[失败后仓库诊断]\n' + failure.diagnostics : '',
      ].filter(Boolean).join('\n')
      return React.createElement('div', { className: 'gg-failure-card' },
        React.createElement('div', { className: 'gg-failure-row' },
          React.createElement('strong', { className: 'gg-failure-label' }, '原命令'),
          React.createElement('code', { className: 'gg-stepcode gg-failure-value' }, String(failure.command || '')),
        ),
        React.createElement('div', { className: 'gg-failure-row' },
          React.createElement('strong', { className: 'gg-failure-label' }, '错误'),
          React.createElement('pre', { className: 'gg-failure-value' }, failureError(failure)),
        ),
        recoveryReason ? React.createElement('div', { className: 'gg-failure-row' },
          React.createElement('strong', { className: 'gg-failure-label' }, '修正原因'),
          React.createElement('div', { className: 'gg-failure-value' }, recoveryReason),
        ) : null,
        React.createElement('details', null,
          React.createElement('summary', { className: 'gg-failure-label' }, '完整错误与仓库诊断'),
          React.createElement('pre', { className: 'gg-pre' }, details),
        ),
      )
    }

    function refreshButtonLabel(state: RefreshState): string {
      if (state === 'loading') return '正在刷新…'
      if (state === 'succeeded') return '已刷新'
      if (state === 'failed') return '刷新失败'
      return '刷新'
    }

    function useManualRefreshFeedback() {
      const [state, setState] = React.useState('idle' as RefreshState)
      const resetTimerRef = React.useRef(null as number | null)
      const clearResetTimer = () => {
        if (resetTimerRef.current === null) return
        window.clearTimeout(resetTimerRef.current)
        resetTimerRef.current = null
      }
      const begin = () => {
        clearResetTimer()
        setState('loading')
      }
      const finish = (succeeded: boolean) => {
        clearResetTimer()
        setState(succeeded ? 'succeeded' : 'failed')
        resetTimerRef.current = window.setTimeout(() => {
          resetTimerRef.current = null
          setState('idle')
        }, 1200)
      }
      React.useEffect(() => clearResetTimer, [])
      return { state, begin, finish }
    }

    function operationId(prefix: string): string {
      return 'ui:' + prefix + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10)
    }

    function renderDiff(diff: string) {
      return diff.split('\n').map((line, index) => React.createElement('span', { className: diffLineClass(line), key: 'diff-' + index }, line || ' '))
    }

    function renderReview(diff: string) {
      const rows = parseReviewRows(diff)
      if (!rows.length) return React.createElement('div', { className: 'gg-idletext' }, diff ? '没有可审阅的代码行。' : '没有可显示的差异。')
      return rows.map((row, index) => {
        if (row.kind === 'skipped') return React.createElement('div', { className: 'gg-review-skip', key: 'review-' + index }, '⌄ ' + row.text)
        if (row.kind === 'annotation') return React.createElement('div', { className: 'gg-review-annotation', key: 'review-' + index }, row.text)
        return React.createElement('div', { className: 'gg-review-line ' + row.kind, key: 'review-' + index },
          React.createElement('span', { className: 'gg-review-number' }, row.oldNumber === null ? '' : String(row.oldNumber)),
          React.createElement('span', { className: 'gg-review-number' }, row.newNumber === null ? '' : String(row.newNumber)),
          React.createElement('code', { className: 'gg-review-code' }, row.text || ' '),
        )
      })
    }

    function renderRawDiffSurface(diff: string) {
      return React.createElement('code', { className: 'gg-diff-content' }, renderDiff(diff))
    }

    function renderReviewSurface(diff: string) {
      return React.createElement('div', { className: 'gg-review-content' }, renderReview(diff))
    }

    function renderRepositoryIdentity(topLevel: unknown, branch: unknown) {
      const name = repositoryName(topLevel)
      const currentBranch = String(branch || '分离 HEAD')
      return React.createElement('div', {
        className: 'gg-repository-identity',
        'aria-label': name + '，当前分支 ' + currentBranch,
      },
      React.createElement('span', { className: 'gg-repository-name', title: name }, name),
      React.createElement('span', { className: 'gg-repository-arrow', 'aria-hidden': 'true' }, '→'),
      React.createElement('code', { className: 'gg-repository-branch', title: currentBranch }, currentBranch),
      )
    }

    function renderLoadingState(label: string) {
      return React.createElement('div', { className: 'gg-loading', role: 'status', 'aria-live': 'polite' },
        React.createElement('div', { className: 'gg-loading-inner' },
          React.createElement('span', { className: 'gg-loading-label' }, label),
          React.createElement('span', { className: 'gg-loading-bar', 'aria-hidden': 'true' }),
          React.createElement('span', { className: 'gg-loading-bar', 'aria-hidden': 'true' }),
          React.createElement('span', { className: 'gg-loading-bar', 'aria-hidden': 'true' }),
        ),
      )
    }

    function GitChangesTab(props: RepositoryTabProps) {
      const { sessionId, intervalFn, revision, onChanged, onCommand, onFailure } = props
      const [summary, setSummary] = React.useState(null as RepositorySummary | null)
      const [selected, setSelected] = React.useState(null as { path: string; staged: boolean } | null)
      const [diff, setDiff] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [diagnostics, setDiagnostics] = React.useState('')
      const [commitMessage, setCommitMessage] = React.useState('')
      const [collapsedFolders, setCollapsedFolders] = React.useState({})
      const [reviewMode, setReviewMode] = React.useState('review')
      const refreshFeedback = useManualRefreshFeedback()
      const selectedRef = React.useRef(null as { path: string; staged: boolean } | null)
      const manualRefreshRef = React.useRef(false)
      const summaryRequestRef = React.useRef({ controller: null, sequence: 0 } as RequestSlot)
      const diffRequestRef = React.useRef({ controller: null, sequence: 0 } as RequestSlot)

      const loadDiff = (selection: { path: string; staged: boolean }, showLoading = true): Promise<boolean> => {
        if (showLoading) setDiff('正在加载差异…')
        const request = beginTrackedRequest(diffRequestRef)
        return rpc({ action: 'get-diff', sessionId, path: selection.path, staged: selection.staged }, request.signal)
          .then((response) => {
            if (!isTrackedRequestCurrent(diffRequestRef, request)) return false
            if (response && response.ok === true) {
              setDiff(String(response.data.diff || '没有可显示的差异。'))
              return true
            }
            setDiff(actionError(response))
            return false
          })
          .catch((error) => {
            if (!isTrackedRequestCurrent(diffRequestRef, request) || isAbortError(error)) return false
            setDiff(errorText(error))
            return false
          })
      }

      const refreshSelection = (nextSummary: RepositorySummary, refreshDiff = false): Promise<boolean> => {
        const selection = selectedRef.current
        if (!selection) return Promise.resolve(true)
        const file = nextSummary.files.find((entry) => entry.path === selection.path)
        if (!file) {
          cancelTrackedRequest(diffRequestRef)
          selectedRef.current = null
          setSelected(null)
          setDiff('')
          return Promise.resolve(true)
        }
        const staged = !/^(?:DD|AU|UD|UA|DU|AA|UU)$/.test(file.indexStatus + file.workTreeStatus)
          && !!file.indexStatus && file.indexStatus !== ' ' && file.indexStatus !== '?'
        const unstaged = (!!file.workTreeStatus && file.workTreeStatus !== ' ') || file.indexStatus === '?'
        const next = { path: selection.path, staged: selection.staged ? staged : !unstaged }
        if (next.staged === selection.staged && !refreshDiff) return Promise.resolve(true)
        selectedRef.current = next
        setSelected(next)
        return loadDiff(next)
      }

      const load = (manual = false): Promise<boolean> => {
        if (!manual && manualRefreshRef.current) return Promise.resolve(false)
        if (manual) {
          manualRefreshRef.current = true
          refreshFeedback.begin()
        }
        const request = beginTrackedRequest(summaryRequestRef)
        const summaryLoad = rpc({ action: 'get-summary', sessionId }, request.signal)
          .then((response) => {
            if (!isTrackedRequestCurrent(summaryRequestRef, request)) return false
            if (response && response.ok === true) {
              setSummary(response.data)
              setMessage('')
              setDiagnostics('')
              return refreshSelection(response.data, manual)
            } else {
              setMessage(actionError(response))
              setDiagnostics(actionDiagnostics(response))
              return false
            }
          })
          .catch((error) => {
            if (!isTrackedRequestCurrent(summaryRequestRef, request) || isAbortError(error)) return false
            setMessage(errorText(error))
            setDiagnostics('')
            return false
          })
        return summaryLoad.then((succeeded) => {
          const current = isTrackedRequestCurrent(summaryRequestRef, request)
          if (manual && current) refreshFeedback.finish(succeeded)
          if (manual) manualRefreshRef.current = false
          return current && succeeded
        })
      }

      React.useEffect(() => {
        load()
        const stop = intervalFn ? intervalFn(load, 1800) : null
        return () => {
          cancelTrackedRequest(summaryRequestRef)
          if (typeof stop === 'function') stop()
        }
      }, [sessionId, intervalFn, revision])

      React.useEffect(() => {
        cancelTrackedRequest(diffRequestRef)
        selectedRef.current = null
        setSelected(null)
        setDiff('')
      }, [sessionId])

      React.useEffect(() => () => {
        cancelTrackedRequest(summaryRequestRef)
        cancelTrackedRequest(diffRequestRef)
      }, [])

      const runMutation = (action: RepositoryMutationAction, payload: AnyRecord = {}) => {
        const description = mutationCommand(action, payload)
        const completeCommand = description ? onCommand(description.label, description.command) : null
        setBusy(true)
        setMessage('')
        setDiagnostics('')
        return rpcRepositoryMutation(action, sessionId, payload)
          .then((response) => {
            if (!response || response.ok !== true) {
              if (completeCommand) completeCommand(false)
              setMessage(actionError(response))
              setDiagnostics(actionDiagnostics(response))
              onFailure(response as AnyRecord)
              return false
            }
            else {
              if (completeCommand) completeCommand(true)
              cancelTrackedRequest(summaryRequestRef)
              setSummary(response.data)
              void refreshSelection(response.data, true)
              onChanged()
              return true
            }
          })
          .catch((error) => { if (completeCommand) completeCommand(false); setMessage(errorText(error)); setDiagnostics(''); return false })
          .then((succeeded: boolean) => { setBusy(false); return succeeded })
      }

      const selectFile = (file: RepositoryFile, staged: boolean) => {
        const path = String(file.path || '')
        if (!path) return
        const selection = { path, staged }
        selectedRef.current = selection
        setSelected(selection)
        void loadDiff(selection)
      }

      const files: RepositoryFile[] = summary && Array.isArray(summary.files) ? summary.files : []
      const isConflict = (file: RepositoryFile) => /^(?:DD|AU|UD|UA|DU|AA|UU)$/.test(file.indexStatus + file.workTreeStatus)
      const hasConflicts = files.some(isConflict)
      const stagedFiles = files.filter((file) => !isConflict(file) && file.indexStatus && file.indexStatus !== ' ' && file.indexStatus !== '?')
      const unstagedFiles = files.filter((file) => (file.workTreeStatus && file.workTreeStatus !== ' ') || file.indexStatus === '?')
      const fileRow = (file: RepositoryFile, staged: boolean, key: string, depth: number) => {
        const status = String(file.indexStatus || ' ') + String(file.workTreeStatus || ' ')
        const tone = /[?A]/.test(status) ? ' added' : /D/.test(status) ? ' deleted' : ' modified'
        const active = !!(selected && selected.path === file.path && selected.staged === staged)
        return React.createElement('div', { className: 'gg-file' + tone + (active ? ' active' : ''), key, style: { paddingLeft: 4 + depth * 14 } },
        React.createElement('button', { className: 'gg-file-path', type: 'button', onClick: () => selectFile(file, staged) },
          React.createElement('code', null, status + ' ' + String(file.path || '')),
        ),
        React.createElement('button', {
          className: 'gg-btn', disabled: busy,
          onClick: () => isConflict(file) ? props.onConflicts() : runMutation(staged ? 'unstage-paths' : 'stage-paths', { paths: [String(file.path || '')] }),
        }, isConflict(file) ? '解决冲突' : staged ? '取消暂存' : '暂存'),
        )
      }

      const renderFileTree = (groupFiles: RepositoryFile[], staged: boolean, group: string) => {
        const countFiles = (node: FileTreeNode): number => node.files.length + node.folders.reduce((total, folder) => total + countFiles(folder), 0)
        const renderNode = (node: FileTreeNode, depth: number): unknown[] => {
          const entries: unknown[] = []
          for (const folder of node.folders) {
            const folderKey = group + ':' + folder.path
            const collapsed = collapsedFolders[folderKey] === true
            entries.push(React.createElement('div', { className: 'gg-tree-folder', key: folderKey },
              React.createElement('button', {
                className: 'gg-folder-toggle', type: 'button', 'aria-expanded': !collapsed,
                style: { paddingLeft: 2 + depth * 14 },
                onClick: () => setCollapsedFolders((current: AnyRecord) => ({ ...current, [folderKey]: !current[folderKey] })),
              },
              React.createElement('span', { className: 'gg-folder-arrow', 'aria-hidden': true }, collapsed ? '›' : '⌄'),
              React.createElement('span', { className: 'gg-folder-name' }, folder.name + ' (' + countFiles(folder) + ')'),
              ),
              collapsed ? null : renderNode(folder, depth + 1),
            ))
          }
          for (const file of node.files) entries.push(fileRow(file, staged, group + ':' + String(file.path || ''), depth))
          return entries
        }
        return React.createElement('div', { className: 'gg-file-tree' }, renderNode(buildFileTree(groupFiles), 0))
      }

      return React.createElement('section', { className: 'gg-tab-content' },
        React.createElement('div', { className: 'gg-tab-toolbar' },
          summary
            ? renderRepositoryIdentity(summary.topLevel, summary.branch || summary.head)
            : React.createElement('span', { className: 'gg-section-heading' }, '正在读取仓库…'),
          React.createElement('button', {
            className: 'gg-btn', disabled: busy || refreshFeedback.state === 'loading',
            onClick: () => { void load(true) },
          }, refreshButtonLabel(refreshFeedback.state)),
          React.createElement('button', { className: 'gg-btn', type: 'button', onClick: props.onConflicts }, '解决冲突 / Merge / Cherry-pick'),
          React.createElement('button', { className: 'gg-btn', disabled: busy || !summary || hasConflicts, title: hasConflicts ? '请先解决并标记冲突文件' : undefined, onClick: () => runMutation('stage-all') }, '全部暂存'),
          React.createElement('button', { className: 'gg-btn', disabled: busy || !summary, onClick: () => runMutation('unstage-all') }, '全部取消暂存'),
        ),
        message ? React.createElement('div', { className: 'gg-workbench-error' }, message) : null,
        diagnostics ? React.createElement('pre', { className: 'gg-diagnostics' }, diagnostics) : null,
        summary ? React.createElement('div', { className: 'gg-change-layout' },
          React.createElement('div', { className: 'gg-change-files' },
            React.createElement('div', { className: 'gg-file-group' },
              React.createElement('strong', null, '未暂存', React.createElement('span', { className: 'gg-section-count' }, String(unstagedFiles.length))),
              unstagedFiles.length ? renderFileTree(unstagedFiles, false, 'unstaged') : React.createElement('div', { className: 'gg-idletext' }, '没有未暂存的变更。'),
            ),
            React.createElement('div', { className: 'gg-file-group' },
              React.createElement('strong', null, '已暂存', React.createElement('span', { className: 'gg-section-count' }, String(stagedFiles.length))),
              stagedFiles.length ? renderFileTree(stagedFiles, true, 'staged') : React.createElement('div', { className: 'gg-idletext' }, '没有已暂存的变更。'),
            ),
            React.createElement('div', { className: 'gg-commit-form' },
              React.createElement('label', { className: 'gg-field', htmlFor: 'gg-commit-message' },
                React.createElement('span', { className: 'gg-field-label' }, '提交说明'),
                React.createElement('input', {
                  id: 'gg-commit-message', className: 'gg-input', value: commitMessage, placeholder: '例如：fix: 修复登录状态', disabled: busy,
                  onChange: (event: AnyRecord) => setCommitMessage(String(event.target.value || '')),
                }),
              ),
              React.createElement('button', {
                className: 'gg-btn primary', disabled: busy || hasConflicts || !commitMessage.trim() || stagedFiles.length === 0,
                onClick: () => runMutation('commit', { message: commitMessage }).then((succeeded: boolean) => { if (succeeded) setCommitMessage('') }),
              }, '提交'),
            ),
            React.createElement(GitCommitActions, { key: sessionId, sessionId, revision, rpc, disabled: busy, onBusy: setBusy, onChanged, onCommand, onConflicts: props.onConflicts }),
          ),
          React.createElement('div', { className: 'gg-diff' },
            React.createElement('div', { className: 'gg-intent' }, selected ? String(selected.path) + (selected.staged ? '（已暂存）' : '（未暂存）') : '选择文件以查看差异'),
            selected ? React.createElement('div', { className: 'gg-review-toolbar' },
              React.createElement('button', { className: 'gg-btn gg-review-mode' + (reviewMode === 'review' ? ' active' : ''), type: 'button', onClick: () => setReviewMode('review') }, '文件审阅'),
              React.createElement('button', { className: 'gg-btn gg-review-mode' + (reviewMode === 'raw' ? ' active' : ''), type: 'button', onClick: () => setReviewMode('raw') }, '原始 Diff'),
            ) : null,
            selected && reviewMode === 'review'
              ? React.createElement('div', { className: 'gg-review' }, renderReviewSurface(diff))
              : React.createElement('pre', { className: 'gg-pre gg-diff-code' },
                renderRawDiffSurface(selected ? diff : '尚未选择文件。'),
              ),
          ),
        ) : renderLoadingState('正在读取仓库状态'),
      )
    }

    function GitBranchesTab(props: BranchTabProps) {
      const { sessionId, revision, onChanged, onCommand, onFailure } = props
      const [branches, setBranches] = React.useState([] as BranchSummary[])
      const [remotes, setRemotes] = React.useState([] as ReferenceSummary[])
      const [tags, setTags] = React.useState([] as ReferenceSummary[])
      const [referenceTab, setReferenceTab] = React.useState('local')
      const [branchQuery, setBranchQuery] = React.useState('')
      const [name, setName] = React.useState('')
      const [base, setBase] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [diagnostics, setDiagnostics] = React.useState('')
      const [confirmDelete, setConfirmDelete] = React.useState(null as string | null)
      const [forceDelete, setForceDelete] = React.useState(null as string | null)
      const [riskAccepted, setRiskAccepted] = React.useState(false)
      const refreshFeedback = useManualRefreshFeedback()
      const listRequestRef = React.useRef({ controller: null, sequence: 0 } as RequestSlot)

      const load = (manual = false): Promise<boolean> => {
        if (manual) refreshFeedback.begin()
        const request = beginTrackedRequest(listRequestRef)
        return rpc({ action: 'get-branches', sessionId }, request.signal)
          .then((response) => {
            if (!isTrackedRequestCurrent(listRequestRef, request)) return false
            if (response && response.ok === true) {
              const data = response.data && !Array.isArray(response.data) ? response.data : { branches: response.data, remotes: [], tags: [] }
              const next = Array.isArray(data.branches) ? data.branches : []
              setBranches(next)
              setRemotes(Array.isArray(data.remotes) ? data.remotes : [])
              setTags(Array.isArray(data.tags) ? data.tags : [])
              const current = next.find((branch: BranchSummary) => branch.current)
              if (!base && current) setBase(String(current.name || ''))
              if (confirmDelete && !next.some((branch: BranchSummary) => branch.name === confirmDelete)) setConfirmDelete(null)
              if (forceDelete && !next.some((branch: BranchSummary) => branch.name === forceDelete)) setForceDelete(null)
              setMessage('')
              setDiagnostics('')
              return true
            } else {
              setMessage(actionError(response))
              setDiagnostics(actionDiagnostics(response))
              return false
            }
          })
          .catch((error) => {
            if (!isTrackedRequestCurrent(listRequestRef, request) || isAbortError(error)) return false
            setMessage(errorText(error))
            setDiagnostics('')
            return false
          })
          .then((succeeded) => {
            if (manual && isTrackedRequestCurrent(listRequestRef, request)) refreshFeedback.finish(succeeded)
            return succeeded
          })
      }

      React.useEffect(() => {
        load()
        return () => cancelTrackedRequest(listRequestRef)
      }, [sessionId, revision])

      const mutate = (action: RepositoryMutationAction, payload: AnyRecord) => {
        const description = mutationCommand(action, payload)
        const completeCommand = description ? onCommand(description.label, description.command) : null
        setBusy(true)
        setMessage('')
        setDiagnostics('')
        rpcRepositoryMutation(action, sessionId, payload)
          .then((response) => {
            if (!response || response.ok !== true) {
              if (completeCommand) completeCommand(false)
              setMessage(actionError(response))
              setDiagnostics(actionDiagnostics(response))
              onFailure(response as AnyRecord)
            }
            else { if (completeCommand) completeCommand(true); onChanged(); load() }
          })
          .catch((error) => { if (completeCommand) completeCommand(false); setMessage(errorText(error)); setDiagnostics('') })
          .then(() => setBusy(false))
      }

      const cancelDelete = () => {
        setConfirmDelete(null)
        setForceDelete(null)
        setRiskAccepted(false)
      }

      const deleteBranch = (branchName: string, force: boolean) => {
        const description = mutationCommand('delete-branch', { name: branchName, force })!
        const completeCommand = onCommand(description.label, description.command)
        setBusy(true)
        setMessage('')
        setDiagnostics('')
        rpc({
          action: 'delete-branch', sessionId, operationId: operationId(force ? 'force-delete-branch' : 'delete-branch'),
          name: branchName, force, confirmRisk: force && riskAccepted,
        })
          .then((response) => {
            if (response && response.ok === true) {
              completeCommand(true)
              cancelDelete()
              onChanged()
              load()
              return
            }
            completeCommand(false)
            setMessage(actionError(response))
            setDiagnostics(actionDiagnostics(response))
            onFailure(response as AnyRecord)
            if (!force && response && response.reason === 'UNMERGED_BRANCH') {
              setConfirmDelete(null)
              setForceDelete(branchName)
              setRiskAccepted(false)
            }
          })
          .catch((error) => { completeCommand(false); setMessage(errorText(error)); setDiagnostics('') })
          .then(() => setBusy(false))
      }

      const referenceRows = (entries: ReferenceSummary[], emptyText: string) => entries.length
        ? entries.map((entry: ReferenceSummary, index: number) => React.createElement('div', { className: 'gg-branch-row gg-reference-row', key: String(entry.name || index) },
          React.createElement('code', null, String(entry.name || '')),
          React.createElement('code', { className: 'gg-reference-hash' }, String(entry.hash || '')),
          entry.subject ? React.createElement('span', { className: 'gg-idletext', title: String(entry.subject) }, String(entry.subject)) : null,
        ))
        : React.createElement('div', { className: 'gg-idletext gg-reference-empty' }, emptyText)

      const visibleBranches = filterLocalBranches(branches, branchQuery)

      return React.createElement('section', { className: 'gg-tab-content' },
        React.createElement('div', { className: 'gg-tab-toolbar' },
          React.createElement('span', { className: 'gg-section-heading' }, '分支与引用'),
          React.createElement('button', {
            className: 'gg-btn', disabled: busy || refreshFeedback.state === 'loading',
            onClick: () => { void load(true) },
          }, refreshButtonLabel(refreshFeedback.state)),
        ),
        message ? React.createElement('div', { className: 'gg-workbench-error' }, message) : null,
        diagnostics ? React.createElement('pre', { className: 'gg-diagnostics' }, diagnostics) : null,
        React.createElement('div', { className: 'gg-reference-tabs', role: 'tablist', 'aria-label': 'Git 引用类型' }, [
          { id: 'local', label: '本地 (' + branches.length + ')' },
          { id: 'remote', label: '远程 (' + remotes.length + ')' },
          { id: 'tag', label: '标签 (' + tags.length + ')' },
        ].map((entry) => React.createElement('button', {
          className: 'gg-tab' + (referenceTab === entry.id ? ' active' : ''), type: 'button', role: 'tab', key: entry.id,
          'aria-selected': referenceTab === entry.id, onClick: () => setReferenceTab(entry.id),
        }, entry.label))),
        referenceTab === 'local' ? React.createElement('div', { className: 'gg-local-branches' },
          React.createElement('label', { className: 'gg-field', htmlFor: 'gg-branch-search' },
            React.createElement('span', { className: 'gg-field-label' }, '搜索分支'),
            React.createElement('input', {
              id: 'gg-branch-search', className: 'gg-input', type: 'search', value: branchQuery, placeholder: '输入分支名称',
              onChange: (event: AnyRecord) => setBranchQuery(String(event.target.value || '')),
            }),
          ),
          React.createElement('div', { className: 'gg-branch-list' }, visibleBranches.length ? visibleBranches.map((branch: BranchSummary, index: number) => {
          const branchName = String(branch.name || '')
          const confirming = confirmDelete === branchName
          const forcing = forceDelete === branchName
          return React.createElement('div', { className: 'gg-branch-row' + (branch.current ? ' current' : '') + (confirming || forcing ? ' confirming' : ''), key: branchName || String(index) },
            React.createElement('code', null, (branch.current ? '* ' : '') + branchName),
            branch.upstream ? React.createElement('span', { className: 'gg-idletext' }, String(branch.upstream)) : null,
            branch.current ? null : React.createElement('button', { className: 'gg-btn', disabled: busy, onClick: () => { cancelDelete(); mutate('switch-branch', { name: branchName }) } }, '切换'),
            branch.current || confirming || forcing ? null : React.createElement('button', {
              className: 'gg-btn', disabled: busy, onClick: () => { setConfirmDelete(branchName); setForceDelete(null); setRiskAccepted(false) },
            }, '删除'),
            confirming ? React.createElement('div', { className: 'gg-branch-confirm' },
              React.createElement('span', null, `确定安全删除分支“${branchName}”吗？`),
              React.createElement('div', { className: 'gg-branch-confirm-actions' },
                React.createElement('button', { className: 'gg-btn danger', disabled: busy, onClick: () => deleteBranch(branchName, false) }, '确认安全删除'),
                React.createElement('button', { className: 'gg-btn', disabled: busy, onClick: cancelDelete }, '取消'),
              ),
            ) : null,
            forcing ? React.createElement('div', { className: 'gg-branch-confirm' },
              React.createElement('div', { className: 'gg-riskline' }, `分支“${branchName}”包含未合并提交。强制删除可能导致这些提交永久丢失。`),
              React.createElement('label', { className: 'gg-check' },
                React.createElement('input', { type: 'checkbox', checked: riskAccepted, disabled: busy, onChange: (event: AnyRecord) => setRiskAccepted(!!event.target.checked) }),
                '我已知晓未合并提交可能永久丢失',
              ),
              React.createElement('div', { className: 'gg-branch-confirm-actions' },
                React.createElement('button', { className: 'gg-btn danger', disabled: busy || !riskAccepted, onClick: () => deleteBranch(branchName, true) }, '强制删除'),
                React.createElement('button', { className: 'gg-btn', disabled: busy, onClick: cancelDelete }, '取消'),
              ),
            ) : null,
          )
          }) : React.createElement('div', { className: 'gg-idletext gg-reference-empty' }, branches.length ? '没有匹配的本地分支。' : '没有本地分支。')),
        ) : referenceTab === 'remote'
          ? React.createElement('div', { className: 'gg-branch-list' }, referenceRows(remotes, '没有远程分支。'))
          : React.createElement('div', { className: 'gg-branch-list' }, referenceRows(tags, '没有标签。')),
        referenceTab === 'local' ? React.createElement('div', { className: 'gg-branch-form' },
          React.createElement('label', { className: 'gg-field', htmlFor: 'gg-new-branch-name' },
            React.createElement('span', { className: 'gg-field-label' }, '新分支名称'),
            React.createElement('input', { id: 'gg-new-branch-name', className: 'gg-input', value: name, placeholder: '例如：feature/login', disabled: busy, onChange: (event: AnyRecord) => setName(String(event.target.value || '')) }),
          ),
          React.createElement('label', { className: 'gg-field', htmlFor: 'gg-new-branch-base' },
            React.createElement('span', { className: 'gg-field-label' }, '基础分支'),
            React.createElement('input', { id: 'gg-new-branch-base', className: 'gg-input', value: base, placeholder: '例如：main', disabled: busy, onChange: (event: AnyRecord) => setBase(String(event.target.value || '')) }),
          ),
          React.createElement('button', {
            className: 'gg-btn primary', disabled: busy || !name.trim() || !base.trim(),
            onClick: () => mutate('create-branch', { name, base }),
          }, '新建分支'),
        ) : null,
      )
    }

    const COMMIT_GRAPH_COLORS = ['#ff7500', '#ffbf16', '#3ba7ff', '#c57cff', '#38d996', '#ff5c8a']

    function CommitGraph(props: { row: CommitGraphRow }) {
      const { row } = props
      const width = row.laneCount * 16 + 12
      const laneX = (lane: number) => 8 + lane * 16
      const paths = row.edges.map((edge, index) => {
        const fromX = laneX(edge.from)
        const color = COMMIT_GRAPH_COLORS[edge.from % COMMIT_GRAPH_COLORS.length]
        if (edge.to === null) {
          return React.createElement('path', { key: 'root-' + index, d: `M ${fromX} 0 L ${fromX} 11`, stroke: color, strokeWidth: 2, fill: 'none' })
        }
        const toX = laneX(edge.to)
        return React.createElement('path', {
          key: 'edge-' + index,
          d: `M ${fromX} 0 C ${fromX} 18, ${toX} 18, ${toX} 36`,
          stroke: color, strokeWidth: 2, fill: 'none',
        })
      })
      const nodeColor = COMMIT_GRAPH_COLORS[row.lane % COMMIT_GRAPH_COLORS.length]
      const merge = Array.isArray(row.commit.parents) && row.commit.parents.length > 1
      return React.createElement('svg', {
        className: 'gg-commit-graph', width, height: 36, viewBox: `0 0 ${width} 36`, 'aria-hidden': 'true',
      },
      paths,
      merge ? React.createElement('circle', { cx: laneX(row.lane), cy: 11, r: 7, fill: 'var(--gg-surface)', stroke: nodeColor, strokeWidth: 2 }) : null,
      React.createElement('circle', { cx: laneX(row.lane), cy: 11, r: merge ? 3 : 5, fill: nodeColor }),
      )
    }

    function GitCommitsTab(props: CommitTabProps) {
      const { sessionId, revision } = props
      const [commits, setCommits] = React.useState([] as CommitSummary[])
      const [message, setMessage] = React.useState('')
      const [selectedHash, setSelectedHash] = React.useState('')
      const [detail, setDetail] = React.useState(null as CommitDetail | null)
      const [detailLoading, setDetailLoading] = React.useState(false)
      const [detailMessage, setDetailMessage] = React.useState('')
      const [commitDiff, setCommitDiff] = React.useState(null as CommitDiffResult | null)
      const [diffLoading, setDiffLoading] = React.useState(false)
      const [diffMessage, setDiffMessage] = React.useState('')
      const refreshFeedback = useManualRefreshFeedback()
      const selectedHashRef = React.useRef('')
      const listRequestRef = React.useRef({ controller: null, sequence: 0 } as RequestSlot)
      const detailRequestRef = React.useRef({ controller: null, sequence: 0 } as RequestSlot)
      const diffRequestRef = React.useRef({ controller: null, sequence: 0 } as RequestSlot)
      const sessionRef = React.useRef(sessionId)

      const clearSelection = () => {
        selectedHashRef.current = ''
        cancelTrackedRequest(detailRequestRef)
        cancelTrackedRequest(diffRequestRef)
        setSelectedHash('')
        setDetail(null)
        setDetailLoading(false)
        setDetailMessage('')
        setCommitDiff(null)
        setDiffLoading(false)
        setDiffMessage('')
      }

      const loadCommitDetail = (hash: string, resetView: boolean): Promise<boolean> => {
        selectedHashRef.current = hash
        if (resetView) {
          cancelTrackedRequest(diffRequestRef)
          setDetail(null)
          setCommitDiff(null)
          setDiffLoading(false)
          setDiffMessage('')
        }
        const request = beginTrackedRequest(detailRequestRef)
        setSelectedHash(hash)
        setDetailLoading(true)
        setDetailMessage('')
        return rpc({ action: 'get-commit-detail', sessionId, hash }, request.signal)
          .then((response) => {
            if (selectedHashRef.current !== hash || !isTrackedRequestCurrent(detailRequestRef, request)) return false
            if (response && response.ok === true) {
              setDetail(response.data)
              return true
            }
            setDetailMessage(actionError(response))
            return false
          })
          .catch((error) => {
            if (selectedHashRef.current !== hash || !isTrackedRequestCurrent(detailRequestRef, request) || isAbortError(error)) return false
            setDetailMessage(errorText(error))
            return false
          })
          .then((succeeded) => {
            if (selectedHashRef.current === hash && isTrackedRequestCurrent(detailRequestRef, request)) setDetailLoading(false)
            return succeeded
          })
      }

      const load = (manual = false): Promise<boolean> => {
        if (manual) refreshFeedback.begin()
        const request = beginTrackedRequest(listRequestRef)
        return rpc({ action: 'get-commits', sessionId, limit: 80 }, request.signal)
          .then(async (response) => {
            if (!isTrackedRequestCurrent(listRequestRef, request)) return false
            if (response && response.ok === true) {
              const next = Array.isArray(response.data) ? response.data : []
              setCommits(next)
              setMessage('')
              const activeHash = selectedHashRef.current
              if (activeHash && !next.some((commit: CommitSummary) => commit.hash === activeHash)) {
                clearSelection()
                return true
              }
              if (manual && activeHash) return loadCommitDetail(activeHash, false)
              return true
            }
            setMessage(actionError(response))
            return false
          })
          .catch((error) => {
            if (!isTrackedRequestCurrent(listRequestRef, request) || isAbortError(error)) return false
            setMessage(errorText(error))
            return false
          })
          .then((succeeded) => {
            if (manual && isTrackedRequestCurrent(listRequestRef, request)) refreshFeedback.finish(succeeded)
            return succeeded
          })
      }

      React.useEffect(() => {
        if (sessionRef.current !== sessionId) {
          sessionRef.current = sessionId
          clearSelection()
        }
        load()
        return () => cancelTrackedRequest(listRequestRef)
      }, [sessionId, revision])

      React.useEffect(() => () => {
        cancelTrackedRequest(listRequestRef)
        cancelTrackedRequest(detailRequestRef)
        cancelTrackedRequest(diffRequestRef)
      }, [])

      const selectCommit = (commit: CommitSummary) => {
        const hash = String(commit.hash || '')
        if (!hash) return
        if (!nextCommitSelection(selectedHashRef.current, hash)) {
          clearSelection()
          return
        }
        void loadCommitDetail(hash, true)
      }

      const loadCommitDiff = () => {
        const hash = selectedHashRef.current
        if (!hash || diffLoading) return
        const request = beginTrackedRequest(diffRequestRef)
        setDiffLoading(true)
        setDiffMessage('')
        rpc({ action: 'get-commit-diff', sessionId, hash }, request.signal)
          .then((response) => {
            const current = selectedHashRef.current === hash && isTrackedRequestCurrent(diffRequestRef, request)
            if (!current) return
            if (response && response.ok === true) setCommitDiff(response.data)
            else setDiffMessage(actionError(response))
          })
          .catch((error) => {
            const current = selectedHashRef.current === hash && isTrackedRequestCurrent(diffRequestRef, request)
            if (current && !isAbortError(error)) setDiffMessage(errorText(error))
          })
          .then(() => {
            const current = selectedHashRef.current === hash && isTrackedRequestCurrent(diffRequestRef, request)
            if (current) setDiffLoading(false)
          })
      }

      const rows = deriveCommitGraph(commits)
      const detailPanel = !selectedHash ? null : React.createElement('div', { className: 'gg-commit-detail' },
          React.createElement('div', { className: 'gg-commit-detail-head' },
            React.createElement('strong', { className: 'gg-commit-detail-title' }, detail ? String(detail.subject || '（无提交说明）') : '提交详情'),
            detail ? React.createElement('code', { className: 'gg-commit-detail-hash', title: String(detail.hash || '') }, String(detail.hash || '').slice(0, 12)) : null,
            React.createElement('button', {
              className: 'gg-btn gg-commit-detail-close', type: 'button', title: '关闭提交详情', 'aria-label': '关闭提交详情', onClick: clearSelection,
            }, '×'),
          ),
          detailLoading ? React.createElement('div', { className: 'gg-idletext' }, '正在加载提交详情…') : null,
          detailMessage ? React.createElement('div', { className: 'gg-workbench-error' }, detailMessage) : null,
          detail ? React.createElement(React.Fragment, null,
            React.createElement(GitCommitActions, { key: sessionId + selectedHash, sessionId, revision, rpc, hash: detail.hash, parents: detail.parents, onChanged: props.onChanged, onCommand: props.onCommand, onConflicts: props.onConflicts }),
            detail.body ? React.createElement('pre', { className: 'gg-commit-message' }, String(detail.body)) : null,
            React.createElement('dl', { className: 'gg-commit-detail-meta' },
              React.createElement('dt', null, '作者'),
              React.createElement('dd', null, String(detail.authorName || '未知作者') + (detail.authorEmail ? ' <' + String(detail.authorEmail) + '>' : '')),
              React.createElement('dt', null, '作者时间'), React.createElement('dd', null, String(detail.authoredAt || '未知')),
              React.createElement('dt', null, '提交者'),
              React.createElement('dd', null, String(detail.committerName || '未知提交者') + (detail.committerEmail ? ' <' + String(detail.committerEmail) + '>' : '')),
              React.createElement('dt', null, '提交时间'), React.createElement('dd', null, String(detail.committedAt || '未知')),
              React.createElement('dt', null, '父提交'),
              React.createElement('dd', null, Array.isArray(detail.parents) && detail.parents.length
                ? detail.parents.map((parent: string) => parent.slice(0, 12)).join(', ')
                : '根提交'),
              Array.isArray(detail.parents) && detail.parents.length > 1 ? React.createElement('dt', null, '差异基线') : null,
              Array.isArray(detail.parents) && detail.parents.length > 1
                ? React.createElement('dd', null, '第一父提交 ' + String(detail.comparisonBase || '').slice(0, 12))
                : null,
            ),
            React.createElement('div', { className: 'gg-commit-summary' },
              React.createElement('span', null, String(detail.totals?.files ?? 0) + ' 个文件'),
              React.createElement('span', { className: 'gg-additions' }, '+' + String(detail.totals?.additions ?? 0)),
              React.createElement('span', { className: 'gg-deletions' }, '-' + String(detail.totals?.deletions ?? 0)),
              detail.totals?.binary ? React.createElement('span', null, String(detail.totals.binary) + ' 个二进制文件') : null,
            ),
            React.createElement('div', { className: 'gg-commit-files' }, Array.isArray(detail.files) && detail.files.length
              ? detail.files.map((file: AnyRecord, index: number) => React.createElement('div', {
                className: 'gg-commit-file' + commitFileTone(String(file.status || '')), key: String(file.path || index),
              },
              React.createElement('code', null, String(file.status || '?')),
              React.createElement('span', { className: 'gg-commit-file-path', title: String(file.path || '') },
                file.previousPath ? String(file.previousPath) + ' → ' + String(file.path || '') : String(file.path || ''),
              ),
              React.createElement('span', { className: 'gg-additions' }, file.additions === null ? '二进制' : '+' + String(file.additions)),
              React.createElement('span', { className: 'gg-deletions' }, file.deletions === null ? '' : '-' + String(file.deletions)),
              ))
              : React.createElement('div', { className: 'gg-idletext gg-reference-empty' }, '该提交没有可显示的文件变更。')),
            detail.filesTruncated ? React.createElement('div', { className: 'gg-riskline' }, '文件列表过长，仅显示前 500 项。') : null,
            React.createElement('button', { className: 'gg-btn', type: 'button', disabled: diffLoading, onClick: loadCommitDiff },
              diffLoading ? '正在加载详细 Diff…' : commitDiff ? '重新加载详细 Diff' : '加载详细 Diff',
            ),
            diffMessage ? React.createElement('div', { className: 'gg-workbench-error' }, diffMessage) : null,
            commitDiff ? React.createElement(React.Fragment, null,
              commitDiff.truncated ? React.createElement('div', { className: 'gg-riskline' }, 'Diff 过长，已截断为前 300,000 个字符。') : null,
              React.createElement('pre', { className: 'gg-pre gg-diff-code gg-commit-diff' },
                renderRawDiffSurface(String(commitDiff.diff || '没有可显示的差异。')),
              ),
            ) : null,
          ) : null,
        )
      return React.createElement('section', { className: 'gg-tab-content' },
        React.createElement('div', { className: 'gg-tab-toolbar' },
          React.createElement('span', { className: 'gg-section-heading' }, '提交记录', React.createElement('span', { className: 'gg-section-count' }, String(commits.length))),
          React.createElement('button', {
            className: 'gg-btn', disabled: refreshFeedback.state === 'loading',
            onClick: () => { void load(true) },
          }, refreshButtonLabel(refreshFeedback.state)),
        ),
        message ? React.createElement('div', { className: 'gg-workbench-error' }, message) : null,
        React.createElement('div', { className: 'gg-commit-layout' },
          React.createElement('div', { className: 'gg-commit-list' }, rows.length ? rows.map((row: CommitGraphRow, index: number) => {
            const commit = row.commit
            const refs = Array.isArray(commit.refs) ? commit.refs : []
            const hash = String(commit.hash || '')
            const activate = () => selectCommit(commit)
            return React.createElement('div', {
              className: 'gg-commit-row' + (selectedHash === hash ? ' active' : ''), key: hash || String(index),
              title: [commit.hash, commit.author, commit.date].filter(Boolean).join(' · '), role: 'button', tabIndex: 0,
              'aria-pressed': selectedHash === hash, onClick: activate,
              onKeyDown: (event: AnyRecord) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() }
              },
            },
            React.createElement(CommitGraph, { row }),
            React.createElement('div', { className: 'gg-commit-copy' },
              React.createElement('div', { className: 'gg-commit-main' },
                React.createElement('span', { className: 'gg-commit-subject' }, String(commit.subject || '（无提交说明）')),
                React.createElement('span', { className: 'gg-commit-refs' }, refs.map((ref: AnyRecord, refIndex: number) => React.createElement('span', {
                  className: 'gg-ref ' + String(ref.type || 'branch') + (ref.current ? ' current' : ''),
                  key: String(ref.type || '') + ':' + String(ref.name || refIndex), title: String(ref.name || ''),
                }, String(ref.name || '')))),
              ),
              React.createElement('div', { className: 'gg-commit-meta' },
                React.createElement('span', { className: 'gg-commit-author' }, String(commit.author || '未知作者')),
                React.createElement('code', { className: 'gg-commit-hash' }, hash.slice(0, 8)),
              ),
            ))
          }) : React.createElement('div', { className: 'gg-idletext' }, '没有提交记录。')),
          detailPanel,
        ),
      )
    }

    function GitSyncTab(props: SyncTabProps) {
      const { sessionId, revision, onChanged, onCommand, onFailure } = props
      const [state, setState] = React.useState(null as SyncState | null)
      const [targets, setTargets] = React.useState([] as string[])
      const [remote, setRemote] = React.useState('')
      const [rebaseTarget, setRebaseTarget] = React.useState('')
      const [riskAccepted, setRiskAccepted] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [diagnostics, setDiagnostics] = React.useState('')
      const refreshFeedback = useManualRefreshFeedback()
      const stateRequestRef = React.useRef({ controller: null, sequence: 0 } as RequestSlot)

      const load = (manual = false): Promise<boolean> => {
        if (manual) refreshFeedback.begin()
        const request = beginTrackedRequest(stateRequestRef)
        return Promise.all([
          rpc({ action: 'get-sync-state', sessionId }, request.signal),
          rpc({ action: 'get-branches', sessionId }, request.signal),
        ]).then(([syncResponse, referenceResponse]) => {
          if (!isTrackedRequestCurrent(stateRequestRef, request)) return false
          if (!syncResponse || syncResponse.ok !== true) {
            setMessage(actionError(syncResponse))
            setDiagnostics(actionDiagnostics(syncResponse))
            return false
          }
          const nextState = syncResponse.data
          setState(nextState)
          setRemote((current: string) => nextState.remotes.includes(current)
            ? current
            : nextState.upstream.split('/')[0] || nextState.remotes[0] || '')
          if (referenceResponse && referenceResponse.ok === true) {
            const nextTargets = [
              ...referenceResponse.data.branches.map((entry: BranchSummary) => String(entry.name || '')),
              ...referenceResponse.data.remotes.map((entry: ReferenceSummary) => String(entry.name || '')),
            ].filter(Boolean)
            setTargets(Array.from(new Set(nextTargets)))
            setRebaseTarget((current: string) => nextTargets.includes(current)
              ? current
              : nextState.upstream || nextTargets.find((entry: string) => entry !== nextState.branch) || '')
          }
          setMessage('')
          setDiagnostics('')
          return true
        }).catch((error) => {
          if (!isTrackedRequestCurrent(stateRequestRef, request) || isAbortError(error)) return false
          setMessage(errorText(error))
          setDiagnostics('')
          return false
        }).then((succeeded) => {
          if (manual && isTrackedRequestCurrent(stateRequestRef, request)) refreshFeedback.finish(succeeded)
          return succeeded
        })
      }

      React.useEffect(() => {
        void load()
        return () => cancelTrackedRequest(stateRequestRef)
      }, [sessionId, revision])

      const run = (action: 'fetch' | 'pull' | 'push' | 'rebase' | 'rebase-continue' | 'rebase-abort', payload: AnyRecord = {}) => {
        const description = mutationCommand(action, payload)
        const completeCommand = description ? onCommand(description.label, description.command) : null
        setBusy(true)
        setMessage('')
        setDiagnostics('')
        const request = { action, sessionId, operationId: operationId(action), ...payload } as EasyGitRequest<EasyGitAction>
        return (rpc(request) as Promise<AnyRecord>)
          .then(async (response) => {
            if (!response || response.ok !== true) {
              if (completeCommand) completeCommand(false)
              setMessage(actionError(response))
              setDiagnostics(actionDiagnostics(response))
              try {
                const conflicts = await rpc({ action: 'get-conflicts', sessionId })
                if (conflicts.ok && conflicts.data.files.length) { props.onConflicts(); onChanged(); return false }
              } catch { /* Keep the original Git failure visible if the refresh fails. */ }
              onFailure(response)
              void load()
              return false
            }
            if (completeCommand) completeCommand(true)
            setState(response.data as SyncState)
            setRiskAccepted(false)
            onChanged()
            void load()
            return true
          })
          .catch((error) => {
            if (completeCommand) completeCommand(false)
            setMessage(errorText(error))
            setDiagnostics('')
            return false
          })
          .then((succeeded) => { setBusy(false); return succeeded })
      }

      const hasRemote = !!(state && state.remotes.length)
      const canUseHistory = !!state && !state.rebaseInProgress && state.conflictCount === 0
      const pushPayload = state && !state.upstream
        ? { remote, branch: state.branch, setUpstream: true }
        : { setUpstream: false }
      const statusText = !state
        ? '正在读取同步状态…'
        : state.rebaseInProgress
          ? 'Rebase 正在进行'
          : state.conflictCount > 0
            ? '存在 ' + state.conflictCount + ' 个冲突文件'
            : state.dirty ? '工作区有未提交改动' : '工作区干净'

      return React.createElement('section', { className: 'gg-tab-content' },
        React.createElement('div', { className: 'gg-tab-toolbar' },
          state
            ? renderRepositoryIdentity(state.topLevel, state.branch)
            : React.createElement('span', { className: 'gg-section-heading' }, '正在读取仓库…'),
          React.createElement('button', {
            className: 'gg-btn', type: 'button', disabled: busy || refreshFeedback.state === 'loading', onClick: () => { void load(true) },
          }, refreshButtonLabel(refreshFeedback.state)),
        ),
        message ? React.createElement('div', { className: 'gg-workbench-error' }, message) : null,
        diagnostics ? React.createElement('pre', { className: 'gg-diagnostics' }, diagnostics) : null,
        state ? React.createElement('div', { className: 'gg-sync-grid' },
          React.createElement('div', { className: 'gg-sync-card' }, React.createElement('strong', null, '上游分支'), React.createElement('code', { className: 'gg-sync-value' }, state.upstream || '未设置')),
          React.createElement('div', { className: 'gg-sync-card' }, React.createElement('strong', null, '提交差异'), React.createElement('span', { className: 'gg-sync-value' }, '领先 ' + state.ahead + ' · 落后 ' + state.behind)),
          React.createElement('div', { className: 'gg-sync-card' }, React.createElement('strong', null, '工作区'), React.createElement('span', { className: 'gg-sync-value' }, statusText)),
          React.createElement('div', { className: 'gg-sync-card' }, React.createElement('strong', null, '远程仓库'), React.createElement('span', { className: 'gg-sync-value' }, state.remotes.join('、') || '未配置')),
        ) : null,
        React.createElement('button', { className: 'gg-btn', type: 'button', onClick: props.onConflicts }, '解决冲突 / Merge / Cherry-pick'),
        !hasRemote && state ? React.createElement('div', { className: 'gg-sync-warning' }, '当前仓库没有远程仓库。请先在终端或后续的 Remote 管理功能中添加远程地址。') : null,
        React.createElement('div', { className: 'gg-sync-actions' },
          React.createElement('strong', null, '远程同步'),
          React.createElement('div', { className: 'gg-sync-row' },
            React.createElement('label', { className: 'gg-field', htmlFor: 'gg-sync-remote' },
              React.createElement('span', { className: 'gg-field-label' }, '远程仓库'),
              React.createElement('select', {
                id: 'gg-sync-remote', className: 'gg-input', value: remote, disabled: busy || !hasRemote,
                onChange: (event: AnyRecord) => setRemote(String(event.target.value || '')),
              }, state ? state.remotes.map((entry: string) => React.createElement('option', { value: entry, key: entry }, entry)) : null),
            ),
            React.createElement('button', { className: 'gg-btn', type: 'button', disabled: busy || !remote, onClick: () => { void run('fetch', { remote }) } }, 'Fetch'),
          ),
          React.createElement('div', { className: 'gg-actions' },
            React.createElement('button', {
              className: 'gg-btn primary', type: 'button',
              disabled: busy || !state?.upstream || !canUseHistory,
              title: state && !state.upstream ? '当前分支没有上游跟踪分支' : '仅允许快进，不会创建合并提交或改写历史',
              onClick: () => { void run('pull') },
            }, 'Pull（仅快进）'),
            React.createElement('button', {
              className: 'gg-btn primary', type: 'button',
              disabled: busy || !state?.branch || !canUseHistory || (!state?.upstream && !remote),
              title: state && !state.upstream ? '首次推送会建立上游跟踪' : '推送当前分支到已配置上游',
              onClick: () => { void run('push', pushPayload) },
            }, state?.upstream ? 'Push' : 'Push 并设置上游'),
          ),
          React.createElement('div', { className: 'gg-sync-note' }, 'Pull 固定执行 git pull --ff-only；若不能快进会停止并保留完整错误，不会自动合并。'),
        ),
        React.createElement('div', { className: 'gg-sync-actions' },
          React.createElement('strong', null, 'Rebase（高风险）'),
          state?.rebaseInProgress ? React.createElement('div', { className: 'gg-sync-warning' }, state.conflictCount > 0
            ? '请到“冲突解决”页处理并标记全部冲突，然后继续 Rebase。'
            : '冲突已经解决并暂存，可以继续 Rebase；也可以中止并恢复到开始前。') : null,
          !state?.rebaseInProgress ? React.createElement('label', { className: 'gg-field', htmlFor: 'gg-rebase-target' },
            React.createElement('span', { className: 'gg-field-label' }, '目标引用'),
            React.createElement('select', {
              id: 'gg-rebase-target', className: 'gg-input', value: rebaseTarget, disabled: busy || targets.length === 0,
              onChange: (event: AnyRecord) => setRebaseTarget(String(event.target.value || '')),
            }, targets.map((entry: string) => React.createElement('option', { value: entry, key: entry }, entry))),
          ) : null,
          React.createElement('label', { className: 'gg-check' },
            React.createElement('input', {
              type: 'checkbox', checked: riskAccepted, disabled: busy,
              onChange: (event: AnyRecord) => setRiskAccepted(event.target.checked === true),
            }),
            React.createElement('span', null, state?.rebaseInProgress
              ? '我了解继续或中止 Rebase 可能改写历史或丢弃本次冲突处理'
              : '我了解 Rebase 会重写当前分支的本地提交历史'),
          ),
          state?.rebaseInProgress ? React.createElement('div', { className: 'gg-actions' },
            React.createElement('button', {
              className: 'gg-btn primary', type: 'button', disabled: busy || !riskAccepted || state.conflictCount > 0,
              onClick: () => { void run('rebase-continue', { confirmRisk: riskAccepted }) },
            }, '继续 Rebase'),
            React.createElement('button', {
              className: 'gg-btn danger', type: 'button', disabled: busy || !riskAccepted,
              onClick: () => { void run('rebase-abort', { confirmRisk: riskAccepted }) },
            }, '中止 Rebase'),
          ) : React.createElement('button', {
            className: 'gg-btn danger', type: 'button',
            disabled: busy || !riskAccepted || !rebaseTarget || !!state?.dirty,
            title: state?.dirty ? '请先提交或贮藏工作区改动' : '将当前分支变基到所选引用',
            onClick: () => { void run('rebase', { target: rebaseTarget, confirmRisk: riskAccepted }) },
          }, '开始 Rebase'),
          React.createElement('div', { className: 'gg-sync-note' }, state?.dirty && !state.rebaseInProgress
            ? '工作区有改动：为避免丢失内容，开始 Rebase 已禁用。'
            : 'Rebase 发生冲突时会保留在当前页面；错误详情会交给现有建议与 Agent 分析流程。'),
        ),
      )
    }

    function GitWorkbenchPanel(props: GitWorkbenchPanelProps) {
      const [tab, setTab] = React.useState('changes')
      const [conflictDirty, setConflictDirty] = React.useState(false)
      const conflictDirtyRef = React.useRef(false)
      conflictDirtyRef.current = conflictDirty
      const [revision, setRevision] = React.useState(0)
      const [commandLogs, setCommandLogs] = React.useState([])
      const [pendingAnalysis, setPendingAnalysis] = React.useState(null as null | {
        proposalId: string
        failure: GitFailureContext
        status: 'ready' | 'requesting' | 'waiting' | 'dismissing'
        error: string
      })
      const commandSeqRef = React.useRef(0)
      const commandLogBodyRef = React.useRef(null)
      const delayedOpenDisposers = React.useRef([])
      const observedProposalIdRef = React.useRef(null as string | null)
      const proposalStateRequestRef = React.useRef({ controller: null, sequence: 0 } as RequestSlot)
      const refresh = () => setRevision((current: number) => current + 1)
      const schedule = (callback: Dispose, delayMs: number): Dispose => {
        if (props.timeoutFn) {
          const dispose = props.timeoutFn(callback, delayMs)
          return typeof dispose === 'function' ? dispose : () => {}
        }
        const timer = window.setTimeout(callback, delayMs)
        return () => window.clearTimeout(timer)
      }
      const handleFailure: FailureHandler = (response) => {
        const scheduled = openRecoveryProposal(response, () => { if (!conflictDirtyRef.current) setTab('proposal') }, (open, delayMs) => {
          let dispose: Dispose = () => {}
          dispose = schedule(() => {
            delayedOpenDisposers.current = delayedOpenDisposers.current.filter((item: Dispose) => item !== dispose)
            open()
          }, delayMs)
          delayedOpenDisposers.current.push(dispose)
        })
        if (scheduled) {
          setPendingAnalysis(null)
          return
        }
        const proposalId = analysisProposalId(response)
        const failure = failureContext(response)
        if (proposalId && failure) setPendingAnalysis({ proposalId, failure, status: 'ready', error: '' })
      }
      const requestAnalysis = () => {
        const current = pendingAnalysis
        if (!current || current.status !== 'ready') return
        setPendingAnalysis({ ...current, status: 'requesting', error: '' })
        rpc({ action: 'request-analysis', sessionId: props.sessionId, proposalId: current.proposalId })
          .then((response) => {
            if (!response || response.ok !== true) throw new Error(String(response?.error || '无法标记分析请求'))
            return props.sendPrompt(buildAgentRepairPrompt(current.failure))
          })
          .then(() => setPendingAnalysis((active: AnyRecord | null) => active && active.proposalId === current.proposalId
            ? { ...active, status: 'waiting', error: '' }
            : active))
          .catch((error) => setPendingAnalysis((active: AnyRecord | null) => active && active.proposalId === current.proposalId
            ? { ...active, status: 'ready', error: errorText(error) }
            : active))
      }
      const abandonAnalysis = () => {
        const current = pendingAnalysis
        if (!current || current.status !== 'ready') return
        setPendingAnalysis({ ...current, status: 'dismissing', error: '' })
        rpc({ action: 'dismiss', sessionId: props.sessionId, proposalId: current.proposalId })
          .then((response) => {
            if (!response || response.ok !== true) throw new Error(String(response?.error || '无法放弃分析'))
            setPendingAnalysis((active: AnyRecord | null) => active && active.proposalId === current.proposalId ? null : active)
          })
          .catch((error) => setPendingAnalysis((active: AnyRecord | null) => active && active.proposalId === current.proposalId
            ? { ...active, status: 'ready', error: errorText(error) }
            : active))
      }
      const reportCommand: CommandReporter = (label, command) => {
        commandSeqRef.current += 1
        const id = commandSeqRef.current
        setCommandLogs((current: CommandLogEntry[]) => appendCommandLog(current, { id, label, command, status: 'running' }))
        let completed = false
        return (succeeded: boolean) => {
          if (completed) return
          completed = true
          setCommandLogs((current: CommandLogEntry[]) => current.map((entry) => entry.id === id
            ? { ...entry, status: succeeded ? 'succeeded' : 'failed' }
            : entry))
        }
      }
      React.useEffect(() => {
        setCommandLogs([])
        commandSeqRef.current = 0
        setPendingAnalysis(null)
        observedProposalIdRef.current = null
      }, [props.sessionId])
      React.useEffect(() => {
        const check = () => {
          const request = beginTrackedRequest(proposalStateRequestRef)
          rpc({ action: 'state', sessionId: props.sessionId }, request.signal)
            .then((response) => {
              if (!isTrackedRequestCurrent(proposalStateRequestRef, request)) return
              const proposal = response && response.ok === true ? response.proposal : null
              const transition = pendingProposalTransition(observedProposalIdRef.current, proposal)
              observedProposalIdRef.current = transition.proposalId
              if (transition.shouldOpen && !conflictDirtyRef.current) {
                setPendingAnalysis(null)
                setTab('proposal')
                return
              }
              if (proposal && proposal.status === 'failed' && proposal.needsAgentAnalysis && proposal.failure) {
                setPendingAnalysis((active: AnyRecord | null) => {
                  if (active && active.proposalId === proposal.proposalId) return active
                  return {
                    proposalId: proposal.proposalId,
                    failure: proposal.failure,
                    status: proposal.analysisRequestedAt ? 'waiting' : 'ready',
                    error: '',
                  }
                })
              }
            })
            .catch((error) => { if (!isAbortError(error)) { /* 下一轮重试 */ } })
        }
        check()
        if (props.intervalFn) {
          const dispose = props.intervalFn(check, 1200)
          return () => {
            cancelTrackedRequest(proposalStateRequestRef)
            if (typeof dispose === 'function') dispose()
          }
        }
        const timer = window.setInterval(check, 1200)
        return () => {
          cancelTrackedRequest(proposalStateRequestRef)
          window.clearInterval(timer)
        }
      }, [props.intervalFn, props.sessionId])
      React.useEffect(() => () => {
        for (const dispose of delayedOpenDisposers.current.splice(0)) dispose()
      }, [])
      React.useEffect(() => {
        const element = commandLogBodyRef.current as HTMLElement | null
        if (element) element.scrollTop = element.scrollHeight
      }, [commandLogs])
      const tabs = [
        { id: 'changes', label: '变更' },
        { id: 'conflicts', label: '冲突解决' },
        { id: 'branches', label: '分支' },
        { id: 'merge', label: '合并分支' },
        { id: 'commits', label: '提交记录' },
        { id: 'stashes', label: '贮藏' },
        { id: 'sync', label: '同步' },
        { id: 'proposal', label: '建议' },
      ]
      const onTabKeyDown = (event: AnyRecord, index: number) => {
        if (conflictDirty) return
        let nextIndex = index
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
        else if (event.key === 'Home') nextIndex = 0
        else if (event.key === 'End') nextIndex = tabs.length - 1
        else return
        event.preventDefault()
        const next = tabs[nextIndex]!
        setTab(next.id)
        window.requestAnimationFrame(() => {
          const element = document.getElementById('gg-tab-' + next.id)
          if (element) element.focus()
        })
      }
      const content = tab === 'changes'
        ? React.createElement(GitChangesTab, { sessionId: props.sessionId, intervalFn: props.intervalFn, revision, onChanged: refresh, onCommand: reportCommand, onFailure: handleFailure, onConflicts: () => setTab('conflicts') })
        : tab === 'conflicts'
          ? React.createElement(GitConflictsTab, { key: props.sessionId, sessionId: props.sessionId, revision, rpc, onChanged: refresh, onDirty: setConflictDirty, onCommand: reportCommand })
        : tab === 'branches'
          ? React.createElement(GitBranchesTab, { sessionId: props.sessionId, revision, onChanged: refresh, onCommand: reportCommand, onFailure: handleFailure })
          : tab === 'merge'
            ? React.createElement(GitMergeTab, { key: props.sessionId, sessionId: props.sessionId, revision, rpc, onChanged: refresh, onCommand: reportCommand, onConflicts: () => setTab('conflicts'), renderReview: renderReviewSurface, renderRawDiff: renderRawDiffSurface })
          : tab === 'commits'
            ? React.createElement(GitCommitsTab, { sessionId: props.sessionId, revision, onChanged: refresh, onCommand: reportCommand, onConflicts: () => setTab('conflicts') })
            : tab === 'stashes'
              ? React.createElement(GitStashesTab, { key: props.sessionId, sessionId: props.sessionId, revision, rpc, onChanged: refresh, onCommand: reportCommand, onConflicts: () => setTab('conflicts'), renderReview: renderReviewSurface, renderRawDiff: renderRawDiffSurface })
              : tab === 'sync'
                ? React.createElement(GitSyncTab, { sessionId: props.sessionId, intervalFn: props.intervalFn, revision, onChanged: refresh, onCommand: reportCommand, onFailure: handleFailure, onConflicts: () => setTab('conflicts') })
                : React.createElement(GitDock, { sessionId: props.sessionId, intervalFn: props.intervalFn, timeoutFn: props.timeoutFn, onFailure: handleFailure })
      const analysisBanner = shouldShowAnalysisBanner(tab, pendingAnalysis) && pendingAnalysis ? React.createElement('div', { className: 'gg-analysis' },
        React.createElement('strong', null, pendingAnalysis.status === 'waiting' ? 'Agent 正在分析 Git 失败…' : '这个 Git 失败需要 Agent 分析'),
        renderFailureDetails(pendingAnalysis.failure),
        pendingAnalysis.error ? React.createElement('div', { className: 'gg-workbench-error' }, pendingAnalysis.error) : null,
        React.createElement('div', { className: 'gg-idletext' }, pendingAnalysis.status === 'waiting'
          ? '已发送给当前会话 Agent；它生成可执行提议后会自动跳转到建议页。'
          : '确认后，Agent 会读取仓库、文件和远程跟踪状态，仅生成修复提议，不会直接执行。'),
        pendingAnalysis.status !== 'waiting' ? React.createElement('div', { className: 'gg-actions' },
          React.createElement('button', {
            className: 'gg-btn primary', type: 'button', disabled: pendingAnalysis.status !== 'ready', onClick: requestAnalysis,
          }, pendingAnalysis.status === 'requesting' ? '正在请求…' : '确认并让 Agent 分析'),
          React.createElement('button', {
            className: 'gg-btn', type: 'button', disabled: pendingAnalysis.status !== 'ready', onClick: abandonAnalysis,
          }, pendingAnalysis.status === 'dismissing' ? '正在放弃…' : '放弃分析'),
        ) : null,
      ) : null
      return React.createElement('aside', {
        className: 'gg-workbench', 'aria-label': 'Git 工作台',
      },
        React.createElement('div', { className: 'gg-workbench-head' },
          React.createElement('span', { className: 'gg-workbench-title' }, 'Git 工作台'),
          React.createElement('button', {
            type: 'button', className: 'gg-btn gg-workbench-close', title: '关闭 Git 工作台', 'aria-label': '关闭 Git 工作台', onClick: props.close,
          }, '×'),
        ),
        React.createElement('div', { className: 'gg-workbench-body' },
          React.createElement('div', { className: 'gg-tabs', role: 'tablist', 'aria-label': 'Git 工作台区域' }, tabs.map((entry: { id: string; label: string }, index: number) => React.createElement('button', {
            className: 'gg-tab' + (tab === entry.id ? ' active' : ''), type: 'button', role: 'tab',
            id: 'gg-tab-' + entry.id, 'aria-controls': 'gg-panel-' + entry.id,
            'aria-selected': tab === entry.id, tabIndex: tab === entry.id ? 0 : -1,
            disabled: conflictDirty && tab !== entry.id, onClick: () => setTab(entry.id), onKeyDown: (event: AnyRecord) => onTabKeyDown(event, index), key: entry.id,
          }, entry.label))),
          React.createElement('div', {
            className: 'gg-tab-panel', id: 'gg-panel-' + tab, role: 'tabpanel', 'aria-labelledby': 'gg-tab-' + tab,
          }, analysisBanner, content),
        ),
        React.createElement('section', { className: 'gg-command-log', 'aria-label': '命令日志' },
          React.createElement('strong', { className: 'gg-command-log-head' }, '命令日志'),
          React.createElement('div', { className: 'gg-command-log-body', ref: commandLogBodyRef }, commandLogs.length
            ? commandLogs.map((entry: CommandLogEntry) => React.createElement('div', { className: 'gg-command-entry', key: entry.id },
              React.createElement('span', { className: 'gg-command-label' }, entry.label),
              React.createElement('span', { className: 'gg-command-status ' + entry.status }, entry.status === 'running' ? '执行中' : entry.status === 'succeeded' ? '成功' : '失败'),
              React.createElement('code', { className: 'gg-command-code' }, entry.command),
            ))
            : React.createElement('div', { className: 'gg-idletext' }, '尚未执行修改命令。')),
        ),
      )
    }

    function GitDock(props: GitDockProps) {
      const sessionId = props.sessionId || ''
      const intervalFn = props.intervalFn || null
      const timeoutFn = props.timeoutFn || null
      const [view, setView] = React.useState(null as ProposalView | null)
      const [busy, setBusy] = React.useState(false)
      const [understood, setUnderstood] = React.useState(false)
      const [outcome, setOutcome] = React.useState(null as ProposalExecutionResponse | null)
      const [ranInfo, setRanInfo] = React.useState(null)
      const [partialInfo, setPartialInfo] = React.useState(null)
      const [verifyMsg, setVerifyMsg] = React.useState(null)
      const [collapsed, setCollapsed] = React.useState(false)
      const currentProposalId = React.useRef(null)
      const scheduledCloses = React.useRef(new Set())
      const closeDisposers = React.useRef([])
      const recoveryRefreshDisposers = React.useRef([])
      const deferredRecoveryUntil = React.useRef(0)

      const resetProposalState = () => {
        setBusy(false)
        setUnderstood(false)
        setOutcome(null)
        setRanInfo(null)
        setPartialInfo(null)
        setVerifyMsg(null)
      }

      const doDismiss = (pid: string) => {
        rpc({ action: 'dismiss', sessionId: String(sessionId), proposalId: pid })
          .then(refresh)
          .catch(refresh)
      }
      const scheduleClose = (pid: string) => {
        if (scheduledCloses.current.has(pid)) return
        scheduledCloses.current.add(pid)
        if (timeoutFn) {
          let dispose: Dispose | void
          const close = () => {
            scheduledCloses.current.delete(pid)
            closeDisposers.current = closeDisposers.current.filter((item: Dispose) => item !== dispose)
            doDismiss(pid)
          }
          dispose = timeoutFn(close, 4000)
          if (typeof dispose === 'function') closeDisposers.current.push(dispose)
        } else {
          scheduledCloses.current.delete(pid)
          doDismiss(pid)
        }
      }

      const refresh = () => {
        rpc({ action: 'state', sessionId: String(sessionId) })
          .then((res) => {
            if (res && res.ok === true) {
              const nextId = res.proposal && res.proposal.proposalId ? res.proposal.proposalId : null
              if (nextId !== currentProposalId.current && Date.now() < deferredRecoveryUntil.current) return
              if (nextId !== currentProposalId.current) {
                currentProposalId.current = nextId
                resetProposalState()
              }
              setView(res.proposal)
              if (res.verified === true && res.proposal && res.proposal.proposalId) {
                setRanInfo(res.changedState || '检测到预期结果已达成')
                scheduleClose(res.proposal.proposalId)
              } else if (res.partial === true && res.proposal && res.proposal.proposalId) {
                setPartialInfo({ message: res.message || '预期结果未达成', state: res.changedState || '' })
              } else if (res.proposal && (res.proposal.status === 'succeeded' || res.proposal.status === 'verified')) {
                setRanInfo(res.proposal.status === 'verified' ? '手动执行的预期结果已验证' : '命令已执行成功')
                scheduleClose(res.proposal.proposalId)
              } else if (res.proposal && res.proposal.status === 'failed') {
                setBusy(false)
                setOutcome((current: AnyRecord | null) => current || {
                  ok: false,
                  error: '该提议执行失败；如需重试，请创建新的提议',
                  steps: (res.proposal?.steps || []).map((step) => ({ command: step.command, ok: !!(step.result && step.result.ok) })),
                })
              } else {
                setPartialInfo(null)
                if (res.message) setVerifyMsg(res.message)
              }
            }
          })
          .catch((err) => { console.log('easygit state 调用失败', errorText(err)) })
      }

      React.useEffect(() => {
        currentProposalId.current = null
        resetProposalState()
        refresh()
        if (!intervalFn) return undefined
        const disp = intervalFn(refresh, 1200)
        return () => { try { if (typeof disp === 'function') disp() } catch (e) { /* ignore */ } }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId, intervalFn])

      React.useEffect(() => () => {
        for (const dispose of closeDisposers.current.splice(0)) {
          try { dispose() } catch (e) { /* ignore */ }
        }
        for (const dispose of recoveryRefreshDisposers.current.splice(0)) {
          try { dispose() } catch (e) { /* ignore */ }
        }
      }, [])

      if (!view) {
        return React.createElement('div', { className: 'gg-dock' },
          React.createElement('div', { className: 'gg-idle' },
            React.createElement('span', { className: 'gg-badge normal' }, 'Git 操作建议 · 空闲'),
            React.createElement('span', { className: 'gg-idletext' }, '等待新的 git 操作提议…（git_propose 登记后这里会出现命令与按钮）'),
          ),
        )
      }

      const proposal: ProposalView = view
      const steps = proposal.steps && proposal.steps.length ? proposal.steps : [{ command: proposal.command, result: null }]
      const isHard = proposal.risk === 'hard'
      const isCopied = proposal.copied === true
      const isPending = !proposal.status || proposal.status === 'pending'
      const locallyFailed = outcome?.ok === false
      const canRun = isPending && !locallyFailed && !busy && (!isHard || understood)
      const canCopy = isPending && !locallyFailed && !busy && (!isHard || understood)

      const onRun = () => {
        if (!canRun) return
        setBusy(true)
        setOutcome(null)
        rpc({ action: 'execute', sessionId: String(sessionId), proposalId: proposal.proposalId, confirm: understood })
          .then((res) => {
            setOutcome(res || { ok: false, error: '无返回' })
            if (res && res.ok === true) scheduleClose(proposal.proposalId)
            else if (res) {
              props.onFailure(res as AnyRecord)
              if (recoveryProposalId(res)) {
                deferredRecoveryUntil.current = Date.now() + 1000
                let dispose: Dispose = () => {}
                const showRecovery = () => {
                  deferredRecoveryUntil.current = 0
                  recoveryRefreshDisposers.current = recoveryRefreshDisposers.current.filter((item: Dispose) => item !== dispose)
                  refresh()
                }
                if (timeoutFn) {
                  const scheduled = timeoutFn(showRecovery, 1000)
                  if (typeof scheduled === 'function') dispose = scheduled
                } else {
                  const timer = window.setTimeout(showRecovery, 1000)
                  dispose = () => window.clearTimeout(timer)
                }
                recoveryRefreshDisposers.current.push(dispose)
              }
            }
          })
          .catch((err) => { setOutcome({ ok: false, error: errorText(err) }) })
          .then(() => setBusy(false))
      }
      const onCopy = () => {
        try {
          const nav = typeof navigator !== 'undefined' ? navigator : null
          if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
            const text = steps.map((s: AnyRecord) => s.command).join(' && \\\n')
            nav.clipboard.writeText(text)
              .then(() => rpc({ action: 'mark-copied', sessionId: String(sessionId), proposalId: proposal.proposalId, confirm: understood }))
              .then((res) => {
                if (!res || res.ok !== true) setVerifyMsg((res && res.error) || '无法记录复制状态')
                refresh()
              })
              .catch((err) => setVerifyMsg('复制失败：' + errorText(err)))
          } else setVerifyMsg('当前环境不支持剪贴板 API，请逐条选择命令后手动复制')
        } catch (e) { setVerifyMsg('复制失败：' + errorText(e)) }
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
          .catch((err) => { setVerifyMsg(errorText(err)) })
      }

      const riskLabel = isHard ? '高风险' : proposal.risk === 'safe' ? '安全' : '常规'
      const badgeCls = isHard ? 'gg-badge hard' : proposal.risk === 'safe' ? 'gg-badge safe' : 'gg-badge normal'

      const renderSteps = () => steps.map((s: AnyRecord, i: number) => React.createElement('div', { className: 'gg-step', key: 'step' + i },
        React.createElement('span', { className: 'gg-stepnum' }, String(i + 1) + '.'),
        React.createElement('code', { className: 'gg-stepcode' }, String(s.command)),
      ))

      const headerEl = React.createElement('div', { className: 'gg-head', key: 'head' },
        React.createElement('span', null, 'Git 操作建议'),
        React.createElement('span', { className: badgeCls }, riskLabel),
        React.createElement('button', { className: 'gg-btn gg-toggle', onClick: () => setCollapsed(!collapsed), title: collapsed ? '展开' : '收缩' },
          collapsed ? '▸' : '▾',
        ),
      )

      if (collapsed) {
        return React.createElement('div', { className: 'gg-dock gg-dock-full' }, headerEl)
      }

      const lines = [headerEl]
      if (proposal.intent) lines.push(React.createElement('div', { className: 'gg-intent', key: 'intent' }, String(proposal.intent)))
      lines.push(React.createElement('div', { className: 'gg-steps', key: 'steps' }, renderSteps()))
      if (proposal.failure) {
        lines.push(React.createElement('div', { key: 'failure' }, renderFailureDetails(proposal.failure, proposal.recoverySuggestion || '')))
      } else if (proposal.explanation) {
        lines.push(React.createElement('div', { className: 'gg-expl', key: 'expl' }, String(proposal.explanation)))
      }

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

      if (isCopied && isPending) {
        lines.push(React.createElement('div', { className: 'gg-intent', key: 'copied' }, '命令已用 && 连接后复制，任一步失败都会停止。面板会比对复制前后的目标状态。'))
        if (verifyMsg) lines.push(React.createElement('div', { className: 'gg-riskline', key: 'vmsg' }, verifyMsg))
        const acts = []
        acts.push(React.createElement('button', { key: 'verify', className: 'gg-btn primary', onClick: onVerify }, '重新检测'))
        acts.push(React.createElement('button', { key: 'drop', className: 'gg-btn', onClick: () => doDismiss(proposal.proposalId) }, '放弃建议'))
        lines.push(React.createElement('div', { className: 'gg-actions', key: 'actions' }, acts))
        return React.createElement('div', { className: 'gg-dock gg-dock-full' }, lines)
      }

      if (proposal.status === 'running') {
        lines.push(React.createElement('div', { className: 'gg-intent', key: 'running' }, '命令正在执行，请勿重复提交…'))
      } else if (proposal.status === 'failed') {
        lines.push(React.createElement('div', { className: 'gg-riskline', key: 'failed' }, '该提议已经失败并锁定。请根据诊断创建修正提议，不会自动重放。'))
        if (canDismissFailedProposal(proposal.needsAgentAnalysis)) {
          lines.push(React.createElement('div', { className: 'gg-actions', key: 'failed-actions' },
            React.createElement('button', { className: 'gg-btn', onClick: () => doDismiss(proposal.proposalId) }, '关闭失败提议'),
          ))
        }
      } else if (isPending) {
        if (isHard) {
          lines.push(React.createElement('div', { className: 'gg-riskline', key: 'risk' }, '⚠ ' + ((proposal.reasons && proposal.reasons.length) ? proposal.reasons.join('；') : '该操作风险较高，可能造成不可逆的改动')))
          lines.push(React.createElement('label', { className: 'gg-check', key: 'ck' },
            React.createElement('input', { type: 'checkbox', checked: understood, onChange: (e: { target: { checked: boolean } }) => setUnderstood(e.target.checked) }),
            React.createElement('span', null, '我已了解风险，确认执行或复制'),
          ))
        }
        const actions = []
        actions.push(React.createElement('button', { key: 'run', className: 'gg-btn ' + (isHard ? 'danger' : 'primary'), disabled: !canRun, onClick: onRun },
          busy ? '执行中…' : (isHard ? '确认并直接执行' : '直接执行')))
        actions.push(React.createElement('button', { key: 'copy', className: 'gg-btn', disabled: !canCopy, onClick: onCopy }, '复制命令（手动执行）'))
        lines.push(React.createElement('div', { className: 'gg-actions', key: 'actions' }, actions))
      }

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
          const stepLines = outcome.steps.map((s: AnyRecord, i: number) => React.createElement('div', { className: 'gg-stepres', key: 'sr' + i },
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
          if (outcome.recovery && outcome.recovery.command) {
            lines.push(React.createElement('div', { className: 'gg-out gg-recovery', key: 'recovery' },
              React.createElement('div', { className: 'gg-ok' }, '💡 已生成修正建议' + (outcome.recovery.proposalId ? '（已登记为新的提议，可直接执行）' : '')),
              React.createElement('div', { className: 'gg-intent' }, String(outcome.recovery.suggestion || '')),
              React.createElement('code', { className: 'gg-stepcode' }, String(outcome.recovery.command)),
            ))
          } else if (outcome.recovery && outcome.recovery.suggestion) {
            lines.push(React.createElement('div', { className: 'gg-out gg-recovery', key: 'recovery' },
              React.createElement('div', { className: 'gg-riskline' }, '💡 ' + String(outcome.recovery.suggestion)),
            ))
          } else {
            lines.push(React.createElement('div', { className: 'gg-intent', key: 'hint' }, '执行失败。你可以描述下一步，或让我分析原因并给出修正命令。'))
          }
        }
      }

      return React.createElement('div', { className: 'gg-dock gg-dock-full' }, lines)
    }

    const plugin = {
      inject: ['slots', 'timer', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'conversation'],
      apply(ctx: AnyRecord) {
        if (typeof ctx.effect === 'function') ctx.effect(injectStyles, 'easygit: styles')
        else injectStyles()

        const slots = ctx.get('slots')
        if (!slots) return

        const timer = ctx.get('timer') || ctx.timer
        const intervalFn = timer && typeof timer.interval === 'function' ? timer.interval.bind(timer) : null
        const timeoutFn = timer && typeof timer.timeout === 'function' ? timer.timeout.bind(timer) : null
        const openWorkbench = registerWorkbench(ctx, (panelProps) => React.createElement(GitWorkbenchPanel, {
          ...panelProps,
          intervalFn,
          timeoutFn,
        }))
        slots.inject('conversation.input.left', () => slots.register(
          { name: 'conversation.input.left', id: 'git-workbench', order: 30, label: 'Git 工作台' },
          (props: AnyRecord) => React.createElement(GitWorkbenchAction, { sessionId: props.sessionId, openWorkbench, intervalFn }),
        ))
      },
      __testing: {
        GitChangesTab,
        GitCommitActions,
        GitMergeTab, GitStashesTab, GitConflictsTab, parseConflictBlocks, chooseConflictBlock, conflictLineRanges, registerWorkbench, requestAgentAnalysis, buildFileTree, parseReviewRows, renderRawDiffSurface, renderReviewSurface, injectStyles, filterLocalBranches,
        deriveCommitGraph, repositoryName, mutationCommand, appendCommandLog,
        refreshButtonLabel, recoveryProposalId, openRecoveryProposal, analysisProposalId, failureContext, buildAgentRepairPrompt,
        shouldShowAnalysisBanner, canDismissFailedProposal, pendingProposalTransition,
        isCurrentCommitRequest, nextCommitSelection, commitFileTone, isLatestRequest,
        beginTrackedRequest, cancelTrackedRequest, isTrackedRequestCurrent,
      },
    }

export = plugin
