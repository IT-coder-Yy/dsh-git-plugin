import { quoteShellArg } from './command-policy'

// Runs inside the same Harness Shell sandbox as every Git action. Keeping file IO
// here avoids bypassing the session's filesystem permissions from the Host process.
const worker = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const LIMIT = 48 * 1024;
const fail = (message, code = 'STATE_CONFLICT') => { throw Object.assign(new Error(message), { code }); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const exists = file => fs.existsSync(file);
const gitPath = name => git('rev-parse', '--git-path', name).trim();
function squashState() {
  const file = gitPath('easygit-squash.json');
  if (!exists(file) || !exists(gitPath('SQUASH_MSG'))) return null;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  // A commit or branch switch outside the workbench ends our ownership.
  if (saved.head !== git('rev-parse', 'HEAD').trim() || saved.branch !== 'refs/heads/' + git('branch', '--show-current').trim()) return null;
  return saved;
}
function operationState() {
  const dir = name => git('rev-parse', '--git-path', name).trim();
  const names = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'sequencer', 'REVERT_HEAD'];
  const paths = names.map(dir);
  const squash = squashState();
  const todo = exists(path.join(paths[4], 'todo')) ? fs.readFileSync(path.join(paths[4], 'todo'), 'utf8') : '';
  const operation = exists(paths[0]) || exists(paths[1]) ? 'rebase' : exists(paths[2]) ? 'merge' : exists(paths[3]) || /^pick /m.test(todo) ? 'cherry-pick' : exists(paths[5]) || /^revert /m.test(todo) ? 'revert' : squash ? 'merge' : null;
  const meta = ['HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge/head-name', 'rebase-merge/onto', 'rebase-merge/msgnum', 'rebase-merge/stopped-sha', 'rebase-apply/next', 'rebase-apply/orig-head', 'sequencer/todo'].map(name => {
    const file = dir(name); return exists(file) ? fs.readFileSync(file).toString('base64') : '';
  });
  let head;
  try { head = git('rev-parse', '--verify', 'HEAD').trim(); }
  catch (error) {
    const branch = git('symbolic-ref', '--quiet', 'HEAD').trim();
    if (exists(dir(branch))) throw error;
    head = 'unborn:' + branch;
  }
  return { operation, ...(squash && operation === 'merge' ? { mergeMode: 'squash' } : {}), operationToken: hash(JSON.stringify([operation, meta, head, squash])) };
}
function mergeSnapshot() {
  if (typeof input.target !== 'string' || !/^refs\/(heads|remotes)\/.+/.test(input.target) || /[\0\r\n]/.test(input.target)) fail('请选择本地或远程源分支', 'INVALID_ARGUMENT');
  git('check-ref-format', input.target);
  const name = git('branch', '--show-current').trim();
  if (!name) fail('分离 HEAD 状态不能合并分支，请先切换到本地分支');
  const branch = 'refs/heads/' + name;
  if (branch === input.target) fail('不能将当前分支合并到自身');
  const head = git('rev-parse', '--verify', 'HEAD').trim();
  const sourceHead = git('rev-parse', '--verify', '--end-of-options', input.target + '^{commit}').trim();
  return { branch: branch.slice('refs/heads/'.length), target: input.target, head, sourceHead, token: hash(JSON.stringify([branch, input.target, head, sourceHead])) };
}
function ancestor(a, b) {
  try { git('merge-base', '--is-ancestor', a, b); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
function previewMerge() {
  const snapshot = mergeSnapshot();
  const { head, sourceHead } = snapshot;
  let base;
  try { base = git('merge-base', head, sourceHead).trim(); }
  catch (error) { if (error.status === 1) fail('两个分支没有共同祖先，不支持合并无关历史'); throw error; }
  const fields = git('log', '--no-color', '--max-count=201', '--format=%H%x00%s%x00%an%x00%aI%x00', head + '..' + sourceHead).split('\0');
  const commits = [];
  for (let i = 0; i + 3 < fields.length; i += 4) commits.push({ hash: fields[i].trim(), subject: fields[i + 1], author: fields[i + 2], date: fields[i + 3] });
  const files = git('diff', '--name-only', '-z', base, sourceHead, '--').split('\0').filter(Boolean);
  let diff, overflow = false;
  try { diff = git('-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', base, sourceHead, '--'); }
  catch (error) { if (error.code !== 'ENOBUFS') throw error; diff = String(error.stdout || ''); overflow = true; }
  return { ...snapshot, base, canFastForward: ancestor(head, sourceHead), alreadyMerged: ancestor(sourceHead, head), commits: commits.slice(0, 200), commitsTruncated: commits.length > 200, files: files.slice(0, 500), filesTruncated: files.length > 500, diff: diff.slice(0, 180000), diffTruncated: overflow || diff.length > 180000 };
}
function entries() {
  return git('ls-files', '--unmerged', '-z').split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) ([0-9a-f]+) ([123])\t([\s\S]*)$/.exec(row);
    if (!match) fail('无法读取完整冲突索引');
    return { mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] };
  });
}
function state() {
  const grouped = new Map();
  for (const entry of entries()) {
    if (!grouped.has(entry.path)) grouped.set(entry.path, []);
    grouped.get(entry.path).push(entry.stage);
  }
  return { ...operationState(), files: [...grouped].map(([file, stages]) => ({ path: file, stages, kind: !stages.includes(1) ? '双方新增' : !stages.includes(2) || !stages.includes(3) ? '删除 / 修改' : '双方修改' })) };
}
function safePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\0') || path.isAbsolute(file) || file.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) fail('无效的仓库相对路径', 'INVALID_ARGUMENT');
  let current = process.cwd();
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) fail('符号链接冲突请在外部工具中处理');
      if (i < parts.length - 1 && !stat.isDirectory()) fail('路径包含非目录节点');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
function version(buffer, mode = null) {
  if (buffer === null) return { exists: false, text: null, mode, reason: null };
  const text = buffer.toString('utf8');
  const reason = !['100644', '100755', null].includes(mode) ? '符号链接或子模块，请使用外部工具处理' : buffer.length > LIMIT ? '文件超过 48 KiB，请使用外部工具处理' : buffer.includes(0) || !Buffer.from(text).equals(buffer) ? '二进制或非 UTF-8 文件，可选择整份一方版本' : null;
  return { exists: true, text: reason ? null : text, mode, reason };
}
function detail(file) {
  const rows = entries().filter(row => row.path === file);
  if (!rows.length) fail('该文件已不在冲突列表中，请刷新');
  const full = safePath(file);
  let working = null;
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile()) fail('目录、符号链接或子模块冲突请在外部工具中处理');
    if (stat.size > 8 * 1024 * 1024) fail('文件过大，请使用外部工具处理');
    working = fs.readFileSync(full);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const versions = [1, 2, 3].map(stage => {
    const row = rows.find(row => row.stage === stage);
    if (!row) return version(null);
    if (!['100644', '100755'].includes(row.mode)) return { exists: true, text: null, mode: row.mode, reason: '符号链接或子模块，请使用外部工具处理' };
    const size = Number(git('cat-file', '-s', row.oid).trim());
    if (size > LIMIT) return { exists: true, text: null, mode: row.mode, reason: '文件超过 48 KiB，请使用外部工具处理' };
    return version(execFileSync('git', ['cat-file', 'blob', row.oid], { maxBuffer: LIMIT + 1024 }), row.mode);
  });
  const op = operationState();
  const squash = op.mergeMode === 'squash' ? squashState() : null;
  for (const [index, ref] of [[1, 'HEAD'], [2, op.operation === 'merge' ? 'MERGE_HEAD' : op.operation === 'rebase' ? 'REBASE_HEAD' : op.operation === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : null]]) {
    const row = rows.find(row => row.stage === index + 1);
    versions[index].source = row ? '索引 stage ' + (index + 1) + ' · blob ' + row.oid.slice(0, 12) : '该方无文件';
    if (ref && op.operation) {
      try { versions[index].source = ref + ' · ' + git('rev-parse', '--verify', ref + '^{commit}').trim().slice(0, 12); } catch {}
    }
    if (index === 2 && squash) versions[index].source = '压缩合并源 · ' + squash.sourceHead.slice(0, 12);
  }
  const result = version(working);
  const attr = git('check-attr', '-z', 'conflict-marker-size', '--', file).split('\0')[2];
  const markerSize = /^\d+$/.test(attr || '') ? Number(attr) : 7;
  if (markerSize < 1 || markerSize > 1024) fail('冲突标记长度不受支持，请使用外部工具处理');
  return { path: file, operation: op.operation, token: hash(JSON.stringify([rows, op.operationToken, working === null ? null : working.toString('base64')])), base: versions[0], ours: versions[1], theirs: versions[2], result, editable: versions.every(v => !v.reason) && !result.reason, special: !versions[1].exists || !versions[2].exists || versions.some(v => !!v.reason) || !!result.reason, markerSize };
}
function markers(text, size) {
  return text.split(/\r?\n/).some(line => ['<', '|', '=', '>'].some(c =>
    line.startsWith(c.repeat(size)) && (line.length === size || /^[ \t]/.test(line.slice(size)))
  ));
}
function commitEditState() {
  const head = git('rev-parse', '--verify', 'HEAD').trim();
  const branch = git('branch', '--show-current').trim();
  const op = operationState();
  const index = git('ls-files', '--stage', '-z');
  return {
    head, branch, message: git('show', '-s', '--format=%B', head).replace(/\n$/, ''),
    parents: git('show', '-s', '--format=%P', head).trim().split(' ').filter(Boolean),
    staged: !!git('diff', '--cached', '--name-only', '-z'),
    dirty: !!git('status', '--porcelain', '--untracked-files=all'),
    blocked: !!op.operation || !!entries().length,
    token: hash(JSON.stringify([head, branch, index, op.operationToken])),
  };
}
function editCommit() {
  if (input.confirmRisk !== true) fail('请先确认提交操作的影响', 'PERMISSION_DENIED');
  const snapshot = commitEditState();
  if (snapshot.blocked) fail('请先完成或中止当前 Git 操作并解决冲突');
  if (!snapshot.branch) fail('请先切换到本地分支');
  if (input.token !== snapshot.token) fail('分支、最近提交或暂存区已变化，请刷新后重新确认');
  if (input.action === 'amend-message') {
    if (typeof input.message !== 'string' || !input.message.trim() || Buffer.byteLength(input.message) > LIMIT || /[\0\r]/.test(input.message)) fail('提交说明必须是 48 KiB 以内的非空文本，不得包含 NUL 或回车', 'INVALID_ARGUMENT');
    // --only without paths amends the message while preserving the real index.
    git('commit', '--amend', '--only', '--allow-empty', '--cleanup=verbatim', '-m', input.message);
  } else if (input.action === 'amend-commit') {
    if (!snapshot.staged) fail('没有已暂存的改动，请先暂存需要补充的文件');
    git('commit', '--amend', '--no-edit', '--cleanup=verbatim');
  } else if (input.action === 'undo-commit') {
    if (!snapshot.parents.length) fail('根提交没有父提交，无法执行保留暂存区的撤销');
    git('reset', '--soft', snapshot.parents[0]);
  } else {
    if (snapshot.dirty) fail('Revert 前请先提交或贮藏工作区改动');
    if (typeof input.hash !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.hash)) fail('请选择完整的提交 SHA', 'INVALID_ARGUMENT');
    if (!ancestor(input.hash, snapshot.head)) fail('目标提交不在当前分支历史中');
    const parents = git('show', '-s', '--format=%P', input.hash).trim().split(' ').filter(Boolean);
    if (parents.length > 1) {
      if (!Number.isInteger(input.mainline) || input.mainline < 1 || input.mainline > parents.length) fail('Revert 合并提交前必须选择主线父提交', 'INVALID_ARGUMENT');
    } else if (input.mainline !== undefined) fail('普通提交无需选择主线父提交', 'INVALID_ARGUMENT');
    git('revert', '--no-edit', ...(parents.length > 1 ? ['-m', String(input.mainline)] : []), input.hash);
  }
  return state();
}
function main() {
  process.chdir(git('rev-parse', '--show-toplevel').trim());
  if (input.action === 'get-commit-edit-state') return commitEditState();
  if (['amend-message', 'amend-commit', 'undo-commit', 'revert-commit'].includes(input.action)) return editCommit();
  if (input.action === 'get-merge-preview') return previewMerge();
  if (input.action === 'merge-branch') {
    if (!['normal', 'ff-only', 'squash'].includes(input.mode)) fail('无效的合并方式', 'INVALID_ARGUMENT');
    if (state().operation || entries().length) fail('请先完成或中止当前 Git 操作');
    if (git('status', '--porcelain', '--untracked-files=all').trim()) fail('合并前请先提交或贮藏工作区改动');
    const snapshot = mergeSnapshot();
    if (snapshot.token !== input.token) fail('分支已变化，请重新预览后合并');
    if (ancestor(snapshot.sourceHead, snapshot.head)) return state();
    if (input.mode === 'squash') {
      fs.writeFileSync(gitPath('easygit-squash.json'), JSON.stringify({ head: snapshot.head, branch: 'refs/heads/' + snapshot.branch, sourceHead: snapshot.sourceHead }));
    }
    // Explicit flags keep user merge.ff / branch mergeOptions from changing the selected mode.
    try {
      git('-c', 'merge.autoStash=false', 'merge', '--no-edit', '--no-autostash', '--no-overwrite-ignore', ...(input.mode === 'squash' ? ['--squash', '--ff', '--no-commit'] : input.mode === 'ff-only' ? ['--ff-only', '--no-squash', '--commit'] : ['--ff', '--no-squash', '--commit']), snapshot.sourceHead);
    } catch (error) {
      if (input.mode === 'squash' && !entries().length && !git('status', '--porcelain').trim()) fs.unlinkSync(gitPath('easygit-squash.json'));
      throw error;
    }
    return state();
  }
  if (input.action === 'get-conflicts') return state();
  if (input.action === 'get-conflict') return detail(input.path);
  if (input.action === 'save-conflict' || input.action === 'resolve-conflict') {
    const before = detail(input.path);
    if (typeof input.token !== 'string' || input.token !== before.token) fail('文件或冲突状态已被外部修改，请刷新后重新处理');
    const full = safePath(input.path);
    if (input.action === 'save-conflict') {
      if (!before.editable) fail('该文件不支持文本编辑');
      const content = Buffer.from(input.contentBase64, 'base64');
      if (content.length > LIMIT || content.includes(0)) fail('结果必须是 48 KiB 以内的 UTF-8 文本', 'INVALID_ARGUMENT');
      const parent = path.dirname(full);
      fs.mkdirSync(parent, { recursive: true });
      const mode = exists(full) ? fs.statSync(full).mode : parseInt(before.ours.mode || before.theirs.mode || '100644', 8);
      const temp = path.join(parent, '.easygit-' + crypto.randomUUID());
      try {
        fs.writeFileSync(temp, content, { flag: 'wx', mode });
        if (detail(input.path).token !== before.token) fail('保存前文件发生变化，请刷新');
        fs.renameSync(temp, full);
      } finally { if (exists(temp)) fs.unlinkSync(temp); }
      return detail(input.path);
    }
    if (!['result', 'ours', 'theirs', 'delete'].includes(input.choice)) fail('无效的解决方式', 'INVALID_ARGUMENT');
    if (['ours', 'theirs'].includes(input.choice)) {
      const selected = before[input.choice];
      if (!selected.exists) fail('该方版本不存在，请明确选择删除文件');
      if (selected.reason && !selected.reason.startsWith('二进制')) fail(selected.reason);
      if (selected.text !== null && markers(selected.text, before.markerSize)) fail('所选版本仍包含冲突标记，请手动编辑');
      git('checkout', '--' + input.choice, '--', ':(literal)' + input.path);
    } else if (input.choice === 'delete') {
      if (exists(full)) fs.unlinkSync(full);
    } else {
      if (before.result.text === null) fail('请明确选择一方、删除文件或在外部工具中处理');
      if (markers(before.result.text, before.markerSize)) fail('结果中仍有冲突标记，请先逐块解决并保存');
    }
    git('add', '--', ':(literal)' + input.path);
    return state();
  }
  if (input.action === 'start-operation') {
    if (!['merge', 'rebase', 'cherry-pick'].includes(input.kind)) fail('不支持的 Git 操作', 'INVALID_ARGUMENT');
    if (input.confirmRisk !== true) fail('请先确认 Git 操作风险', 'PERMISSION_DENIED');
    if (state().operation || entries().length) fail('请先完成或中止当前 Git 操作');
    if (git('status', '--porcelain').trim()) fail('请先提交或贮藏工作区改动');
    if (typeof input.target !== 'string' || !input.target || input.target.startsWith('-') || /[\0\r\n]/.test(input.target)) fail('无效的目标引用', 'INVALID_ARGUMENT');
    const oid = git('rev-parse', '--verify', '--end-of-options', input.target + '^{commit}').trim();
    git(...(input.kind === 'merge' ? ['merge', '--no-edit', oid] : [input.kind, oid]));
    return state();
  }
  if (input.action === 'finish-operation') {
    const current = state();
    if (input.confirmRisk !== true) fail('请先确认继续、中止或跳过的风险', 'PERMISSION_DENIED');
    if (!current.operation || current.operation !== input.kind || current.operationToken !== input.token) fail('Git 操作状态已改变，请刷新');
    if (!['continue', 'abort', 'skip'].includes(input.mode) || (input.mode === 'skip' && input.kind === 'merge')) fail('不支持的后续操作', 'INVALID_ARGUMENT');
    if (input.mode === 'continue' && current.files.length) fail('仍有未标记解决的冲突文件');
    if (current.mergeMode === 'squash') {
      const saved = squashState();
      if (input.mode === 'abort') git('reset', '--merge', saved.head);
      else git('commit', '--no-edit', '-F', gitPath('SQUASH_MSG'));
      fs.unlinkSync(gitPath('easygit-squash.json'));
      if (exists(gitPath('SQUASH_MSG'))) fs.unlinkSync(gitPath('SQUASH_MSG'));
    } else git(input.kind, '--' + input.mode);
    return state();
  }
  fail('无效操作', 'INVALID_ARGUMENT');
}
try { console.log(JSON.stringify({ ok: true, data: main() })); }
catch (error) {
  let pending = null;
  try { pending = state(); } catch {}
  // A new conflict is an expected stop in a multi-step Git operation.
  if ((input.action === 'start-operation' || input.action === 'merge-branch' || input.action === 'revert-commit' || (input.action === 'finish-operation' && input.mode !== 'abort')) && error.status && pending && pending.operation === (input.action === 'merge-branch' ? 'merge' : input.action === 'revert-commit' ? 'revert' : input.kind) && (pending.files.length || input.action === 'revert-commit')) {
    console.log(JSON.stringify({ ok: true, data: pending }));
  } else console.log(JSON.stringify({ ok: false, code: ['STATE_CONFLICT', 'INVALID_ARGUMENT', 'PERMISSION_DENIED'].includes(error.code) ? error.code : 'GIT_FAILED', message: error.status ? 'Git 操作未完成，请查看详情' : error.message, diagnostics: [error.stdout, error.stderr].filter(Boolean).map(value => value.toString()).join('\n') || undefined }));
}
`

export function conflictWorkerCommand(action: string, payload: Record<string, unknown>): string {
  const data = { ...payload }
  if (typeof data.content === 'string') {
    data.contentBase64 = Buffer.from(data.content).toString('base64')
    delete data.content
  }
  return quoteShellArg(process.execPath) + ' -e ' + quoteShellArg(worker) + ' ' + quoteShellArg(Buffer.from(JSON.stringify({ ...data, action })).toString('base64'))
}
