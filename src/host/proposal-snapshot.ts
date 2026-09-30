import { quoteShellArg } from './command-policy'

// Hash inside the existing Shell sandbox; include contents even when porcelain status is unchanged.
const worker = String.raw`
const fs = require('node:fs'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore','pipe','pipe'] });
process.chdir(git('rev-parse', '--show-toplevel').toString().trim());
const hash = crypto.createHash('sha256');
for (const args of [['status','--porcelain=v1','-z','--untracked-files=all'], ['ls-files','--stage','-z'], ['for-each-ref','--format=%(refname) %(objectname)'], ['rev-parse','--verify','HEAD'], ['symbolic-ref','-q','HEAD'], ['config','--local','--null','--list']]) {
  try { hash.update(git(...args)); } catch (e) { if (e.status !== 1 && e.status !== 128) throw e; hash.update('absent'); }
}
for (const file of new Set(git('ls-files','--cached','--others','--exclude-standard','-z').toString().split('\0').filter(Boolean))) {
  hash.update(file + '\0');
  let stat; try { stat = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; hash.update('deleted'); continue; }
  hash.update(String(stat.mode));
  if (stat.isSymbolicLink()) { hash.update(fs.readlinkSync(file)); continue; }
  if (!stat.isFile()) continue;
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(65536);
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0,size)); }
  finally { fs.closeSync(fd); }
}
console.log(hash.digest('hex'));
`
export const proposalSnapshotCommand = 'node -e ' + quoteShellArg(worker)
