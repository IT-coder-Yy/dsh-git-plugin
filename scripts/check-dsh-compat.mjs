import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Run against an independently installed release, never the user's DSH_HOME.
assert.ok(process.env.DSH_INSTALL_DIR, '请设置 DSH_INSTALL_DIR，指向单独安装 @deepseek-ai/dsh 的 npm prefix')
const installation = createRequire(join(resolve(process.env.DSH_INSTALL_DIR), 'package.json'))
const anchor = installation.resolve('@deepseek-ai/dsh/package.json')
const version = JSON.parse(readFileSync(anchor, 'utf8')).version
if (process.env.DSH_VERSION) assert.equal(version, process.env.DSH_VERSION)
const requireDsh = createRequire(anchor)
const load = name => import(pathToFileURL(requireDsh.resolve(name)).href)
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'easygit-dsh-compat-'))
const repo = join(root, 'repo')
mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_TELEMETRY_DISABLED = '1'
// Only disposable test repositories are used; no external sandbox binary is required.
process.env.DSH_PERMISSION_MODE = 'danger-full-access'
process.chdir(root)
let runtime
try {
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Compatibility Test')
  git('config', 'user.email', 'compat@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'file.txt'), 'initial\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  const { runProfile, prepareProfile } = await load('@deepseek-ai/dsh/profile-boot')
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
  prepareProfile('web')
  const modules = join(process.env.DSH_HOME, 'profiles/web/node_modules')
  mkdirSync(modules, { recursive: true })
  symlinkSync(project, join(modules, 'dsh-easygit-plugin'), 'dir')
  const patch = join(root, 'plugin.yml')
  writeFileSync(patch, '- insert:\n    - id: easygit\n      name: dsh-easygit-plugin\n')
  runtime = await runProfile({
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
    profile: 'web', patchFiles: [patch], args: ['--port', '0', '--no-open'],
  })
  const { ctx } = runtime
  assert.ok(ctx.get('permissionPresets'), '完整权限预设服务应正常加载')
  const base = `http://127.0.0.1:${ctx.get('webServer').port}/`
  const login = await fetch(ctx.get('connection').authenticatedUrl(base), { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'DSH 应颁发浏览器认证 cookie')
  assert.equal((await fetch(base + 'easygit', { method: 'POST' })).status, 401)
  const post = async body => {
    const response = await fetch(base + 'easygit', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const controller = ctx.get('sessionController')
  const { sessionId } = await controller.create({ cwd: repo })
  const { agent, error } = await controller.resolveAgent(sessionId)
  assert.ifError(error)
  const action = (name, extra = {}) => post({ action: name, sessionId, ...extra })
  const tool = async (name, args = {}) => {
    const result = await ctx.get('tools').execute({ callId: randomUUID(), name, arguments: args, agent, signal: AbortSignal.timeout(30_000) })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.ok, true, JSON.stringify(result.value))
    return result.value
  }
  assert.equal((await action('get-summary')).data.topLevel, repo)
  assert.equal((await tool('git_repo_state')).topLevel, repo)
  writeFileSync(join(repo, 'file.txt'), 'changed\n')
  assert.equal((await action('stage-all', { operationId: randomUUID() })).ok, true)
  assert.equal((await action('commit', { operationId: randomUUID(), message: 'test: compatibility' })).ok, true)
  assert.equal(git('log', '-1', '--format=%s').trim(), 'test: compatibility')
  const chat = await action('side-chat')
  assert.equal(chat.ok, true, JSON.stringify(chat))
  assert.notEqual(chat.sessionId, sessionId)
  assert.equal((await action('side-chat')).sessionId, chat.sessionId)
  const child = await controller.resolveAgent(chat.sessionId)
  assert.ifError(child.error)
  const tools = child.agent.ctx.get('tools').schemas(child.agent).map(entry => entry.name)
  assert.ok(tools.includes('git_propose'))
  assert.ok(!tools.includes('bash') && !tools.includes('write'))
  const entry = ctx.get('clientModules').graph().entries.find(item => item.id === 'dsh-easygit-plugin')
  assert.ok(entry, '客户端应进入真实 DSH 模块加载图')
  const bundle = await fetch(new URL(entry.url, base), { headers: { cookie } })
  assert.equal(bundle.status, 200)
  assert.match(await bundle.text(), /dsh-easygit-plugin/)
  const directories = ctx.get('workingDirectory')
  if (version === '0.2.1-alpha.2') assert.ok(directories, '新版工作目录服务应正常加载')
  if (directories) {
    const proposal = await tool('git_propose', { command: 'git branch stale-compat', intent: '检查旧建议', explanation: '兼容性测试' })
    const worktree = join(repo, 'worktree')
    git('worktree', 'add', '-qb', 'compat-worktree', worktree)
    await directories.set(agent, worktree)
    assert.equal(agent.session.header.cwd, repo)
    assert.equal(ctx.get('sandboxPolicy').resolve({ session: agent.session }).workspaceRoot, repo)
    assert.equal((await action('get-summary')).data.topLevel, worktree)
    assert.equal((await tool('git_repo_state')).topLevel, worktree)
    const stale = await action('execute', { proposalId: proposal.proposalId })
    assert.equal(stale.ok, false)
    assert.match(stale.error, /工作目录已变化/)
    assert.equal(git('branch', '--list', 'stale-compat').trim(), '')
    assert.equal((await action('side-chat')).sessionId, chat.sessionId)
  }
  console.log(`DSH ${version}：Host 加载、客户端分发、认证、Git 读写、助手会话${directories ? '、worktree 切换与旧建议拦截' : '、旧目录接口'}通过。`)
} finally {
  try { await runtime?.shutdown.shutdown(process.exitCode ?? 0) }
  finally { process.chdir(project); rmSync(root, { recursive: true, force: true }) }
}
