import { quoteShellArg } from './command-policy'

// File IO stays inside the session's Shell sandbox, just like conflict-worker.
const worker = String.raw`
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const env = { ...process.env };
const literal = names => names.map(name => ':(literal)' + name);
const git = (args, extra = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env, ...extra });
let temporary;
try {
  process.chdir(git(['rev-parse', '--show-toplevel']).trim());
  const records = git(['status', '--porcelain=v1', '--untracked-files=all', '-z']).split('\0');
  const changes = [];
  for (let i = 0; i < records.length - 1; i++) {
    const row = records[i];
    const status = row.slice(0, 2);
    const file = { path: row.slice(3), status };
    if (/[RC]/.test(status)) file.originalPath = records[++i];
    if (status.includes('U') || status === 'AA' || status === 'DD') throw new Error('请先解决冲突，再创建贮藏');
    changes.push(file);
  }
  const eligible = changes.filter(file => input.includeUntracked || file.status !== '??');
  const selected = input.paths ? [...new Set(input.paths)].flatMap(name => {
    const files = eligible.filter(file => file.path === name);
    if (!files.length) throw new Error('所选文件已变化或未启用包含未跟踪文件，请刷新：' + name);
    return files;
  }) : eligible;
  if (!selected.length) throw new Error('没有可贮藏的改动');
  const args = ['stash', 'push'];
  if (input.includeUntracked) args.push('--include-untracked');
  if (input.message.trim()) args.push('--message', input.message.trim());
  if (!input.paths) {
    git(args);
  } else {
    // Native path-limited stash also captures unrelated staged files, and
    // staged deletions can fail during its cleanup. Build the standard stash
    // trees in a temporary index, store them, then restore only selected paths.
    const tracked = selected.filter(file => file.status !== '??');
    const untracked = selected.filter(file => file.status === '??');
    const paths = [...new Set(tracked.flatMap(file => file.originalPath && file.status.includes('R') ? [file.path, file.originalPath] : [file.path]))];
    if (paths.some(name => changes.some(file => file.path === name && file.status === '??') && !untracked.some(file => file.path === name))) {
      throw new Error('已删除或重命名的路径上存在未跟踪文件，请同时选择该文件并包含未跟踪文件');
    }
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'easygit-stash-'));
    const isolated = { ...env, GIT_INDEX_FILE: path.join(temporary, 'index') };
    const base = git(['rev-parse', 'HEAD']).trim();
    git(['read-tree', base], { env: isolated });
    const intentPaths = tracked.filter(file => file.status === ' A').map(file => file.path);
    if (paths.length) {
      // Copy object IDs/modes directly; a textual diff can be altered by user
      // color, prefix or whitespace settings. Missing entries represent deletes.
      const entries = git(['ls-files', '--stage', '-z', '--', ...literal(paths)]).split('\0')
        .filter(row => row && !intentPaths.includes(row.slice(row.indexOf('\t') + 1)));
      const removed = paths.map(name => '0 ' + '0'.repeat(base.length) + '\t' + name);
      git(['update-index', '-z', '--index-info'], { env: isolated, input: [...removed, ...entries].join('\0') + '\0' });
    }
    const indexTree = git(['write-tree'], { env: isolated }).trim();
    if (intentPaths.length) git(['add', '--', ...literal(intentPaths)], { env: isolated });
    // -u records tracked worktree edits/deletions without absorbing untracked files.
    const indexed = git(['ls-files', '-z'], { env: isolated }).split('\0');
    const workPaths = paths.filter(name => indexed.includes(name));
    if (workPaths.length) git(['add', '-u', '--', ...literal(workPaths)], { env: isolated });
    const workTree = git(['write-tree'], { env: isolated }).trim();
    const indexCommit = git(['commit-tree', indexTree, '-p', base], { input: 'index for selected stash\n' }).trim();
    const parents = ['-p', base, '-p', indexCommit];
    if (untracked.length) {
      git(['read-tree', '--empty'], { env: isolated });
      git(['add', '--', ...literal(untracked.map(file => file.path))], { env: isolated });
      const tree = git(['write-tree'], { env: isolated }).trim();
      parents.push('-p', git(['commit-tree', tree], { input: 'untracked files for selected stash\n' }).trim());
    }
    const branch = git(['branch', '--show-current']).trim() || '(detached HEAD)';
    const message = 'On ' + branch + ': ' + (input.message.trim() || 'selected changes');
    const stash = git(['commit-tree', workTree, ...parents], { input: message + '\n' }).trim();
    git(['stash', 'store', '--message', message, stash]);
    // All selected versions are durable before changing the working files/index.
    if (paths.length) git(['restore', '--source=' + base, '--staged', '--worktree', '--', ...literal(paths)]);
    for (const file of untracked) {
      // A recreated, previously tracked path has just been restored from HEAD.
      if (!paths.includes(file.path)) fs.unlinkSync(file.path);
    }
  }
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: 'GIT_FAILED', message: '创建贮藏失败；请刷新确认当前状态', diagnostics: String(error.stderr || error.message) }));
} finally {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
}
`

export function createStashCommand(message: string, paths: string[] | undefined, includeUntracked: boolean): string {
  const payload = Buffer.from(JSON.stringify({ message, paths, includeUntracked })).toString('base64')
  return 'node -e ' + quoteShellArg(worker) + ' ' + quoteShellArg(payload)
}
