import { readFile, appendFile } from 'node:fs/promises'

const { release } = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
const tag = release?.tag_name
// npm versions intentionally exclude build metadata (+...) to keep tags unambiguous.
const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/.exec(tag ?? '')
if (!match || match[0] !== tag || match[2]?.split('.').some(part => /^\d+$/.test(part) && /^0\d/.test(part))) {
  throw new Error('Release 标签必须为 vX.Y.Z 或 vX.Y.Z-beta.1 等有效版本，不支持 + 构建元数据')
}
const version = match[1]
const prerelease = Boolean(match[2])
if (release.draft || typeof release.prerelease !== 'boolean' || release.prerelease !== prerelease) {
  throw new Error('Release 的 pre-release 选项必须与版本后缀一致，且不能是草稿')
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
if (pkg.version !== version || lock.version !== version || lock.packages[''].version !== version) {
  throw new Error('package.json、锁文件与 Release 版本不一致')
}
const distTag = prerelease ? 'beta' : 'latest'
await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ndist-tag=${distTag}\n`)
console.log(`准备发布 ${pkg.name}@${version}，npm 渠道：${distTag}`)
