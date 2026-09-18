"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/host/command-policy.ts
function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
function parseCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) return { ok: false, error: "\u547D\u4EE4\u4E3A\u7A7A" };
  if (command.length > MAX_COMMAND_LENGTH) return { ok: false, error: "\u547D\u4EE4\u8FC7\u957F\uFF08\u6700\u591A 800 \u5B57\u7B26\uFF09" };
  if (/\0|\r|\n/.test(command)) return { ok: false, error: "\u6BCF\u4E2A\u6B65\u9AA4\u53EA\u80FD\u5305\u542B\u4E00\u6761\u547D\u4EE4\uFF0C\u591A\u6B65\u64CD\u4F5C\u8BF7\u4F7F\u7528 steps \u6570\u7EC4" };
  const args = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = null;
      else current += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "$" || character === "`") return { ok: false, error: "\u53CC\u5F15\u53F7\u5185\u4E0D\u5141\u8BB8 shell \u5C55\u5F00\uFF08$ \u6216\u53CD\u5F15\u53F7\uFF09" };
      if (character === "\\") {
        if (index + 1 >= command.length) return { ok: false, error: "\u547D\u4EE4\u672B\u5C3E\u5B58\u5728\u4E0D\u5B8C\u6574\u7684\u8F6C\u4E49" };
        const next = command[index += 1] ?? "";
        current += ['"', "\\", "$", "`"].includes(next) ? next : "\\" + next;
      } else current += character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      if (index + 1 >= command.length) return { ok: false, error: "\u547D\u4EE4\u672B\u5C3E\u5B58\u5728\u4E0D\u5B8C\u6574\u7684\u8F6C\u4E49" };
      current += command[index += 1] ?? "";
      started = true;
      continue;
    }
    if (";&|<>".includes(character)) return { ok: false, error: "\u547D\u4EE4\u5305\u542B shell \u63A7\u5236\u7B26\uFF08; & | < >\uFF09\uFF0C\u591A\u6B65\u64CD\u4F5C\u8BF7\u4F7F\u7528 steps \u6570\u7EC4" };
    if (character === "$" || character === "`") return { ok: false, error: "\u547D\u4EE4\u5305\u542B shell \u5C55\u5F00\uFF08$ \u6216\u53CD\u5F15\u53F7\uFF09" };
    current += character;
    started = true;
  }
  if (quote) return { ok: false, error: "\u547D\u4EE4\u5305\u542B\u672A\u95ED\u5408\u7684\u5F15\u53F7" };
  if (started) args.push(current);
  if (args.length < 2 || args[0] !== "git") return { ok: false, error: "\u53EA\u5141\u8BB8\u201Cgit <\u5B50\u547D\u4EE4> ...\u201D\u683C\u5F0F" };
  if (args.length > 80) return { ok: false, error: "\u547D\u4EE4\u53C2\u6570\u8FC7\u591A\uFF08\u6700\u591A 80 \u4E2A\uFF09" };
  const subcommand = args[1];
  if (subcommand.startsWith("-")) return { ok: false, error: "\u4E0D\u5141\u8BB8 git \u5168\u5C40\u9009\u9879\uFF08\u5982 -c\u3001-C\u3001--exec-path\uFF09\uFF1B\u8BF7\u901A\u8FC7 workdir \u6307\u5B9A\u4ED3\u5E93" };
  if (!allowedSubcommands.has(subcommand)) {
    return { ok: false, error: "\u4E0D\u652F\u6301 git \u5B50\u547D\u4EE4\u300C" + subcommand + "\u300D\uFF1B\u8BE5\u9650\u5236\u7528\u4E8E\u963B\u6B62 alias\u3001\u5916\u90E8 git-* \u7A0B\u5E8F\u548C\u53EF\u6267\u884C\u811A\u672C\u5165\u53E3" };
  }
  const forbiddenOptions = ["--ext-diff", "--textconv", "--open-files-in-pager", "--upload-pack", "--receive-pack"];
  for (const argument of args.slice(2)) {
    if (forbiddenOptions.some((option) => argument === option || argument.startsWith(option + "="))) {
      return { ok: false, error: "\u4E0D\u5141\u8BB8\u53EF\u80FD\u542F\u52A8\u5916\u90E8\u7A0B\u5E8F\u7684\u9009\u9879\u300C" + argument + "\u300D" };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(argument)) {
      return { ok: false, error: "\u8FDC\u7A0B URL \u4E0D\u5F97\u5185\u5D4C\u7528\u6237\u540D\u3001\u4EE4\u724C\u6216\u5BC6\u7801\uFF0C\u8BF7\u4F7F\u7528\u51ED\u636E\u7BA1\u7406\u5668" };
    }
    if (/^ext::/i.test(argument)) return { ok: false, error: "\u4E0D\u5141\u8BB8 ext:: \u8FDC\u7A0B\u52A9\u624B\u6267\u884C\u5916\u90E8\u547D\u4EE4" };
    if (/AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}/.test(argument)) {
      return { ok: false, error: "\u547D\u4EE4\u7591\u4F3C\u5305\u542B\u8BBF\u95EE\u5BC6\u94A5\u6216\u4EE4\u724C\uFF0C\u5DF2\u62D2\u7EDD\u767B\u8BB0" };
    }
  }
  const tail = args.slice(2);
  if (["merge", "pull", "rebase", "cherry-pick", "revert"].includes(subcommand) && tail.some((argument) => /^-s(?:.+)?$/.test(argument) || argument.startsWith("--strategy=") || argument === "--strategy")) {
    return { ok: false, error: "\u4E0D\u5141\u8BB8\u9009\u62E9\u81EA\u5B9A\u4E49 merge strategy\uFF0C\u4EE5\u514D\u542F\u52A8\u5916\u90E8 git-merge-* \u7A0B\u5E8F" };
  }
  if (subcommand === "push" && tail.some((argument) => argument === "--exec" || argument.startsWith("--exec="))) {
    return { ok: false, error: "\u4E0D\u5141\u8BB8 git push --exec \u6307\u5B9A\u8FDC\u7AEF\u63A5\u6536\u7A0B\u5E8F" };
  }
  if (subcommand === "grep" && tail.some((argument) => argument === "-O" || argument.startsWith("-O"))) {
    return { ok: false, error: "\u4E0D\u5141\u8BB8 git grep -O \u542F\u52A8 pager \u7A0B\u5E8F" };
  }
  if (subcommand === "cat-file" && tail.some((argument) => argument === "--filters" || argument.startsWith("--filters="))) {
    return { ok: false, error: "\u4E0D\u5141\u8BB8 git cat-file --filters \u542F\u52A8\u5185\u5BB9\u8FC7\u6EE4\u7A0B\u5E8F" };
  }
  if (subcommand === "rebase" && tail.some((argument) => argument === "-x" || argument.startsWith("-x") || argument === "--exec" || argument.startsWith("--exec="))) {
    return { ok: false, error: "\u4E0D\u5141\u8BB8 git rebase --exec/-x \u6267\u884C\u4EFB\u610F shell \u547D\u4EE4" };
  }
  return { ok: true, args, subcommand, normalized: args.map(quoteShellArg).join(" ") };
}
function validateCommand(command) {
  const parsed = parseCommand(command);
  return parsed.ok ? { ...parsed, segments: [String(command).trim()] } : parsed;
}
function displayCommand(args) {
  return args.map((argument) => /^[A-Za-z0-9_@%+=:,./~-]+$/.test(argument) && !argument.startsWith("~") ? argument : quoteShellArg(argument)).join(" ");
}
function modernizeCommand(command) {
  const original = typeof command === "string" ? command.trim() : String(command ?? "");
  const parsed = parseCommand(command);
  if (!parsed.ok || parsed.subcommand !== "checkout") return { command: original, changed: false };
  const tail = parsed.args.slice(2);
  if ((tail[0] === "-b" || tail[0] === "-B") && (tail.length === 2 || tail.length === 3)) {
    return {
      command: displayCommand(["git", "switch", tail[0] === "-b" ? "-c" : "-C", ...tail.slice(1)]),
      changed: true
    };
  }
  if (tail[0] === "--" && tail.length > 1) {
    return { command: displayCommand(["git", "restore", ...tail]), changed: true };
  }
  if (tail.length > 2 && tail[1] === "--" && !tail[0].startsWith("-")) {
    return {
      command: displayCommand(["git", "restore", "--source=" + tail[0], ...tail.slice(1)]),
      changed: true
    };
  }
  return { command: original, changed: false };
}
function classifyRisk(command) {
  const parsed = parseCommand(command);
  if (!parsed.ok) return { level: "hard", reasons: ["\u547D\u4EE4\u65E0\u6CD5\u901A\u8FC7\u5B89\u5168\u89E3\u6790\uFF1A" + parsed.error] };
  const { args, subcommand } = parsed;
  const tail = args.slice(2);
  const reasons = [];
  const hasLong = (name) => tail.some((argument) => argument === name || argument.startsWith(name + "="));
  const hasShort = (letter) => tail.some((argument) => /^-[^-]/.test(argument) && argument.slice(1).includes(letter));
  if (subcommand === "reset") reasons.push(hasLong("--hard") ? "git reset --hard \u4F1A\u4E22\u5F03\u5DE5\u4F5C\u533A\u672A\u63D0\u4EA4\u7684\u6539\u52A8" : "git reset \u53EF\u80FD\u79FB\u52A8\u5206\u652F\u5386\u53F2\u6216\u91CD\u7F6E\u7D22\u5F15");
  if (subcommand === "clean" && !hasShort("n") && !hasLong("--dry-run")) reasons.push("git clean \u4F1A\u6C38\u4E45\u5220\u9664\u672A\u8DDF\u8E2A\u7684\u6587\u4EF6");
  if (subcommand === "push") {
    if (hasShort("f") || hasLong("--force") || hasLong("--force-with-lease") || hasLong("--force-if-includes") || tail.some((argument) => argument.startsWith("+"))) reasons.push("\u5F3A\u5236\u63A8\u9001\u4F1A\u8986\u76D6\u8FDC\u7A0B\u5206\u652F\u5386\u53F2");
    if (hasShort("d") || hasLong("--delete") || hasLong("--mirror") || hasLong("--prune") || tail.some((argument) => argument.startsWith(":"))) reasons.push("\u8BE5 push \u53EF\u80FD\u5220\u9664\u8FDC\u7A0B\u5F15\u7528");
  }
  if (subcommand === "rebase") reasons.push("rebase \u4F1A\u91CD\u5199\u63D0\u4EA4\u5386\u53F2");
  if (subcommand === "pull" && hasLong("--rebase")) reasons.push("pull --rebase \u4F1A\u91CD\u5199\u672C\u5730\u63D0\u4EA4\u5386\u53F2");
  if (subcommand === "branch" && (hasShort("d") || hasShort("D") || hasShort("f") || hasShort("M") || hasLong("--delete") || hasLong("--force"))) reasons.push("\u79FB\u52A8\u3001\u8986\u76D6\u6216\u5220\u9664\u672C\u5730\u5206\u652F\u53EF\u80FD\u4E22\u5931\u63D0\u4EA4\u5F15\u7528");
  if (subcommand === "checkout") reasons.push("checkout \u53EF\u80FD\u5207\u6362\u5206\u652F\u3001\u79FB\u52A8\u5206\u652F\u5F15\u7528\u6216\u8986\u76D6\u5DE5\u4F5C\u533A\u6587\u4EF6\uFF1B\u5EFA\u8BAE\u4F18\u5148\u4F7F\u7528 switch/restore");
  if (subcommand === "switch" && (hasShort("f") || hasShort("C") || hasLong("--force") || hasLong("--force-create") || hasLong("--discard-changes"))) reasons.push("switch \u4F1A\u4E22\u5F03\u5DE5\u4F5C\u533A\u6539\u52A8\u6216\u5F3A\u5236\u79FB\u52A8\u5206\u652F");
  if (subcommand === "restore" && (!hasLong("--staged") || hasLong("--worktree"))) reasons.push("git restore \u4F1A\u4E22\u5F03\u5DE5\u4F5C\u533A\u6539\u52A8");
  if (subcommand === "rm") reasons.push("git rm \u4F1A\u5220\u9664\u5DE5\u4F5C\u533A\u6587\u4EF6\u5E76\u6682\u5B58\u5220\u9664\u64CD\u4F5C");
  if (subcommand === "stash" && (tail[0] === "drop" || tail[0] === "clear")) reasons.push("\u4F1A\u5220\u9664 stash \u8BB0\u5F55");
  if (subcommand === "commit" && hasLong("--amend")) reasons.push("commit --amend \u4F1A\u91CD\u5199\u6700\u8FD1\u4E00\u6B21\u63D0\u4EA4");
  if (subcommand === "reflog" && (tail[0] === "delete" || tail[0] === "expire")) reasons.push("\u4F1A\u5220\u9664\u6216\u8FC7\u671F reflog \u6062\u590D\u8BB0\u5F55");
  if (subcommand === "tag" && (hasShort("d") || hasLong("--delete"))) reasons.push("\u5220\u9664 tag \u4F1A\u79FB\u9664\u63D0\u4EA4\u6807\u7B7E");
  if (subcommand === "tag" && (hasShort("f") || hasLong("--force"))) reasons.push("\u5F3A\u5236\u66F4\u65B0 tag \u4F1A\u79FB\u52A8\u5DF2\u6709\u6807\u7B7E");
  return reasons.length > 0 ? { level: "hard", reasons } : safeSubcommands.has(subcommand) ? { level: "safe", reasons: [] } : { level: "normal", reasons: [] };
}
function classifyStepsRisk(commands) {
  let level = "safe";
  const reasons = [];
  for (const command of commands) {
    const risk = classifyRisk(command);
    if (risk.level === "hard") level = "hard";
    else if (risk.level === "normal" && level === "safe") level = "normal";
    for (const reason of risk.reasons) if (!reasons.includes(reason)) reasons.push(reason);
  }
  return { level, reasons };
}
function redactSecrets(value) {
  return String(value || "").replace(/(\b[a-z][a-z0-9+.-]{0,19}:\/\/)[^/@\s]+@/gi, "$1***@").replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]").replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]").replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]").replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_GITLAB_TOKEN]").replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED_NPM_TOKEN]").replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]").replace(/([?&](?:access_token|auth|password|token)=)[^&#\s]+/gi, "$1[REDACTED]");
}
function redactAndLimit(value, maxChars = 2e4) {
  const redacted = redactSecrets(value);
  return redacted.length <= maxChars ? redacted : redacted.slice(0, maxChars) + "\n\u2026[\u8F93\u51FA\u5DF2\u622A\u65AD]";
}
function addPathsOf(command) {
  const parsed = parseCommand(command);
  if (!parsed.ok || parsed.subcommand !== "add") return null;
  const tail = parsed.args.slice(2);
  if (tail.some((argument) => ["-A", "--all", "-u", "--update", "--refresh", "--renormalize", "--pathspec-from-file"].some((option) => argument === option || argument.startsWith(option + "=")))) return "";
  const separator = tail.indexOf("--");
  const paths = separator >= 0 ? tail.slice(separator + 1) : tail.filter((argument) => !argument.startsWith("-"));
  return paths.join(" ");
}
function deriveChecks(commands) {
  const parsedCommands = commands.map(parseCommand).filter((parsed) => parsed.ok);
  const hasCommit = parsedCommands.some((parsed) => parsed.subcommand === "commit");
  const checks = [];
  let lastBranch = null;
  let lastCommitMessage = null;
  const branchesGone = [];
  let lastStaged = [];
  let lastClean = [];
  let stashOperation = null;
  let hasPush = false;
  for (const parsed of parsedCommands) {
    const tail = parsed.args.slice(2);
    if (parsed.subcommand === "switch" || parsed.subcommand === "checkout") {
      const createOptions = parsed.subcommand === "switch" ? ["-c", "-C", "--create", "--force-create"] : ["-b", "-B"];
      for (let index = 0; index < tail.length - 1; index += 1) if (createOptions.includes(tail[index])) lastBranch = tail[index + 1];
    }
    if (parsed.subcommand === "commit") {
      for (let index = 0; index < tail.length; index += 1) {
        const argument = tail[index];
        if ((argument === "-m" || argument === "--message") && index + 1 < tail.length) {
          lastCommitMessage = tail[index + 1];
          break;
        }
        if (argument.startsWith("--message=")) {
          lastCommitMessage = argument.slice("--message=".length);
          break;
        }
      }
    }
    if (parsed.subcommand === "branch") {
      const deleteAt = tail.findIndex((argument) => argument === "-d" || argument === "-D" || argument === "--delete");
      if (deleteAt >= 0) branchesGone.push(...tail.slice(deleteAt + 1).filter((argument) => !argument.startsWith("-")));
    }
    if (!hasCommit && parsed.subcommand === "add") {
      const paths = addPathsOf(parsed.args.map(quoteShellArg).join(" "));
      const separator = tail.indexOf("--");
      if (paths) lastStaged = separator >= 0 ? tail.slice(separator + 1) : tail.filter((argument) => !argument.startsWith("-"));
    }
    if (parsed.subcommand === "checkout" || parsed.subcommand === "restore") {
      const separator = tail.indexOf("--");
      if (separator >= 0) lastClean = tail.slice(separator + 1);
      else if (parsed.subcommand === "restore" && !tail.some((argument) => argument === "--staged" || argument.startsWith("--staged="))) lastClean = tail.filter((argument) => !argument.startsWith("-"));
    }
    if (parsed.subcommand === "stash" && (tail[0] === "push" || tail.length === 0)) stashOperation = "nonempty";
    if (parsed.subcommand === "stash" && (tail[0] === "drop" || tail[0] === "clear")) stashOperation = "empty";
    if (parsed.subcommand === "push") hasPush = true;
  }
  if (lastBranch) checks.push({ type: "branch", value: lastBranch, label: "\u5F53\u524D\u5206\u652F\u5E94\u4E3A " + lastBranch });
  if (lastCommitMessage !== null) checks.push({ type: "commit-msg", value: lastCommitMessage, label: "\u6700\u8FD1\u63D0\u4EA4\u4FE1\u606F\u5E94\u4E3A\u300C" + lastCommitMessage + "\u300D" });
  for (const branch of branchesGone) checks.push({ type: "branch-gone", value: branch, label: "\u5206\u652F " + branch + " \u5E94\u5DF2\u5220\u9664" });
  if (lastStaged.length) checks.push({ type: "staged", value: lastStaged, label: "\u6307\u5B9A\u6587\u4EF6\u5E94\u5DF2\u6682\u5B58" });
  if (lastClean.length) checks.push({ type: "clean", value: lastClean, label: "\u6307\u5B9A\u6587\u4EF6\u7684\u5DE5\u4F5C\u533A\u6539\u52A8\u5E94\u5DF2\u4E22\u5F03" });
  if (stashOperation === "nonempty") checks.push({ type: "stash-nonempty", value: true, label: "stash \u5E94\u975E\u7A7A" });
  if (stashOperation === "empty") checks.push({ type: "stash-empty", value: true, label: "stash \u5E94\u4E3A\u7A7A" });
  if (hasPush) checks.push({ type: "no-ahead", value: true, label: "\u5E94\u5DF2\u63A8\u9001\uFF08\u4E0D\u518D\u9886\u5148\u8FDC\u7A0B\uFF09" });
  return checks;
}
var MAX_COMMAND_LENGTH, allowedSubcommands, safeSubcommands;
var init_command_policy = __esm({
  "src/host/command-policy.ts"() {
    "use strict";
    MAX_COMMAND_LENGTH = 800;
    allowedSubcommands = /* @__PURE__ */ new Set([
      "add",
      "blame",
      "branch",
      "cat-file",
      "check-attr",
      "check-ignore",
      "checkout",
      "cherry",
      "cherry-pick",
      "clean",
      "commit",
      "count-objects",
      "describe",
      "diff",
      "fetch",
      "for-each-ref",
      "fsck",
      "grep",
      "hash-object",
      "log",
      "ls-files",
      "ls-tree",
      "merge",
      "merge-base",
      "mv",
      "pull",
      "push",
      "rebase",
      "reflog",
      "remote",
      "reset",
      "restore",
      "revert",
      "rev-parse",
      "rm",
      "shortlog",
      "show",
      "show-ref",
      "stash",
      "status",
      "switch",
      "tag",
      "verify-commit",
      "verify-tag",
      "whatchanged"
    ]);
    safeSubcommands = /* @__PURE__ */ new Set([
      "blame",
      "check-attr",
      "check-ignore",
      "cherry",
      "count-objects",
      "describe",
      "diff",
      "for-each-ref",
      "grep",
      "log",
      "ls-files",
      "ls-tree",
      "merge-base",
      "rev-parse",
      "shortlog",
      "show",
      "show-ref",
      "status",
      "verify-commit",
      "verify-tag",
      "whatchanged"
    ]);
  }
});

// src/host/actions.ts
function isRepositoryAction(action) {
  return REPOSITORY_ACTIONS.includes(action);
}
function repositoryMutationCommand(action, body) {
  const paths = Array.isArray(body.paths) && body.paths.every((path) => typeof path === "string") ? body.paths.map(quoteShellArg).join(" ") : "";
  if (action === "stage-paths" && paths) return "git add -- " + paths;
  if (action === "unstage-paths" && paths) return "git reset HEAD -- " + paths;
  if (action === "stage-all") return "git add -A";
  if (action === "unstage-all") return "git reset HEAD -- :/";
  if (action === "commit" && typeof body.message === "string") return "git commit -m " + quoteShellArg(body.message.trim());
  if (action === "create-branch" && typeof body.name === "string" && typeof body.base === "string") {
    return "git switch -c " + quoteShellArg(body.name) + " " + quoteShellArg(body.base);
  }
  if (action === "switch-branch" && typeof body.name === "string") return "git switch " + quoteShellArg(body.name);
  if (action === "delete-branch" && typeof body.name === "string") {
    return "git branch " + (body.force === true ? "-D" : "-d") + " -- " + quoteShellArg(body.name);
  }
  if (action === "fetch" && typeof body.remote === "string") return "git fetch " + quoteShellArg(body.remote);
  if (action === "pull") return "git pull --ff-only";
  if (action === "push") {
    if (body.setUpstream === true && typeof body.remote === "string" && typeof body.branch === "string") {
      return "git push -u " + quoteShellArg(body.remote) + " " + quoteShellArg(body.branch);
    }
    return "git push";
  }
  if (action === "rebase" && typeof body.target === "string") return "git rebase " + quoteShellArg(body.target);
  if (action === "rebase-continue") return "git -c core.editor=true rebase --continue";
  if (action === "rebase-abort") return "git rebase --abort";
  return null;
}
async function attachRepositoryRecovery(action, sessionId, body, result, context, dependencies) {
  const failure = asRecord(result);
  const syncAction = action === "fetch" || action === "pull" || action === "push" || action === "rebase" || action === "rebase-continue" || action === "rebase-abort";
  const recoverable = failure.code === "GIT_FAILED" || failure.code === "TIMEOUT" || failure.reason === "BRANCH_EXISTS" || syncAction && failure.code === "STATE_CONFLICT";
  if (failure.ok !== false || !recoverable) return result;
  const command = repositoryMutationCommand(action, body);
  const operationId = typeof body.operationId === "string" ? body.operationId : "";
  if (!command || !context || !operationId) return result;
  try {
    const handled = await dependencies.recoverFailedCommand(
      sessionId,
      context.workdir,
      operationId,
      action,
      command,
      typeof failure.message === "string" ? failure.message : "Git \u64CD\u4F5C\u5931\u8D25",
      typeof failure.diagnostics === "string" ? failure.diagnostics : "",
      typeof failure.code === "string" ? failure.code : "GIT_FAILED",
      typeof failure.reason === "string" ? failure.reason : ""
    );
    return handled ? { ...failure, ...handled } : result;
  } catch (error) {
    console.log("easygit \u4FEE\u6B63\u63D0\u8BAE\u751F\u6210\u5931\u8D25", errorMessage(error));
    return result;
  }
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > 1024 * 1024) {
        chunks.length = 0;
        finish(null);
        return;
      }
      if (!settled) chunks.push(part);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(""));
  });
}
function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data));
}
async function dispatchRepositoryAction(action, sessionId, body, context, dependencies) {
  if (!context) return { ok: false, code: "SESSION_NOT_FOUND", message: "\u65E0\u6CD5\u786E\u5B9A\u5F53\u524D\u4F1A\u8BDD\u7684\u4ED3\u5E93\u76EE\u5F55" };
  const repository = dependencies.repository;
  const base = { sessionId, workdir: context.workdir, operationId: body.operationId, sandboxPolicy: context.policy };
  if (action === "get-conflicts" || action === "get-conflict") return repository.conflictAction(action, context.workdir, body, void 0, context.policy);
  if (action === "save-conflict" || action === "resolve-conflict" || action === "start-operation" || action === "finish-operation") {
    return repository.conflictAction(action, context.workdir, body, base);
  }
  if (action === "get-summary") return repository.getSummary(context.workdir, void 0, context.policy);
  if (action === "get-diff") return repository.getDiff(context.workdir, body.path, body.staged === true, void 0, context.policy);
  if (action === "get-branches") return repository.getBranches(context.workdir, void 0, context.policy);
  if (action === "get-commits") return repository.getCommits(context.workdir, body.limit, void 0, context.policy);
  if (action === "get-commit-detail") return repository.getCommitDetail(context.workdir, body.hash, void 0, context.policy);
  if (action === "get-commit-diff") return repository.getCommitDiff(context.workdir, body.hash, void 0, context.policy);
  if (action === "get-stashes") return repository.getStashes(context.workdir, void 0, context.policy);
  if (action === "get-sync-state") return repository.getSyncState(context.workdir, void 0, context.policy);
  if (action === "stage-paths") return repository.stagePaths(base, body.paths);
  if (action === "unstage-paths") return repository.unstagePaths(base, body.paths);
  if (action === "stage-all") return repository.stageAll(base);
  if (action === "unstage-all") return repository.unstageAll(base);
  if (action === "commit") return repository.commit(base, body.message);
  if (action === "create-branch") return repository.createBranch(base, body.name, body.base);
  if (action === "switch-branch") return repository.switchBranch(base, body.name);
  if (action === "delete-branch") return repository.deleteBranch(base, body.name, body.force === true, body.confirmRisk === true);
  if (action === "fetch") return repository.fetchRemote(base, body.remote);
  if (action === "pull") return repository.pullFfOnly(base);
  if (action === "push") return repository.pushCurrent(base, body.remote, body.branch, body.setUpstream === true);
  if (action === "rebase") return repository.rebaseOnto(base, body.target, body.confirmRisk === true);
  if (action === "rebase-continue") return repository.continueRebase(base, body.confirmRisk === true);
  return repository.abortRebase(base, body.confirmRisk === true);
}
async function dispatchProposalAction(action, sessionId, body, dependencies) {
  if (action === "request-analysis") {
    const proposal = dependencies.findProposal(sessionId, body.proposalId);
    if (!proposal || proposal.closed || proposal.status !== "failed" || proposal.needsAgentAnalysis !== true || !proposal.failure) {
      return { status: 200, data: { ok: false, error: "\u8BE5\u5931\u8D25\u8BB0\u5F55\u5DF2\u4E0D\u518D\u7B49\u5F85 Agent \u5206\u6790" } };
    }
    proposal.analysisRequestedAt = Date.now();
    await dependencies.flushProposal(sessionId);
    return { status: 200, data: { ok: true } };
  }
  if (action === "state") {
    const proposal = dependencies.latestPending(sessionId);
    if (proposal && proposal.status === "pending" && proposal.copied === true && proposal.fingerprint) {
      const verification = await dependencies.verifyProposal(dependencies.shell, proposal);
      if (verification.verified) {
        proposal.verified = true;
        proposal.status = "verified";
        await dependencies.flushProposal(sessionId);
      }
      return { status: 200, data: { ok: true, proposal: dependencies.proposalView(proposal), ...verification } };
    }
    return { status: 200, data: { ok: true, proposal: proposal ? dependencies.proposalView(proposal) : null, changed: false, verified: false, partial: false, message: "", changedState: "" } };
  }
  if (action === "dismiss") {
    const proposal = dependencies.findProposal(sessionId, body.proposalId);
    if (!proposal) return { status: 200, data: { ok: false, error: "\u627E\u4E0D\u5230\u8BE5\u63D0\u8BAE" } };
    if (proposal.status === "running") return { status: 200, data: { ok: false, error: "\u8BE5\u63D0\u8BAE\u6B63\u5728\u6267\u884C\uFF0C\u4E0D\u80FD\u653E\u5F03" } };
    proposal.closed = true;
    proposal.status = "dismissed";
    proposal.manual = body.manual === true;
    await dependencies.flushProposal(sessionId);
    return { status: 200, data: { ok: true } };
  }
  if (action === "mark-copied") {
    const proposal = dependencies.findProposal(sessionId, body.proposalId);
    if (!proposal) return { status: 200, data: { ok: false, error: "\u627E\u4E0D\u5230\u8BE5\u63D0\u8BAE" } };
    if (proposal.status !== "pending") return { status: 200, data: { ok: false, error: "\u8BE5\u63D0\u8BAE\u5DF2\u4E0D\u518D\u7B49\u5F85\u6267\u884C" } };
    if (proposal.risk === "hard" && body.confirm !== true) return { status: 200, data: { ok: false, error: "\u9AD8\u98CE\u9669\u64CD\u4F5C\uFF1A\u8BF7\u5148\u52FE\u9009\u201C\u6211\u5DF2\u4E86\u89E3\u98CE\u9669\u201D\u518D\u590D\u5236" } };
    proposal.fingerprint = await dependencies.captureFingerprint(dependencies.shell, proposal.workdir);
    proposal.baselineFailed = await dependencies.runChecks(dependencies.shell, proposal.workdir, deriveChecks(proposal.steps.map((step) => step.command)));
    proposal.copied = true;
    await dependencies.flushProposal(sessionId);
    return { status: 200, data: { ok: true } };
  }
  if (action === "verify") {
    const proposal = dependencies.findProposal(sessionId, body.proposalId);
    if (!proposal) return { status: 200, data: { ok: false, error: "\u627E\u4E0D\u5230\u8BE5\u63D0\u8BAE" } };
    if (proposal.status !== "pending") return { status: 200, data: { ok: false, changed: false, verified: false, partial: false, message: "\u8BE5\u63D0\u8BAE\u5DF2\u4E0D\u518D\u7B49\u5F85\u624B\u52A8\u9A8C\u8BC1", changedState: "" } };
    if (proposal.copied !== true || !proposal.fingerprint) {
      return { status: 200, data: { ok: true, changed: false, verified: false, partial: false, message: "\u5C1A\u672A\u590D\u5236\u547D\u4EE4\u6216\u7F3A\u5C11\u5BF9\u6BD4\u57FA\u7EBF", changedState: "" } };
    }
    const verification = await dependencies.verifyProposal(dependencies.shell, proposal);
    if (verification.verified) {
      proposal.verified = true;
      proposal.status = "verified";
    }
    await dependencies.flushProposal(sessionId);
    return { status: 200, data: { ok: true, ...verification } };
  }
  if (action === "execute") {
    const proposal = dependencies.findProposal(sessionId, body.proposalId);
    if (!proposal) {
      return { status: 200, data: { ok: false, proposalId: body.proposalId || "", command: "", steps: [], exitCode: -1, signal: "", timedOut: false, stdout: "", stderr: "", diagnostics: "", error: "\u627E\u4E0D\u5230\u8BE5\u63D0\u8BAE\uFF08proposalId \u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF09" } };
    }
    if (proposal.risk === "hard" && body.confirm !== true) {
      return { status: 200, data: { ok: false, proposalId: proposal.proposalId, command: proposal.command, steps: [], exitCode: -1, signal: "", timedOut: false, stdout: "", stderr: "", diagnostics: "", error: "\u9AD8\u98CE\u9669\u64CD\u4F5C\uFF1A\u8BF7\u5148\u52FE\u9009\u201C\u6211\u5DF2\u4E86\u89E3\u98CE\u9669\u201D\u518D\u6267\u884C" } };
    }
    const result = await dependencies.executeProposal(
      dependencies.shell,
      proposal,
      await dependencies.resolveExecutionPolicy(sessionId),
      () => dependencies.flushProposal(sessionId)
    );
    console.log("easygit HTTP execute", proposal.proposalId, "ok=", result.ok);
    return { status: 200, data: result };
  }
  return { status: 400, data: { ok: false, error: "unknown action: " + action } };
}
function registerEasyGitActions(webServer, dependencies, connection) {
  if (!webServer) return void 0;
  return webServer.register({
    kind: "prefix",
    path: "/easygit",
    handler: async (req, res) => {
      if (!connection) {
        sendJson(res, 503, { ok: false, error: "connection service unavailable" });
        return;
      }
      const rejection = connection.requestRejection(req);
      if (rejection !== void 0) {
        sendJson(res, rejection, { ok: false, error: rejection === 401 ? "unauthorized" : "forbidden" });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      if (req.headers?.["sec-fetch-site"] === "cross-site") {
        sendJson(res, 403, { ok: false, error: "cross-site request denied" });
        return;
      }
      const contentType = req.headers?.["content-type"];
      if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
        sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
        return;
      }
      let body;
      try {
        const raw = await readBody(req);
        if (raw === null) {
          sendJson(res, 413, { ok: false, error: "request body too large" });
          return;
        }
        body = raw ? asRecord(JSON.parse(raw)) : {};
      } catch (error) {
        sendJson(res, 400, { ok: false, error: "invalid json body" });
        return;
      }
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      if (!sessionId || sessionId.length > 200) {
        sendJson(res, 400, { ok: false, error: "valid sessionId is required" });
        return;
      }
      const action = typeof body.action === "string" ? body.action : "";
      try {
        await dependencies.proposalStorageReady;
        if (isRepositoryAction(action)) {
          const context = await dependencies.repositoryContext(sessionId);
          const result = await dispatchRepositoryAction(action, sessionId, body, context, dependencies);
          sendJson(res, 200, await attachRepositoryRecovery(action, sessionId, body, result, context, dependencies));
          return;
        }
        const response = await dispatchProposalAction(action, sessionId, body, dependencies);
        sendJson(res, response.status, response.data);
      } catch (error) {
        const diagnostics = redactAndLimit(errorMessage(error), 2e3);
        sendJson(res, 500, isRepositoryAction(action) ? { ok: false, code: "INTERNAL_ERROR", message: "Git \u64CD\u4F5C\u5931\u8D25", diagnostics } : { ok: false, error: diagnostics });
      }
    }
  });
}
var REPOSITORY_ACTIONS;
var init_actions = __esm({
  "src/host/actions.ts"() {
    "use strict";
    init_command_policy();
    REPOSITORY_ACTIONS = [
      "get-conflicts",
      "get-conflict",
      "save-conflict",
      "resolve-conflict",
      "start-operation",
      "finish-operation",
      "get-summary",
      "get-diff",
      "get-branches",
      "get-commits",
      "get-commit-detail",
      "get-commit-diff",
      "get-stashes",
      "get-sync-state",
      "stage-paths",
      "unstage-paths",
      "stage-all",
      "unstage-all",
      "commit",
      "create-branch",
      "switch-branch",
      "delete-branch",
      "fetch",
      "pull",
      "push",
      "rebase",
      "rebase-continue",
      "rebase-abort"
    ];
  }
});

// src/host/proposal-service.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isGitFailureContext(value) {
  if (!isRecord(value)) return false;
  return (value.source === "workbench" || value.source === "proposal") && typeof value.code === "string" && typeof value.action === "string" && typeof value.command === "string" && typeof value.message === "string" && typeof value.stdout === "string" && typeof value.stderr === "string" && typeof value.diagnostics === "string" && (value.exitCode === null || typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)) && typeof value.timedOut === "boolean" && typeof value.mayHavePartialChanges === "boolean" && typeof value.occurredAt === "number" && Number.isSafeInteger(value.occurredAt);
}
function isStoredProposal(value, sessionId) {
  if (!isRecord(value) || value.sessionId !== sessionId) return false;
  if (typeof value.proposalId !== "string" || !/^g-[0-9a-f-]{36}$/i.test(value.proposalId)) return false;
  if (typeof value.intent !== "string" || typeof value.command !== "string" || typeof value.explanation !== "string") return false;
  if (typeof value.workdir !== "string" || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt)) return false;
  if (!["safe", "normal", "hard"].includes(String(value.risk))) return false;
  if (!["pending", "running", "succeeded", "failed", "verified", "dismissed"].includes(String(value.status))) return false;
  if (!Array.isArray(value.reasons) || !value.reasons.every((reason) => typeof reason === "string")) return false;
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 10) return false;
  if (!value.steps.every((step) => isRecord(step) && typeof step.command === "string" && (step.result === null || isRecord(step.result)))) return false;
  return typeof value.confirmed === "boolean" && typeof value.closed === "boolean" && typeof value.copied === "boolean" && typeof value.verified === "boolean" && (value.fingerprint === null || typeof value.fingerprint === "string") && (value.result === null || isRecord(value.result)) && (value.failure === void 0 || isGitFailureContext(value.failure)) && (value.recoverySuggestion === void 0 || typeof value.recoverySuggestion === "string") && (value.needsAgentAnalysis === void 0 || typeof value.needsAgentAnalysis === "boolean") && (value.analysisRequestedAt === void 0 || typeof value.analysisRequestedAt === "number" && Number.isSafeInteger(value.analysisRequestedAt));
}
var import_node_crypto, DEFAULT_PROPOSALS_PER_SESSION, DEFAULT_MAX_SESSIONS, DEFAULT_SESSION_TTL_MS, ProposalService, proposalService;
var init_proposal_service = __esm({
  "src/host/proposal-service.ts"() {
    "use strict";
    import_node_crypto = require("node:crypto");
    DEFAULT_PROPOSALS_PER_SESSION = 3;
    DEFAULT_MAX_SESSIONS = 100;
    DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1e3;
    ProposalService = class {
      constructor(proposalsPerSession = DEFAULT_PROPOSALS_PER_SESSION, maxSessions = DEFAULT_MAX_SESSIONS, sessionTtlMs = DEFAULT_SESSION_TTL_MS) {
        this.proposalsPerSession = proposalsPerSession;
        this.maxSessions = maxSessions;
        this.sessionTtlMs = sessionTtlMs;
      }
      proposalsBySession = /* @__PURE__ */ new Map();
      storage = null;
      storageTail = Promise.resolve();
      async attachStorage(storage) {
        const snapshot = await storage.loadAll();
        const records = snapshot.tables.proposals ?? {};
        const loaded = /* @__PURE__ */ new Map();
        for (const [sessionId, value] of Object.entries(records)) {
          const entries = this.readStoredEntries(sessionId, value);
          if (entries.length > 0) loaded.set(sessionId, entries);
        }
        this.pruneMap(loaded);
        for (const [sessionId, entries] of this.proposalsBySession) {
          if (!loaded.has(sessionId)) loaded.set(sessionId, entries);
        }
        this.proposalsBySession.clear();
        for (const [sessionId, entries] of loaded) this.proposalsBySession.set(sessionId, entries);
        this.storage = storage;
      }
      async closeStorage(storage) {
        await this.storageTail;
        if (this.storage === storage) this.storage = null;
        await storage.close();
      }
      flush(sessionId) {
        const storage = this.storage;
        if (!storage) return Promise.resolve();
        const entries = this.proposalsBySession.get(sessionId);
        const operation = entries && entries.length > 0 ? () => storage.putRecord("proposals", sessionId, { entries }) : () => storage.deleteRecord("proposals", sessionId);
        const result = this.storageTail.then(operation);
        this.storageTail = result.catch(() => {
        });
        return result;
      }
      newId() {
        return "g-" + (0, import_node_crypto.randomUUID)();
      }
      list(sessionId) {
        this.prune();
        return this.proposalsBySession.get(sessionId);
      }
      hasRunning(sessionId) {
        return this.list(sessionId)?.some((proposal) => proposal.status === "running") ?? false;
      }
      closeOpen(sessionId) {
        for (const proposal of this.list(sessionId) ?? []) if (!proposal.closed) proposal.closed = true;
      }
      store(sessionId, proposal) {
        this.prune();
        let list = this.proposalsBySession.get(sessionId);
        if (!list) {
          list = [];
          this.proposalsBySession.set(sessionId, list);
        } else {
          this.proposalsBySession.delete(sessionId);
          this.proposalsBySession.set(sessionId, list);
        }
        list.unshift(proposal);
        if (list.length > this.proposalsPerSession) list.length = this.proposalsPerSession;
        while (this.proposalsBySession.size > this.maxSessions) {
          const oldest = [...this.proposalsBySession].find(([, entries]) => entries.every((entry) => entry.status !== "running"))?.[0];
          if (!oldest) break;
          this.proposalsBySession.delete(oldest);
        }
        return proposal;
      }
      prune(now = Date.now()) {
        this.pruneMap(this.proposalsBySession, now);
      }
      pruneMap(proposals, now = Date.now()) {
        for (const [sessionId, entries] of proposals) {
          const newest = entries[0];
          if (!newest || now - newest.createdAt > this.sessionTtlMs && entries.every((entry) => entry.status !== "running")) proposals.delete(sessionId);
        }
      }
      readStoredEntries(sessionId, value) {
        if (!isRecord(value) || !Array.isArray(value.entries)) return [];
        const entries = [];
        for (const item of value.entries.slice(0, this.proposalsPerSession)) {
          if (!isStoredProposal(item, sessionId)) continue;
          if (item.status === "running") {
            entries.push({
              ...item,
              status: "failed",
              closed: true,
              result: { ok: false, error: "DSH \u5728\u547D\u4EE4\u6267\u884C\u671F\u95F4\u505C\u6B62\uFF0C\u65E0\u6CD5\u786E\u8BA4\u547D\u4EE4\u662F\u5426\u5B8C\u6574\u6267\u884C" }
            });
          } else {
            entries.push(item);
          }
        }
        return entries;
      }
      find(sessionId, proposalId) {
        if (typeof proposalId !== "string" || !proposalId) return void 0;
        return this.list(sessionId)?.find((proposal) => proposal.proposalId === proposalId);
      }
      latestPending(sessionId) {
        for (const proposal of this.list(sessionId) ?? []) if (!proposal.closed) return proposal;
        return null;
      }
      view(proposal) {
        return {
          proposalId: proposal.proposalId,
          intent: proposal.intent,
          command: proposal.command,
          steps: proposal.steps.map((step) => ({ command: step.command, result: step.result })),
          explanation: proposal.explanation,
          risk: proposal.risk,
          reasons: proposal.reasons,
          confirmed: proposal.confirmed,
          workdir: proposal.workdir,
          result: proposal.result,
          closed: proposal.closed,
          copied: proposal.copied,
          ...proposal.failure ? { failure: proposal.failure } : {},
          ...typeof proposal.recoverySuggestion === "string" ? { recoverySuggestion: proposal.recoverySuggestion } : {},
          ...proposal.needsAgentAnalysis === true ? { needsAgentAnalysis: true } : {},
          ...typeof proposal.analysisRequestedAt === "number" ? { analysisRequestedAt: proposal.analysisRequestedAt } : {},
          status: proposal.status || (proposal.closed ? "dismissed" : "pending")
        };
      }
    };
    proposalService = new ProposalService();
  }
});

// src/host/conflict-worker.ts
function conflictWorkerCommand(action, payload) {
  const data = { ...payload };
  if (typeof data.content === "string") {
    data.contentBase64 = Buffer.from(data.content).toString("base64");
    delete data.content;
  }
  return quoteShellArg(process.execPath) + " -e " + quoteShellArg(worker) + " " + quoteShellArg(Buffer.from(JSON.stringify({ ...data, action })).toString("base64"));
}
var worker;
var init_conflict_worker = __esm({
  "src/host/conflict-worker.ts"() {
    "use strict";
    init_command_policy();
    worker = String.raw`
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
function operationState() {
  const dir = name => git('rev-parse', '--git-path', name).trim();
  const names = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'sequencer'];
  const paths = names.map(dir);
  const operation = exists(paths[0]) || exists(paths[1]) ? 'rebase' : exists(paths[2]) ? 'merge' : exists(paths[3]) || (exists(path.join(paths[4], 'todo')) && /^pick /m.test(fs.readFileSync(path.join(paths[4], 'todo'), 'utf8'))) ? 'cherry-pick' : null;
  const meta = ['HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge/head-name', 'rebase-merge/onto', 'rebase-merge/msgnum', 'rebase-merge/stopped-sha', 'rebase-apply/next', 'rebase-apply/orig-head', 'sequencer/todo'].map(name => {
    const file = dir(name); return exists(file) ? fs.readFileSync(file).toString('base64') : '';
  });
  let head;
  try { head = git('rev-parse', '--verify', 'HEAD').trim(); }
  catch (error) {
    const branch = git('symbolic-ref', '--quiet', 'HEAD').trim();
    if (exists(dir(branch))) throw error;
    head = 'unborn:' + branch;
  }
  return { operation, operationToken: hash(JSON.stringify([operation, meta, head])) };
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
function main() {
  process.chdir(git('rev-parse', '--show-toplevel').trim());
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
    git(input.kind, '--' + input.mode);
    return state();
  }
  fail('无效操作', 'INVALID_ARGUMENT');
}
try { console.log(JSON.stringify({ ok: true, data: main() })); }
catch (error) {
  let pending = null;
  try { pending = state(); } catch {}
  // A new conflict is an expected stop in a multi-step Git operation.
  if ((input.action === 'start-operation' || (input.action === 'finish-operation' && input.mode !== 'abort')) && error.status && pending && pending.operation === input.kind && pending.files.length) {
    console.log(JSON.stringify({ ok: true, data: pending }));
  } else console.log(JSON.stringify({ ok: false, code: ['STATE_CONFLICT', 'INVALID_ARGUMENT', 'PERMISSION_DENIED'].includes(error.code) ? error.code : 'GIT_FAILED', message: error.status ? 'Git 操作未完成，请查看详情' : error.message, diagnostics: error.stderr ? error.stderr.toString() : undefined }));
}
`;
  }
});

// src/host/git-repository-service.ts
function errorResult(code, message, diagnostics, reason) {
  return {
    ok: false,
    code,
    message,
    ...diagnostics ? { diagnostics } : {},
    ...reason ? { reason } : {}
  };
}
function outputOf(result) {
  return ((result.stdout?.text ?? "") + (result.stderr?.text ?? "")).trim();
}
function mutationErrorCode(result) {
  if (result.timedOut) return "TIMEOUT";
  return "GIT_FAILED";
}
function parseStatus(status) {
  const files = [];
  const records = status.split("\0");
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index];
    if (record.startsWith("## ") || record.length < 4) continue;
    const indexStatus = record[0];
    const workTreeStatus = record[1];
    const path = record.slice(3);
    if (/[RC]/.test(indexStatus + workTreeStatus)) {
      if (index + 1 >= records.length - 1) break;
      files.push({ indexStatus, workTreeStatus, path, originalPath: records[++index] });
    } else files.push({ indexStatus, workTreeStatus, path });
  }
  return files;
}
function validPathspec(path) {
  if (typeof path !== "string" || !path || path.length > 4096 || /[\0\r\n]/.test(path)) return false;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  return !path.split(/[\\/]/).some((part) => part === "..");
}
function validBranchName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && !/[\0\r\n\s~^:?*\[\\]/.test(name) && !name.startsWith("-") && !name.startsWith(".") && !name.endsWith(".") && !name.includes("..") && !name.includes("@{") && !name.endsWith(".lock");
}
function validRemoteName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes("..") && !name.includes("@{") && !name.endsWith(".lock");
}
function conflictCount(files) {
  return files.filter((file) => {
    const status = file.indexStatus + file.workTreeStatus;
    return status.includes("U") || status === "AA" || status === "DD";
  }).length;
}
function validCommitHash(hash) {
  return typeof hash === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash);
}
function parseCommitFiles(nameStatus, numstat) {
  const statusRows = nameStatus.split("\n").filter(Boolean);
  const statRows = numstat.split("\n").filter(Boolean);
  let additions = 0;
  let deletions = 0;
  let binary = 0;
  const files = statusRows.slice(0, COMMIT_FILE_MAX).map((line, index) => {
    const parts = line.split("	");
    const status = parts[0] ?? "";
    const renamed = /^[RC]/.test(status) && parts.length >= 3;
    const path = redactAndLimit(renamed ? parts[2] ?? "" : parts[1] ?? "", 4096);
    const previousPath = renamed ? redactAndLimit(parts[1] ?? "", 4096) : void 0;
    const stat = (statRows[index] ?? "").split("	");
    const added = /^\d+$/.test(stat[0] ?? "") ? Number(stat[0]) : null;
    const deleted = /^\d+$/.test(stat[1] ?? "") ? Number(stat[1]) : null;
    if (added === null || deleted === null) binary += 1;
    else {
      additions += added;
      deletions += deleted;
    }
    return { status: redactAndLimit(status, 32), path, ...previousPath ? { previousPath } : {}, additions: added, deletions: deleted };
  });
  for (const line of statRows.slice(files.length)) {
    const stat = line.split("	");
    const added = /^\d+$/.test(stat[0] ?? "") ? Number(stat[0]) : null;
    const deleted = /^\d+$/.test(stat[1] ?? "") ? Number(stat[1]) : null;
    if (added === null || deleted === null) binary += 1;
    else {
      additions += added;
      deletions += deleted;
    }
  }
  return {
    files,
    filesTruncated: statusRows.length > COMMIT_FILE_MAX,
    totals: { files: statusRows.length, additions, deletions, binary }
  };
}
var MUTATION_OUTPUT_MAX_CHARS, DIFF_MAX_CHARS, COMMIT_DETAIL_MAX_CHARS, COMMIT_DIFF_MAX_CHARS, COMMIT_FILE_MAX, STASH_MAX, MAX_PATHS, OPERATION_TTL_MS, repositoryLocks, GitRepositoryService;
var init_git_repository_service = __esm({
  "src/host/git-repository-service.ts"() {
    "use strict";
    init_conflict_worker();
    init_command_policy();
    MUTATION_OUTPUT_MAX_CHARS = 1e5;
    DIFF_MAX_CHARS = 2e5;
    COMMIT_DETAIL_MAX_CHARS = 1e5;
    COMMIT_DIFF_MAX_CHARS = 3e5;
    COMMIT_FILE_MAX = 500;
    STASH_MAX = 100;
    MAX_PATHS = 100;
    OPERATION_TTL_MS = 24 * 60 * 60 * 1e3;
    repositoryLocks = /* @__PURE__ */ new Map();
    GitRepositoryService = class {
      constructor(shell) {
        this.shell = shell;
      }
      locks = repositoryLocks;
      operations = /* @__PURE__ */ new Map();
      async run(workdir, command, timeoutMs = 2e4, stdoutMaxBytes = 3e4, signal, sandboxPolicy) {
        if (!this.shell) return { exitCode: -1, stderr: { text: "shell \u670D\u52A1\u4E0D\u53EF\u7528" } };
        try {
          const specification = this.shell.resolve({ command, workdir, timeoutMs, stdoutMaxBytes, signal, ...sandboxPolicy ? { sandboxPolicy } : {} });
          return await this.shell.run(specification);
        } catch (error) {
          return { exitCode: -1, stderr: { text: error instanceof Error ? error.message : String(error) } };
        }
      }
      async getTopLevel(workdir, signal, sandboxPolicy) {
        const result = await this.run(workdir, "git rev-parse --show-toplevel", 15e3, 4096, signal, sandboxPolicy);
        const topLevel = redactAndLimit(result.stdout?.text ?? "", 4096).trim();
        if (result.exitCode !== 0 || !topLevel || !/^\/|^[A-Za-z]:[\\/]/.test(topLevel)) {
          return errorResult("NOT_GIT_REPOSITORY", "\u76EE\u6807\u76EE\u5F55\u4E0D\u662F Git \u4ED3\u5E93", redactAndLimit(outputOf(result), 4096));
        }
        return { ok: true, data: { topLevel } };
      }
      async getSummary(workdir, signal, sandboxPolicy) {
        const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy);
        if (!topLevel.ok) return topLevel;
        const [branchResult, headResult, statusResult] = await Promise.all([
          this.run(workdir, "git branch --show-current", 15e3, 4096, signal, sandboxPolicy),
          this.run(workdir, "git rev-parse --short HEAD", 15e3, 4096, signal, sandboxPolicy),
          this.run(workdir, "git status --porcelain=v1 --branch --untracked-files=all -z", 15e3, 5e4, signal, sandboxPolicy)
        ]);
        if (branchResult.exitCode !== 0 || headResult.exitCode !== 0 || statusResult.exitCode !== 0) {
          return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6 Git \u4ED3\u5E93\u6458\u8981", redactAndLimit(outputOf(branchResult) + "\n" + outputOf(headResult) + "\n" + outputOf(statusResult), 8192));
        }
        const rawStatus = statusResult.stdout?.text ?? "";
        const files = parseStatus(rawStatus);
        const status = redactAndLimit(rawStatus.replace(/\0/g, "\n"), 5e4);
        return {
          ok: true,
          data: {
            topLevel: topLevel.data.topLevel,
            branch: redactAndLimit(branchResult.stdout?.text ?? "", 4096).trim(),
            head: redactAndLimit(headResult.stdout?.text ?? "", 4096).trim(),
            status,
            files,
            stagedCount: files.filter((file) => file.indexStatus !== " " && file.indexStatus !== "?").length
          }
        };
      }
      async getDiff(workdir, path, staged, signal, sandboxPolicy) {
        if (path !== void 0 && path !== null && !validPathspec(path)) return errorResult("INVALID_ARGUMENT", "path \u5FC5\u987B\u662F\u4ED3\u5E93\u5185\u7684\u76F8\u5BF9\u8DEF\u5F84");
        const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy);
        if (!topLevel.ok) return topLevel;
        const pathArgument = typeof path === "string" ? " -- " + quoteShellArg(path) : "";
        const command = "git diff" + (staged ? " --cached" : "") + pathArgument;
        const result = await this.run(workdir, command, 2e4, DIFF_MAX_CHARS + 1024, signal, sandboxPolicy);
        if (result.exitCode !== 0) return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6 Git Diff", redactAndLimit(outputOf(result), 8192));
        let raw = redactSecrets(result.stdout?.text ?? "");
        if (!staged && typeof path === "string" && raw.length === 0) {
          const tracked = await this.run(workdir, "git ls-files --error-unmatch -- " + quoteShellArg(path), 15e3, 4096, signal, sandboxPolicy);
          if (tracked.exitCode !== 0) {
            const untracked = await this.run(workdir, "git diff --no-index -- /dev/null " + quoteShellArg(path), 2e4, DIFF_MAX_CHARS + 1024, signal, sandboxPolicy);
            if (untracked.exitCode !== 0 && untracked.exitCode !== 1) {
              return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u672A\u8DDF\u8E2A\u6587\u4EF6\u7684 Diff", redactAndLimit(outputOf(untracked), 8192));
            }
            raw = redactSecrets(untracked.stdout?.text ?? "");
          }
        }
        return { ok: true, data: { path: typeof path === "string" ? path : null, staged, diff: raw.slice(0, DIFF_MAX_CHARS), truncated: raw.length > DIFF_MAX_CHARS } };
      }
      async getBranches(workdir, signal, sandboxPolicy) {
        const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy);
        if (!topLevel.ok) return topLevel;
        const branchFormat = "%(HEAD)%09%(refname:short)%09%(upstream:short)";
        const referenceFormat = "%(refname)%09%(refname:short)%09%(objectname:short)%09%(*objectname:short)%09%(subject)";
        const [branchResult, referenceResult] = await Promise.all([
          this.run(workdir, "git branch --format=" + quoteShellArg(branchFormat), 15e3, 3e4, signal, sandboxPolicy),
          this.run(workdir, "git for-each-ref --format=" + quoteShellArg(referenceFormat) + " refs/remotes refs/tags", 15e3, 8e4, signal, sandboxPolicy)
        ]);
        if (branchResult.exitCode !== 0 || referenceResult.exitCode !== 0) {
          return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u5206\u652F\u548C\u6807\u7B7E", redactAndLimit(outputOf(branchResult) + "\n" + outputOf(referenceResult), 8192));
        }
        const branches = (branchResult.stdout?.text ?? "").split("\n").filter(Boolean).map((line) => {
          const [head = "", name = "", upstream = ""] = line.split("	");
          return { name: redactAndLimit(name, 512), current: head === "*", upstream: redactAndLimit(upstream, 512) };
        });
        const remotes = [];
        const tags = [];
        for (const line of (referenceResult.stdout?.text ?? "").split("\n").filter(Boolean)) {
          const [fullName = "", shortName = "", objectHash = "", peeledHash = "", subject = ""] = line.split("	");
          const entry = {
            name: redactAndLimit(shortName, 512),
            hash: redactAndLimit(peeledHash || objectHash, 128),
            subject: redactAndLimit(subject, 4096)
          };
          if (fullName.startsWith("refs/remotes/") && !fullName.endsWith("/HEAD")) remotes.push(entry);
          if (fullName.startsWith("refs/tags/")) tags.push(entry);
        }
        return { ok: true, data: { branches, remotes, tags } };
      }
      async getCommits(workdir, limit, signal, sandboxPolicy) {
        const resolvedLimit = typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 30;
        const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy);
        if (!topLevel.ok) return topLevel;
        const logFormat = "%H%x1f%P%x1f%s%x1f%an%x1f%aI";
        const refFormat = "%(objectname)%09%(*objectname)%09%(refname)%09%(HEAD)%09%(upstream:short)";
        const [result, refsResult] = await Promise.all([
          this.run(workdir, "git log --date-order -n " + resolvedLimit + " --format=" + quoteShellArg(logFormat), 15e3, 8e4, signal, sandboxPolicy),
          this.run(workdir, "git for-each-ref --format=" + quoteShellArg(refFormat) + " refs/heads refs/remotes refs/tags", 15e3, 8e4, signal, sandboxPolicy)
        ]);
        if (result.exitCode !== 0 || refsResult.exitCode !== 0) {
          return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u63D0\u4EA4\u8BB0\u5F55", redactAndLimit(outputOf(result) + "\n" + outputOf(refsResult), 8192));
        }
        const refLines = (refsResult.stdout?.text ?? "").split("\n").filter(Boolean).map((line) => line.split("	"));
        const currentRef = refLines.find((parts) => parts[3] === "*");
        const currentUpstream = currentRef?.[4] ?? "";
        const refsByHash = /* @__PURE__ */ new Map();
        for (const parts of refLines) {
          const [objectHash = "", peeledHash = "", fullName = "", head = ""] = parts;
          const hash = peeledHash || objectHash;
          let ref = null;
          if (fullName.startsWith("refs/heads/")) ref = { name: fullName.slice(11), type: "branch", current: head === "*" };
          else if (fullName.startsWith("refs/remotes/") && !fullName.endsWith("/HEAD")) ref = { name: fullName.slice(13), type: "remote", current: false };
          else if (fullName.startsWith("refs/tags/")) ref = { name: fullName.slice(10), type: "tag", current: false };
          const relevant = ref?.type === "tag" || ref?.current === true || ref?.type === "remote" && ref.name === currentUpstream;
          if (!ref || !hash || !relevant) continue;
          const safeRef = { ...ref, name: redactAndLimit(ref.name, 512) };
          refsByHash.set(hash, [...refsByHash.get(hash) ?? [], safeRef]);
        }
        const commits = (result.stdout?.text ?? "").split("\n").filter(Boolean).map((line) => {
          const [hash = "", parents = "", subject = "", author = "", date = ""] = line.split("");
          return {
            hash: redactAndLimit(hash, 128),
            parents: parents.split(" ").filter(Boolean).map((parent) => redactAndLimit(parent, 128)),
            subject: redactAndLimit(subject, 4096),
            author: redactAndLimit(author, 512),
            date: redactAndLimit(date, 128),
            refs: refsByHash.get(hash) ?? []
          };
        });
        return { ok: true, data: commits };
      }
      async getCommitDetail(workdir, hash, signal, sandboxPolicy) {
        if (!validCommitHash(hash)) return errorResult("INVALID_ARGUMENT", "\u63D0\u4EA4\u54C8\u5E0C\u5FC5\u987B\u662F\u5B8C\u6574\u7684 40 \u6216 64 \u4F4D\u5341\u516D\u8FDB\u5236\u5B57\u7B26");
        const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy);
        if (!topLevel.ok) return topLevel;
        const format = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%b%x1e";
        const metadata = await this.run(
          workdir,
          "git show -s --no-show-signature --format=" + quoteShellArg(format) + " " + quoteShellArg(hash),
          15e3,
          COMMIT_DETAIL_MAX_CHARS,
          signal,
          sandboxPolicy
        );
        if (metadata.exitCode !== 0) return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u63D0\u4EA4\u8BE6\u60C5", redactAndLimit(outputOf(metadata), 8192));
        const fields = (metadata.stdout?.text ?? "").replace(/\x1e\s*$/, "").split("");
        const resolvedHash = fields[0] ?? "";
        const parents = (fields[1] ?? "").split(" ").filter(Boolean);
        const comparisonBase = parents[0] ?? null;
        const common = "--no-ext-diff --no-textconv --find-renames";
        const range = comparisonBase ? quoteShellArg(comparisonBase) + " " + quoteShellArg(resolvedHash) : quoteShellArg(resolvedHash);
        const [nameStatusResult, numstatResult] = await Promise.all([
          this.run(workdir, comparisonBase ? "git diff " + common + " --name-status " + range + " --" : "git diff-tree --root --no-commit-id --name-status -r -M " + range + " --", 2e4, COMMIT_DETAIL_MAX_CHARS, signal, sandboxPolicy),
          this.run(workdir, comparisonBase ? "git diff " + common + " --numstat " + range + " --" : "git diff-tree --root --no-commit-id --numstat -r -M " + range + " --", 2e4, COMMIT_DETAIL_MAX_CHARS, signal, sandboxPolicy)
        ]);
        if (nameStatusResult.exitCode !== 0 || numstatResult.exitCode !== 0) {
          return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u63D0\u4EA4\u53D8\u66F4\u6458\u8981", redactAndLimit(outputOf(nameStatusResult) + "\n" + outputOf(numstatResult), 8192));
        }
        const parsed = parseCommitFiles(nameStatusResult.stdout?.text ?? "", numstatResult.stdout?.text ?? "");
        return {
          ok: true,
          data: {
            hash: redactAndLimit(resolvedHash, 128),
            parents: parents.map((parent) => redactAndLimit(parent, 128)),
            authorName: redactAndLimit(fields[2] ?? "", 512),
            authorEmail: redactAndLimit(fields[3] ?? "", 512),
            authoredAt: redactAndLimit(fields[4] ?? "", 128),
            committerName: redactAndLimit(fields[5] ?? "", 512),
            committerEmail: redactAndLimit(fields[6] ?? "", 512),
            committedAt: redactAndLimit(fields[7] ?? "", 128),
            subject: redactAndLimit(fields[8] ?? "", 4096),
            body: redactAndLimit(fields[9] ?? "", 5e4),
            comparisonBase,
            ...parsed
          }
        };
      }
      async getCommitDiff(workdir, hash, signal, sandboxPolicy) {
        if (!validCommitHash(hash)) return errorResult("INVALID_ARGUMENT", "\u63D0\u4EA4\u54C8\u5E0C\u5FC5\u987B\u662F\u5B8C\u6574\u7684 40 \u6216 64 \u4F4D\u5341\u516D\u8FDB\u5236\u5B57\u7B26");
        const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy);
        if (!topLevel.ok) return topLevel;
        const parentsResult = await this.run(workdir, "git show -s --format=%P " + quoteShellArg(hash), 15e3, 4096, signal, sandboxPolicy);
        if (parentsResult.exitCode !== 0) return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u63D0\u4EA4\u7236\u8282\u70B9", redactAndLimit(outputOf(parentsResult), 8192));
        const comparisonBase = (parentsResult.stdout?.text ?? "").trim().split(" ").filter(Boolean)[0] ?? null;
        const common = "--no-ext-diff --no-textconv --find-renames --patch";
        const command = comparisonBase ? "git diff " + common + " " + quoteShellArg(comparisonBase) + " " + quoteShellArg(hash) + " --" : "git show --format= " + common + " " + quoteShellArg(hash) + " --";
        const result = await this.run(workdir, command, 3e4, COMMIT_DIFF_MAX_CHARS + 1024, signal, sandboxPolicy);
        if (result.exitCode !== 0) return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u63D0\u4EA4 Diff", redactAndLimit(outputOf(result), 8192));
        const raw = redactSecrets(result.stdout?.text ?? "");
        return {
          ok: true,
          data: { hash, comparisonBase, diff: raw.slice(0, COMMIT_DIFF_MAX_CHARS), truncated: raw.length > COMMIT_DIFF_MAX_CHARS }
        };
      }
      async getStashes(workdir, signal, sandboxPolicy) {
        const topLevel = await this.getTopLevel(workdir, signal, sandboxPolicy);
        if (!topLevel.ok) return topLevel;
        const format = "%gd%x1f%H%x1f%gs%x1f%an%x1f%aI";
        const result = await this.run(
          workdir,
          "git stash list --max-count=" + STASH_MAX + " --format=" + quoteShellArg(format),
          15e3,
          COMMIT_DETAIL_MAX_CHARS,
          signal,
          sandboxPolicy
        );
        if (result.exitCode !== 0) return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u8D2E\u85CF\u5217\u8868", redactAndLimit(outputOf(result), 8192));
        const stashes = (result.stdout?.text ?? "").split("\n").filter(Boolean).slice(0, STASH_MAX).map((line) => {
          const [selector = "", hash = "", subject = "", author = "", date = ""] = line.split("");
          return {
            selector: redactAndLimit(selector, 128),
            hash: redactAndLimit(hash, 128),
            subject: redactAndLimit(subject, 4096),
            author: redactAndLimit(author, 512),
            date: redactAndLimit(date, 128)
          };
        });
        return { ok: true, data: stashes };
      }
      async getSyncState(workdir, signal, sandboxPolicy) {
        const summary = await this.getSummary(workdir, signal, sandboxPolicy);
        if (!summary.ok) return summary;
        const [remoteResult, upstreamResult, rebaseResult] = await Promise.all([
          this.run(workdir, "git remote", 15e3, 2e4, signal, sandboxPolicy),
          this.run(workdir, "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}", 15e3, 4096, signal, sandboxPolicy),
          this.run(workdir, 'test -d "$(git rev-parse --git-path rebase-merge)" || test -d "$(git rev-parse --git-path rebase-apply)"', 15e3, 4096, signal, sandboxPolicy)
        ]);
        if (remoteResult.exitCode !== 0) {
          return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u8FDC\u7A0B\u4ED3\u5E93", redactAndLimit(outputOf(remoteResult), 8192));
        }
        const remotes = (remoteResult.stdout?.text ?? "").split("\n").map((entry) => redactAndLimit(entry.trim(), 255)).filter(Boolean);
        const upstream = upstreamResult.exitCode === 0 ? redactAndLimit(upstreamResult.stdout?.text ?? "", 512).trim() : "";
        let ahead = 0;
        let behind = 0;
        if (upstream) {
          const counts = await this.run(workdir, "git rev-list --left-right --count HEAD...@{upstream}", 15e3, 4096, signal, sandboxPolicy);
          if (counts.exitCode !== 0) return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BA1\u7B97\u672C\u5730\u4E0E\u4E0A\u6E38\u7684\u63D0\u4EA4\u5DEE\u5F02", redactAndLimit(outputOf(counts), 8192));
          const [aheadText = "0", behindText = "0"] = (counts.stdout?.text ?? "").trim().split(/\s+/);
          ahead = /^\d+$/.test(aheadText) ? Number(aheadText) : 0;
          behind = /^\d+$/.test(behindText) ? Number(behindText) : 0;
        }
        const conflicts = conflictCount(summary.data.files);
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
            files: summary.data.files
          }
        };
      }
      async fetchRemote(request, remote) {
        if (!validRemoteName(remote)) return errorResult("INVALID_ARGUMENT", "\u8FDC\u7A0B\u4ED3\u5E93\u540D\u79F0\u4E0D\u5408\u6CD5");
        const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy);
        if (!state.ok) return state;
        if (!state.data.remotes.includes(remote)) return errorResult("STATE_CONFLICT", "\u8FDC\u7A0B\u4ED3\u5E93\u4E0D\u5B58\u5728", void 0, "NO_REMOTE");
        return this.mutateSync(request, "git fetch " + quoteShellArg(remote), "\u83B7\u53D6\u8FDC\u7A0B\u66F4\u65B0\u5931\u8D25");
      }
      async pullFfOnly(request) {
        const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy);
        if (!state.ok) return state;
        if (!state.data.branch) return errorResult("STATE_CONFLICT", "\u5206\u79BB HEAD \u72B6\u6001\u4E0D\u80FD\u76F4\u63A5\u62C9\u53D6", void 0, "DETACHED_HEAD");
        if (!state.data.upstream) return errorResult("STATE_CONFLICT", "\u5F53\u524D\u5206\u652F\u6CA1\u6709\u4E0A\u6E38\u8DDF\u8E2A\u5206\u652F", void 0, "NO_UPSTREAM");
        if (state.data.rebaseInProgress) return errorResult("STATE_CONFLICT", "Rebase \u8FDB\u884C\u4E2D\uFF0C\u8BF7\u5148\u7EE7\u7EED\u6216\u4E2D\u6B62", void 0, "REBASE_IN_PROGRESS");
        if (state.data.conflictCount > 0) return errorResult("STATE_CONFLICT", "\u5B58\u5728\u5C1A\u672A\u89E3\u51B3\u7684\u51B2\u7A81", void 0, "CONFLICTS_PRESENT");
        return this.mutateSync(request, "git pull --ff-only", "\u62C9\u53D6\u8FDC\u7A0B\u66F4\u65B0\u5931\u8D25");
      }
      async pushCurrent(request, remote, branch, setUpstream) {
        const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy);
        if (!state.ok) return state;
        if (!state.data.branch) return errorResult("STATE_CONFLICT", "\u5206\u79BB HEAD \u72B6\u6001\u4E0D\u80FD\u76F4\u63A5\u63A8\u9001", void 0, "DETACHED_HEAD");
        if (state.data.rebaseInProgress) return errorResult("STATE_CONFLICT", "Rebase \u8FDB\u884C\u4E2D\uFF0C\u8BF7\u5148\u7EE7\u7EED\u6216\u4E2D\u6B62", void 0, "REBASE_IN_PROGRESS");
        if (setUpstream) {
          if (state.data.upstream) return errorResult("STATE_CONFLICT", "\u5F53\u524D\u5206\u652F\u5DF2\u7ECF\u6709\u4E0A\u6E38\uFF0C\u8BF7\u4F7F\u7528\u666E\u901A\u63A8\u9001");
          if (!validRemoteName(remote) || !state.data.remotes.includes(remote)) return errorResult("STATE_CONFLICT", "\u8BF7\u9009\u62E9\u5B58\u5728\u7684\u8FDC\u7A0B\u4ED3\u5E93", void 0, "NO_REMOTE");
          if (!validBranchName(branch) || branch !== state.data.branch) return errorResult("INVALID_ARGUMENT", "\u53EA\u80FD\u4E3A\u5F53\u524D\u672C\u5730\u5206\u652F\u5EFA\u7ACB\u4E0A\u6E38");
          return this.mutateSync(request, "git push -u " + quoteShellArg(remote) + " " + quoteShellArg(branch), "\u63A8\u9001\u5E76\u5EFA\u7ACB\u4E0A\u6E38\u5931\u8D25");
        }
        if (!state.data.upstream) return errorResult("STATE_CONFLICT", "\u5F53\u524D\u5206\u652F\u6CA1\u6709\u4E0A\u6E38\u8DDF\u8E2A\u5206\u652F", void 0, "NO_UPSTREAM");
        return this.mutateSync(request, "git push", "\u63A8\u9001\u5931\u8D25");
      }
      async rebaseOnto(request, target, confirmRisk) {
        if (!validBranchName(target)) return errorResult("INVALID_ARGUMENT", "Rebase \u76EE\u6807\u5FC5\u987B\u662F\u5B89\u5168\u7684\u672C\u5730\u6216\u8FDC\u7A0B\u5206\u652F\u5F15\u7528");
        if (!confirmRisk) return errorResult("PERMISSION_DENIED", "Rebase \u4F1A\u91CD\u5199\u672C\u5730\u63D0\u4EA4\u5386\u53F2\uFF0C\u6267\u884C\u524D\u5FC5\u987B\u786E\u8BA4\u98CE\u9669");
        const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy);
        if (!state.ok) return state;
        if (!state.data.branch) return errorResult("STATE_CONFLICT", "\u5206\u79BB HEAD \u72B6\u6001\u4E0D\u80FD\u5F00\u59CB Rebase", void 0, "DETACHED_HEAD");
        if (state.data.rebaseInProgress) return errorResult("STATE_CONFLICT", "\u5DF2\u6709 Rebase \u6B63\u5728\u8FDB\u884C", void 0, "REBASE_IN_PROGRESS");
        if (state.data.dirty) return errorResult("STATE_CONFLICT", "Rebase \u524D\u9700\u8981\u63D0\u4EA4\u6216\u8D2E\u85CF\u5DE5\u4F5C\u533A\u6539\u52A8", void 0, "DIRTY_WORKTREE");
        const exists = await this.run(request.workdir, "git rev-parse --verify --quiet " + quoteShellArg(target + "^{commit}"), 15e3, 4096, request.signal, request.sandboxPolicy);
        if (exists.exitCode !== 0) return errorResult("STATE_CONFLICT", "Rebase \u76EE\u6807\u5F15\u7528\u4E0D\u5B58\u5728", void 0, "REF_NOT_FOUND");
        return this.mutateSync(request, "git rebase " + quoteShellArg(target), "Rebase \u5931\u8D25");
      }
      async continueRebase(request, confirmRisk) {
        if (!confirmRisk) return errorResult("PERMISSION_DENIED", "\u7EE7\u7EED Rebase \u524D\u5FC5\u987B\u786E\u8BA4\u5386\u53F2\u91CD\u5199\u98CE\u9669");
        const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy);
        if (!state.ok) return state;
        if (!state.data.rebaseInProgress) return errorResult("STATE_CONFLICT", "\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684 Rebase", void 0, "NO_REBASE_IN_PROGRESS");
        if (state.data.conflictCount > 0) return errorResult("STATE_CONFLICT", "\u4ECD\u6709\u51B2\u7A81\u6587\u4EF6\uFF0C\u8BF7\u89E3\u51B3\u5E76\u6682\u5B58\u540E\u518D\u7EE7\u7EED", void 0, "CONFLICTS_PRESENT");
        return this.mutateSync(request, "git -c core.editor=true rebase --continue", "\u7EE7\u7EED Rebase \u5931\u8D25");
      }
      async abortRebase(request, confirmRisk) {
        if (!confirmRisk) return errorResult("PERMISSION_DENIED", "\u4E2D\u6B62 Rebase \u4F1A\u4E22\u5F03\u672C\u6B21\u53D8\u57FA\u8FC7\u7A0B\u4E2D\u7684\u4FEE\u6539\uFF0C\u6267\u884C\u524D\u5FC5\u987B\u786E\u8BA4\u98CE\u9669");
        const state = await this.getSyncState(request.workdir, request.signal, request.sandboxPolicy);
        if (!state.ok) return state;
        if (!state.data.rebaseInProgress) return errorResult("STATE_CONFLICT", "\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684 Rebase", void 0, "NO_REBASE_IN_PROGRESS");
        return this.mutateSync(request, "git rebase --abort", "\u4E2D\u6B62 Rebase \u5931\u8D25");
      }
      async stagePaths(request, paths) {
        const valid = this.validatePaths(paths);
        if (!valid.ok) return valid;
        return this.mutate(request, "git add -- " + valid.data.map(quoteShellArg).join(" "), false, "\u6682\u5B58\u6587\u4EF6\u5931\u8D25");
      }
      async unstagePaths(request, paths) {
        const valid = this.validatePaths(paths);
        if (!valid.ok) return valid;
        return this.mutate(request, "git reset HEAD -- " + valid.data.map(quoteShellArg).join(" "), false, "\u53D6\u6D88\u6682\u5B58\u6587\u4EF6\u5931\u8D25");
      }
      async stageAll(request) {
        return this.mutate(request, "git add -A", false, "\u5168\u90E8\u6682\u5B58\u5931\u8D25");
      }
      async unstageAll(request) {
        return this.mutate(request, "git reset HEAD -- :/", false, "\u53D6\u6D88\u5168\u90E8\u6682\u5B58\u5931\u8D25");
      }
      async commit(request, message) {
        if (typeof message !== "string" || !message.trim() || message.length > 4096 || /[\0\r\n]/.test(message)) {
          return errorResult("INVALID_ARGUMENT", "\u63D0\u4EA4\u4FE1\u606F\u5FC5\u987B\u4E3A 1\u20134096 \u4E2A\u975E\u6362\u884C\u5B57\u7B26");
        }
        return this.mutate(request, "git commit -m " + quoteShellArg(message.trim()), true, "\u63D0\u4EA4\u5931\u8D25");
      }
      async createBranch(request, name, base) {
        if (!validBranchName(name) || !validBranchName(base)) return errorResult("INVALID_ARGUMENT", "\u5206\u652F\u540D\u548C\u57FA\u7840\u5206\u652F\u5FC5\u987B\u662F\u5B89\u5168\u7684\u672C\u5730 Git \u5F15\u7528");
        const repository = await this.getTopLevel(request.workdir, request.signal, request.sandboxPolicy);
        if (!repository.ok) return repository;
        const exists = await this.run(
          request.workdir,
          "git show-ref --verify --quiet " + quoteShellArg("refs/heads/" + name),
          15e3,
          4096,
          request.signal,
          request.sandboxPolicy
        );
        if (exists.exitCode === 0) return errorResult("STATE_CONFLICT", "\u540C\u540D\u672C\u5730\u5206\u652F\u5DF2\u7ECF\u5B58\u5728", void 0, "BRANCH_EXISTS");
        if (exists.exitCode !== 1) return errorResult("GIT_FAILED", "\u65E0\u6CD5\u68C0\u67E5\u76EE\u6807\u5206\u652F\u662F\u5426\u5B58\u5728", redactAndLimit(outputOf(exists), 8192));
        return this.mutate(request, "git switch -c " + quoteShellArg(name) + " " + quoteShellArg(base), false, "\u521B\u5EFA\u5206\u652F\u5931\u8D25");
      }
      async switchBranch(request, name) {
        if (!validBranchName(name)) return errorResult("INVALID_ARGUMENT", "\u5206\u652F\u540D\u5FC5\u987B\u662F\u5B89\u5168\u7684\u672C\u5730 Git \u5F15\u7528");
        return this.mutate(request, "git switch " + quoteShellArg(name), false, "\u5207\u6362\u5206\u652F\u5931\u8D25");
      }
      async deleteBranch(request, name, force, confirmRisk) {
        if (!validBranchName(name)) return errorResult("INVALID_ARGUMENT", "\u5206\u652F\u540D\u5FC5\u987B\u662F\u5B89\u5168\u7684\u672C\u5730 Git \u5F15\u7528");
        const topLevel = await this.getTopLevel(request.workdir, request.signal, request.sandboxPolicy);
        if (!topLevel.ok) return topLevel;
        const [currentResult, existsResult] = await Promise.all([
          this.run(request.workdir, "git branch --show-current", 15e3, 4096, request.signal, request.sandboxPolicy),
          this.run(request.workdir, "git show-ref --verify --quiet " + quoteShellArg("refs/heads/" + name), 15e3, 4096, request.signal, request.sandboxPolicy)
        ]);
        if (currentResult.exitCode !== 0) return errorResult("GIT_FAILED", "\u65E0\u6CD5\u68C0\u67E5\u5F53\u524D\u5206\u652F", redactAndLimit(outputOf(currentResult), 8192));
        if (redactAndLimit(currentResult.stdout?.text ?? "", 4096).trim() === name) {
          return errorResult("STATE_CONFLICT", "\u5F53\u524D\u5206\u652F\u4E0D\u80FD\u5220\u9664\uFF0C\u8BF7\u5148\u5207\u6362\u5230\u5176\u4ED6\u5206\u652F", void 0, "CURRENT_BRANCH");
        }
        if (existsResult.exitCode !== 0) return errorResult("STATE_CONFLICT", "\u8981\u5220\u9664\u7684\u672C\u5730\u5206\u652F\u4E0D\u5B58\u5728", void 0, "BRANCH_NOT_FOUND");
        if (force && !confirmRisk) return errorResult("PERMISSION_DENIED", "\u5F3A\u5236\u5220\u9664\u524D\u5FC5\u987B\u786E\u8BA4\u672A\u5408\u5E76\u63D0\u4EA4\u53EF\u80FD\u6C38\u4E45\u4E22\u5931");
        const command = "git branch " + (force ? "-D" : "-d") + " -- " + quoteShellArg(name);
        const deleted = await this.mutate(request, command, false, force ? "\u5F3A\u5236\u5220\u9664\u5206\u652F\u5931\u8D25" : "\u5B89\u5168\u5220\u9664\u5206\u652F\u5931\u8D25");
        if (deleted.ok || force || deleted.code !== "GIT_FAILED") return deleted;
        const merged = await this.run(request.workdir, "git merge-base --is-ancestor " + quoteShellArg(name) + " HEAD", 15e3, 4096, request.signal, request.sandboxPolicy);
        if (merged.exitCode === 1) {
          return errorResult("STATE_CONFLICT", "\u5206\u652F\u5305\u542B\u5C1A\u672A\u5408\u5E76\u7684\u63D0\u4EA4\uFF0C\u5B89\u5168\u5220\u9664\u5DF2\u62D2\u7EDD", deleted.diagnostics, "UNMERGED_BRANCH");
        }
        return deleted;
      }
      validatePaths(paths) {
        if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS || !paths.every(validPathspec)) {
          return errorResult("INVALID_ARGUMENT", "paths \u5FC5\u987B\u5305\u542B 1\u2013100 \u4E2A\u4ED3\u5E93\u5185\u76F8\u5BF9\u8DEF\u5F84");
        }
        return { ok: true, data: paths };
      }
      mutate(request, command, requiresStagedContent = false, failureMessage = "Git \u64CD\u4F5C\u5931\u8D25") {
        return this.mutateAndRead(request, command, failureMessage, requiresStagedContent, () => this.getSummary(request.workdir, request.signal, request.sandboxPolicy));
      }
      mutateSync(request, command, failureMessage) {
        return this.mutateAndRead(request, command, failureMessage, false, () => this.getSyncState(request.workdir, request.signal, request.sandboxPolicy));
      }
      async mutateAndRead(request, command, failureMessage, requiresStagedContent, readResult) {
        return this.withMutation(request, async () => {
          if (requiresStagedContent) {
            const staged = await this.run(request.workdir, "git diff --cached --quiet", 15e3, 4096, request.signal, request.sandboxPolicy);
            if (staged.exitCode === 0) return errorResult("STATE_CONFLICT", "\u6CA1\u6709\u5DF2\u6682\u5B58\u7684\u6539\u52A8\uFF0C\u65E0\u6CD5\u63D0\u4EA4");
            if (staged.exitCode !== 1) return errorResult("GIT_FAILED", "\u65E0\u6CD5\u68C0\u67E5\u6682\u5B58\u533A", redactAndLimit(outputOf(staged), 8192));
          }
          const executed = await this.run(request.workdir, command, 12e4, MUTATION_OUTPUT_MAX_CHARS, request.signal, request.sandboxPolicy);
          if (executed.exitCode !== 0) return errorResult(mutationErrorCode(executed), failureMessage, redactAndLimit(outputOf(executed), 8192));
          const result = await readResult();
          return result.ok ? { ...result, operationId: String(request.operationId) } : result;
        });
      }
      async conflictAction(action, workdir, payload, request, sandboxPolicy) {
        if (action === "save-conflict" && (typeof payload.content !== "string" || Buffer.byteLength(payload.content) > 48 * 1024)) {
          return errorResult("INVALID_ARGUMENT", "\u7ED3\u679C\u5FC5\u987B\u662F 48 KiB \u4EE5\u5185\u7684\u6587\u672C");
        }
        const run = async () => {
          const result = await this.run(workdir, conflictWorkerCommand(action, payload), 12e4, 2 * 1024 * 1024, request?.signal, request?.sandboxPolicy ?? sandboxPolicy);
          if (result.exitCode !== 0) return errorResult(mutationErrorCode(result), "\u51B2\u7A81\u64CD\u4F5C\u5931\u8D25", redactAndLimit(outputOf(result), 8192));
          try {
            const response = JSON.parse(result.stdout?.text ?? "");
            if (!response.ok && response.diagnostics) response.diagnostics = redactAndLimit(response.diagnostics, 8192);
            if (!response.ok) response.message = redactAndLimit(response.message, 8192);
            return response;
          } catch {
            return errorResult("GIT_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u5B8C\u6574\u7684\u51B2\u7A81\u6570\u636E");
          }
        };
        return request ? this.withMutation(request, run) : run();
      }
      async withMutation(request, task) {
        if (!request.sessionId || !request.workdir) return errorResult("SESSION_NOT_FOUND", "\u65E0\u6CD5\u786E\u5B9A\u5F53\u524D\u4F1A\u8BDD\u7684\u4ED3\u5E93\u76EE\u5F55");
        if (typeof request.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.operationId)) {
          return errorResult("INVALID_ARGUMENT", "operationId \u5FC5\u987B\u662F 1\u2013128 \u4E2A\u5B89\u5168\u5B57\u7B26");
        }
        this.pruneOperations();
        const repository = await this.getTopLevel(request.workdir, request.signal, request.sandboxPolicy);
        if (!repository.ok) return repository;
        const key = request.sessionId + "\0" + repository.data.topLevel + "\0" + request.operationId;
        const existing = this.operations.get(key);
        if (existing) return existing.result;
        const lockKey = repository.data.topLevel;
        const previous = this.locks.get(lockKey) ?? Promise.resolve();
        let release = () => {
        };
        const current = new Promise((resolve) => {
          release = resolve;
        });
        const queued = previous.then(() => current);
        this.locks.set(lockKey, queued);
        const result = previous.then(async () => {
          try {
            return await task();
          } finally {
            release();
            if (this.locks.get(lockKey) === queued) this.locks.delete(lockKey);
          }
        });
        this.operations.set(key, { createdAt: Date.now(), result });
        return result;
      }
      pruneOperations(now = Date.now()) {
        for (const [key, entry] of this.operations) if (now - entry.createdAt > OPERATION_TTL_MS) this.operations.delete(key);
      }
    };
  }
});

// src/host/plugin.ts
var require_plugin = __commonJS({
  "src/host/plugin.ts"(exports2, module2) {
    "use strict";
    init_actions();
    init_proposal_service();
    init_git_repository_service();
    init_command_policy();
    var MAX_STEPS = 10;
    function sessionIdOf(exec) {
      try {
        const agent = exec && exec.agent;
        if (agent && typeof agent.id === "string" && agent.id.trim() && agent.id.trim().length <= 200) return agent.id.trim();
      } catch (e) {
      }
      return null;
    }
    function sessionWorkdir(exec, args, ctx) {
      try {
        if (args && typeof args.workdir === "string" && args.workdir.trim()) return args.workdir.trim();
      } catch (e) {
      }
      try {
        const agent = exec && exec.agent;
        const session = agent && agent.session;
        const header = session && session.header;
        const cwd = session && session.cwd || header && header.cwd;
        if (typeof cwd === "string" && cwd) return cwd;
      } catch (e) {
      }
      try {
        const sp = ctx.get("sandboxPolicy");
        if (sp && typeof sp.workspaceRoot === "string" && sp.workspaceRoot) return sp.workspaceRoot;
      } catch (e) {
      }
      return void 0;
    }
    async function repositoryContextForSession(ctx, sandboxPolicy, sessionId) {
      try {
        const agents = ctx.get("agents");
        const agent = agents && agents.get(sessionId);
        const session = agent?.session ?? ctx.get("sessions")?.get(sessionId);
        if (session) {
          const workdir = sessionWorkdir({ agent: { session } }, {}, ctx);
          if (!workdir) return null;
          return { workdir, policy: sandboxPolicy?.resolve({ session }) };
        }
        const query = ctx.get("sessionQuery");
        if (!query) return null;
        const observation = await query.observeSession(sessionId);
        try {
          const workdir = observation.header.cwd;
          if (!workdir || !observation.projections) return null;
          const mode = observation.projections.values.sandboxMode ?? void 0;
          const policy = sandboxPolicy ? { ...sandboxPolicy.resolve({ mode }), workspaceRoot: workdir, sessionId } : void 0;
          return { workdir, policy };
        } finally {
          observation[Symbol.dispose]();
        }
      } catch (error) {
        return null;
      }
    }
    async function runGit(shell, workdir, command, timeoutMs, stdoutMaxBytes, signal, policy) {
      try {
        const spec = shell.resolve({ command, workdir, timeoutMs, stdoutMaxBytes, signal, ...policy ? { sandboxPolicy: policy } : {} });
        return await shell.run(spec);
      } catch (err) {
        return { exitCode: -1, signal: null, timedOut: false, aborted: false, stdout: { text: "" }, stderr: { text: errorMessage2(err) } };
      }
    }
    function errorMessage2(error) {
      return error instanceof Error ? error.message : String(error);
    }
    async function captureFingerprint(shell, workdir) {
      if (!shell) return null;
      const command = "echo '--B--'; git branch --show-current 2>&1; echo '--H--'; git rev-parse HEAD 2>&1; echo '--S--'; git status --short 2>&1; echo '--L--'; git log --oneline -3 2>&1; echo '--T--'; git stash list 2>&1";
      const r = await runGit(shell, workdir, command, 15e3, 2e4);
      return ((r.stdout?.text ?? "") + (r.stderr?.text ?? "")).trim();
    }
    async function captureDiagnostics(shell, workdir) {
      if (!shell) return "";
      const command = "echo '--STATUS--'; git status --short --branch 2>&1; echo '--LOG--'; git log --oneline -3 2>&1; echo '--BRANCH--'; git branch -vv 2>&1; echo '--REMOTE--'; git remote -v 2>&1";
      const r = await runGit(shell, workdir, command, 15e3, 2e4);
      return redactAndLimit(((r.stdout?.text ?? "") + (r.stderr?.text ?? "")).trim());
    }
    async function runChecks(shell, workdir, checks) {
      if (!shell) return checks.map((check) => check.label);
      const failed = [];
      for (const c of checks) {
        let pass = false;
        try {
          if (c.type === "branch") {
            const r = await runGit(shell, workdir, "git branch --show-current", 1e4, 4096);
            pass = (r.stdout?.text ?? "").trim() === c.value;
          } else if (c.type === "commit-msg") {
            const r = await runGit(shell, workdir, "git log -1 --pretty=%s", 1e4, 4096);
            pass = (r.stdout?.text ?? "").trim() === c.value;
          } else if (c.type === "staged") {
            const paths = Array.isArray(c.value) ? c.value : String(c.value).split(/\s+/).filter(Boolean);
            pass = true;
            for (const path of paths) {
              const r = await runGit(shell, workdir, "git diff --cached --quiet -- " + quoteShellArg(path), 1e4, 4096);
              if (r.exitCode !== 1) {
                pass = false;
                break;
              }
            }
          } else if (c.type === "branch-gone") {
            const r = await runGit(shell, workdir, "git branch --list " + quoteShellArg(c.value), 1e4, 4096);
            pass = (r.stdout?.text ?? "").trim() === "";
          } else if (c.type === "stash-nonempty") {
            const r = await runGit(shell, workdir, "git stash list", 1e4, 4096);
            pass = (r.stdout?.text ?? "").trim().length > 0;
          } else if (c.type === "stash-empty") {
            const r = await runGit(shell, workdir, "git stash list", 1e4, 4096);
            pass = (r.stdout?.text ?? "").trim().length === 0;
          } else if (c.type === "clean") {
            const paths = Array.isArray(c.value) ? c.value : String(c.value).split(/\s+/).filter(Boolean);
            const r = await runGit(shell, workdir, "git status --porcelain -- " + paths.map(quoteShellArg).join(" "), 1e4, 4096);
            pass = r.exitCode === 0 && (r.stdout?.text ?? "").trim() === "";
          } else if (c.type === "no-ahead") {
            const r = await runGit(shell, workdir, "git rev-list --count @{u}..HEAD 2>&1", 1e4, 4096);
            pass = (r.stdout?.text ?? "").trim() === "0";
          }
        } catch (e) {
          pass = false;
        }
        if (!pass) failed.push(c.label);
      }
      return failed;
    }
    async function verifyProposal(shell, proposal) {
      const now = await captureFingerprint(shell, proposal.workdir);
      const changed = now !== null && proposal.fingerprint !== null && now !== proposal.fingerprint;
      const visibleState = redactAndLimit(now || "");
      const checks = deriveChecks(proposal.steps.map((s) => s.command));
      if (checks.length === 0) {
        return {
          changed,
          verified: false,
          partial: changed,
          message: changed ? "\u68C0\u6D4B\u5230\u4ED3\u5E93\u72B6\u6001\u53D8\u5316\uFF0C\u4F46\u8BE5\u547D\u4EE4\u6CA1\u6709\u53EF\u53EF\u9760\u6BD4\u5BF9\u7684\u76EE\u6807\u72B6\u6001\uFF0C\u65E0\u6CD5\u786E\u8BA4\u53D8\u5316\u6765\u81EA\u672C\u5EFA\u8BAE" : "\u672A\u68C0\u6D4B\u5230\u4ED3\u5E93\u72B6\u6001\u53D8\u5316\uFF0C\u770B\u8D77\u6765\u8FD8\u6CA1\u6709\u6267\u884C",
          changedState: changed ? visibleState : ""
        };
      }
      const failed = await runChecks(shell, proposal.workdir, checks);
      const baselineFailed = Array.isArray(proposal.baselineFailed) ? proposal.baselineFailed : [];
      const transitioned = baselineFailed.length > 0 && failed.length === 0;
      if (transitioned) return { changed, verified: true, partial: false, message: "", changedState: visibleState };
      if (failed.length === 0) {
        return {
          changed,
          verified: false,
          partial: changed,
          message: "\u590D\u5236\u547D\u4EE4\u65F6\u76EE\u6807\u72B6\u6001\u5DF2\u7ECF\u6EE1\u8DB3\uFF0C\u65E0\u6CD5\u636E\u6B64\u786E\u8BA4\u672C\u6B21\u662F\u5426\u6267\u884C\uFF1B\u8BF7\u5728\u7EC8\u7AEF\u6838\u5BF9\u7ED3\u679C",
          changedState: changed ? visibleState : ""
        };
      }
      const progress = changed || failed.length < baselineFailed.length;
      return {
        changed,
        verified: false,
        partial: progress,
        message: (progress ? "\u68C0\u6D4B\u5230\u72B6\u6001\u53D8\u5316\uFF0C\u4F46\u9884\u671F\u7ED3\u679C\u5C1A\u672A\u5168\u90E8\u8FBE\u6210\uFF1A" : "\u672A\u68C0\u6D4B\u5230\u9884\u671F\u7ED3\u679C\uFF1A") + failed.join("\uFF1B"),
        changedState: changed ? visibleState : ""
      };
    }
    async function executeProposalSteps(shell, proposal, signal, policy) {
      let ok = true;
      const stepsResult = [];
      for (const step of proposal.steps) {
        const validated = validateCommand(step.command);
        if (!validated.ok) {
          step.result = { ok: false, exitCode: -1, signal: "", timedOut: false, stdout: "", stderr: validated.error };
          stepsResult.push({ command: step.command, ok: false, exitCode: -1 });
          ok = false;
          break;
        }
        const r = await runGit(shell, proposal.workdir, validated.normalized, 12e4, 1e5, signal, policy);
        const sok = r.exitCode === 0;
        const result = {
          ok: sok,
          exitCode: r.exitCode === null ? -1 : r.exitCode,
          signal: r.signal || "",
          timedOut: r.timedOut === true,
          stdout: redactAndLimit(r.stdout?.text ?? ""),
          stderr: redactAndLimit(r.stderr?.text ?? "")
        };
        step.result = result;
        stepsResult.push({ command: step.command, ok: sok, exitCode: result.exitCode });
        if (!sok) {
          ok = false;
          break;
        }
      }
      proposal.result = { ok };
      return { ok, stepsResult };
    }
    function executionError(proposal, error) {
      return {
        ok: false,
        proposalId: proposal ? proposal.proposalId : "",
        command: proposal ? proposal.command : "",
        steps: [],
        exitCode: -1,
        signal: "",
        timedOut: false,
        stdout: "",
        stderr: "",
        diagnostics: "",
        error
      };
    }
    async function executeRegisteredProposal(shell, proposal, signal, policy, persistStatus) {
      if (!proposal) return executionError(null, "\u627E\u4E0D\u5230\u8BE5\u63D0\u8BAE\uFF08proposalId \u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF09");
      if (proposal.closed === true || proposal.status === "succeeded" || proposal.status === "failed" || proposal.status === "verified" || proposal.status === "dismissed") {
        return executionError(proposal, "\u8BE5\u63D0\u8BAE\u5DF2\u7ECF\u7ED3\u675F\uFF0C\u4E0D\u80FD\u91CD\u590D\u6267\u884C\uFF1B\u5982\u9700\u91CD\u8BD5\uFF0C\u8BF7\u521B\u5EFA\u65B0\u7684\u63D0\u8BAE");
      }
      if (proposal.status === "running") return executionError(proposal, "\u8BE5\u63D0\u8BAE\u6B63\u5728\u6267\u884C\uFF0C\u8BF7\u52FF\u91CD\u590D\u63D0\u4EA4");
      if (!shell) return executionError(proposal, "shell \u670D\u52A1\u4E0D\u53EF\u7528");
      proposal.status = "running";
      proposal.startedAt = Date.now();
      if (typeof persistStatus === "function") await persistStatus();
      const { ok, stepsResult } = await executeProposalSteps(shell, proposal, signal, policy);
      proposal.status = ok ? "succeeded" : "failed";
      proposal.finishedAt = Date.now();
      const last = proposal.steps[proposal.steps.length - 1];
      const failedStep = proposal.steps.find((step) => step.result?.ok === false);
      const lastResult = failedStep ? failedStep.result : last?.result;
      const diagnostics = ok ? "" : await captureDiagnostics(shell, proposal.workdir);
      const error = ok ? "" : redactSecrets(lastResult && (lastResult.stderr || lastResult.stdout) || "git \u9000\u51FA\u7801 " + (lastResult ? lastResult.exitCode : -1));
      const failure = ok ? void 0 : {
        source: "proposal",
        code: lastResult?.timedOut === true ? "TIMEOUT" : "GIT_FAILED",
        action: "execute",
        command: failedStep?.command || proposal.command,
        message: error,
        stdout: redactSecrets(lastResult ? lastResult.stdout : ""),
        stderr: redactSecrets(lastResult ? lastResult.stderr : ""),
        diagnostics,
        exitCode: lastResult ? lastResult.exitCode : null,
        timedOut: lastResult?.timedOut === true,
        mayHavePartialChanges: proposal.steps.some((step) => step !== failedStep && step.result?.ok === true),
        occurredAt: Date.now()
      };
      proposal.failure = failure;
      const recovery = ok ? null : buildRecovery(proposal, failedStep, diagnostics);
      if (recovery && recovery.command && failure) {
        const corrected = registerRecoveryProposal(proposal, recovery, failure);
        if (corrected) recovery.proposalId = corrected.proposalId;
      } else if (!ok && failure) {
        proposal.needsAgentAnalysis = true;
      }
      if (typeof persistStatus === "function") await persistStatus();
      return {
        ok,
        proposalId: proposal.proposalId,
        command: proposal.command,
        steps: stepsResult,
        exitCode: lastResult ? lastResult.exitCode : -1,
        signal: lastResult ? lastResult.signal : "",
        timedOut: lastResult ? lastResult.timedOut : false,
        stdout: redactSecrets(lastResult ? lastResult.stdout : ""),
        stderr: redactSecrets(lastResult ? lastResult.stderr : ""),
        diagnostics,
        ...failure ? { failure } : {},
        recovery: recovery ? { suggestion: recovery.suggestion, command: recovery.command || "", proposalId: recovery.proposalId || null } : null,
        ...!ok && failure && !recovery?.command ? { analysis: { proposalId: proposal.proposalId } } : {},
        error
      };
    }
    function buildRecovery(_proposal, failedStep, diagnostics) {
      if (!failedStep || !failedStep.result) return null;
      const cmd = String(failedStep.command || "");
      const text = String(((failedStep.result.stderr || "") + " " + (failedStep.result.stdout || "") + " " + (diagnostics || "")).trim());
      return buildRecoveryForCommand(cmd, text);
    }
    function buildRecoveryForCommand(cmd, text, reason = "") {
      if (/只读文件系统|read-only file system|EROFS|cannot lock ref|cannot create .*\.lock/i.test(text)) {
        return { suggestion: "\u6267\u884C\u73AF\u5883\u5BF9\u76EE\u6807\u76EE\u5F55\u53EA\u8BFB\uFF08\u6C99\u7BB1\u7B56\u7565\u6216\u6302\u8F7D\u95EE\u9898\uFF09\uFF1A\u8BF7\u5728\u7EC8\u7AEF\u624B\u52A8\u6267\u884C\u8BE5\u547D\u4EE4\uFF0C\u6216\u8C03\u6574\u6267\u884C\u73AF\u5883\u7684\u6C99\u7BB1\u6743\u9650\u3002", command: null };
      }
      if (/(\.gitignore|被忽略|ignored by your|did not match any files|没有匹配任何文件)/i.test(text) && /git\s+add\b/.test(cmd)) {
        const corrected = cmd.replace(/git\s+add\s+/, "git add -f ");
        if (corrected !== cmd) return { suggestion: "\u76EE\u6807\u6587\u4EF6\u88AB .gitignore \u5FFD\u7565\uFF1A\u6539\u7528 -f \u5F3A\u5236\u52A0\u5165\uFF08\u4EC5\u9488\u5BF9\u660E\u786E\u5217\u51FA\u7684\u6587\u4EF6\uFF09\u3002", command: corrected };
      }
      if (reason === "BRANCH_EXISTS" || /already exist(?:s)?|分支.*已(?:经)?存在/i.test(text)) {
        const parsed = parseCommand(cmd);
        const createFlag = parsed.ok ? parsed.args.findIndex((argument) => argument === "-c" || argument === "-b") : -1;
        const branch = parsed.ok && createFlag >= 2 ? parsed.args[createFlag + 1] : void 0;
        if (branch) {
          const corrected = "git switch " + quoteShellArg(branch);
          return { suggestion: "\u5206\u652F " + branch + " \u5DF2\u5B58\u5728\uFF1A\u6539\u4E3A\u5207\u6362\u5230\u73B0\u6709\u5206\u652F\uFF08\u6216\u6362\u4E00\u4E2A\u5206\u652F\u540D\uFF09\u3002", command: corrected };
        }
      }
      if (/not a git repository|不是.*git 仓库|不是一个 git 仓库/i.test(text)) {
        return { suggestion: "\u76EE\u6807\u76EE\u5F55\u4E0D\u662F git \u4ED3\u5E93\uFF1A\u786E\u8BA4 workdir \u6307\u5411\u4ED3\u5E93\u6839\u76EE\u5F55\uFF0C\u6216\u5148 git init\u3002", command: null };
      }
      if (/Bad owner or permissions|Could not resolve hostname|Permission denied \(publickey\)|ssh:|Connection (refused|timed out)/i.test(text)) {
        return { suggestion: "SSH/\u8FDC\u7A0B\u8FDE\u63A5\u5931\u8D25\uFF1A\u68C0\u67E5 ssh \u914D\u7F6E\u4E0E\u5BC6\u94A5\uFF08\u914D\u7F6E\u6587\u4EF6\u6743\u9650\u3001\u5BC6\u94A5\u662F\u5426\u88AB\u6388\u6743\uFF09\uFF0C\u53EF\u4E34\u65F6\u7528 git -c core.sshCommand \u8986\u76D6 ssh \u53C2\u6570\u3002", command: null };
      }
      if (/(rejected|failed to push|non-fast-forward|远程.*拒绝|推送.*失败)/i.test(text) && /git\s+push\b/.test(cmd)) {
        return { suggestion: "\u63A8\u9001\u88AB\u62D2\u7EDD\uFF1A\u5148 git pull --rebase \u540C\u6B65\u8FDC\u7A0B\u518D\u91CD\u8BD5\uFF1B\u82E5\u786E\u8BA4\u8981\u8986\u76D6\u8FDC\u7A0B\u5386\u53F2\uFF0C\u9700\u660E\u786E\u786E\u8BA4\u540E\u4F7F\u7528 --force-with-lease\uFF08\u9AD8\u98CE\u9669\uFF09\u3002", command: null };
      }
      if (/(nothing to commit|没有.*要提交|nothing added to commit)/i.test(text) && /git\s+commit\b/.test(cmd)) {
        return { suggestion: "\u6CA1\u6709\u53EF\u63D0\u4EA4\u7684\u6539\u52A8\uFF1A\u5148 git add \u6682\u5B58\u6587\u4EF6\uFF08\u6CE8\u610F\u88AB .gitignore \u5FFD\u7565\u7684\u6587\u4EF6\u9700 -f\uFF09\u3002", command: null };
      }
      if (/CONFLICT|冲突|conflict/i.test(text)) {
        return { suggestion: "\u5B58\u5728\u5408\u5E76\u51B2\u7A81\uFF1A\u5148\u89E3\u51B3\u51B2\u7A81\u6587\u4EF6\uFF0C\u518D git add \u6807\u8BB0\u4E3A\u5DF2\u89E3\u51B3\uFF0C\u6700\u540E git commit \u5B8C\u6210\u5408\u5E76\u3002", command: null };
      }
      if (/(No upstream|no upstream|没有上游|no tracking)/i.test(text)) {
        return { suggestion: "\u5206\u652F\u6CA1\u6709\u4E0A\u6E38\u8DDF\u8E2A\uFF1A\u7528 git push -u origin <\u5206\u652F\u540D> \u5EFA\u7ACB\u8DDF\u8E2A\u540E\u91CD\u8BD5\u3002", command: null };
      }
      return null;
    }
    async function recoverFailedCommand(activeShell, sessionId, workdir, operationId, action, command, message, errorOutput, errorCode, reason) {
      const operationKey = workdir + "\0" + operationId;
      const existing = proposalService.list(sessionId)?.find((proposal2) => proposal2.recoveryOperationKey === operationKey);
      if (existing) {
        if (!existing.failure) return null;
        if (existing.needsAgentAnalysis === true) return { failure: existing.failure, analysis: { proposalId: existing.proposalId } };
        if (existing.closed || existing.status !== "pending") return { failure: existing.failure };
        return { failure: existing.failure, recovery: {
          suggestion: String(existing.recoverySuggestion || existing.explanation),
          command: existing.command,
          proposalId: existing.proposalId
        } };
      }
      const diagnostics = await captureDiagnostics(activeShell, workdir);
      const failure = {
        source: "workbench",
        code: errorCode,
        action,
        command,
        message,
        stdout: "",
        stderr: redactSecrets(errorOutput),
        diagnostics,
        exitCode: null,
        timedOut: errorCode === "TIMEOUT",
        mayHavePartialChanges: reason !== "BRANCH_EXISTS",
        occurredAt: Date.now()
      };
      const recovery = buildRecoveryForCommand(command, message + "\n" + errorOutput + "\n" + diagnostics, reason);
      if (!recovery?.command) {
        const failed = registerFailureProposal(sessionId, workdir, command, failure);
        if (failed) {
          failed.recoveryOperationKey = operationKey;
          await proposalService.flush(sessionId);
        }
        return { failure, ...failed ? { analysis: { proposalId: failed.proposalId } } : {} };
      }
      const proposal = registerRecoveryProposal({ sessionId, workdir }, recovery, failure);
      if (!proposal) return { failure };
      proposal.recoveryOperationKey = operationKey;
      proposal.recoverySuggestion = recovery.suggestion;
      await proposalService.flush(sessionId);
      return { failure, recovery: { suggestion: recovery.suggestion, command: recovery.command, proposalId: proposal.proposalId } };
    }
    function registerRecoveryProposal(failedProposal, recovery, failure) {
      if (!recovery.command) return null;
      const v = validateCommand(recovery.command);
      if (!v.ok) return null;
      const sessionId = failedProposal.sessionId;
      const prev = proposalService.list(sessionId);
      if (prev && prev.some((p) => p.status === "running")) return null;
      const risk = classifyRisk(recovery.command);
      const proposal = {
        proposalId: proposalService.newId(),
        sessionId,
        intent: "\u4FEE\u6B63\u5EFA\u8BAE\uFF1A" + recovery.suggestion,
        command: recovery.command.trim(),
        steps: [{ command: recovery.command.trim(), result: null }],
        explanation: failure ? "\u539F\u547D\u4EE4\uFF1A" + failure.command + "\n\u9519\u8BEF\uFF1A" + (failure.stderr || failure.message) + "\n\u4FEE\u6B63\u539F\u56E0\uFF1A" + recovery.suggestion : recovery.suggestion + "\uFF08\u7531\u6267\u884C\u5931\u8D25\u81EA\u52A8\u751F\u6210\uFF0C\u8BF7\u786E\u8BA4\u540E\u6267\u884C\uFF09",
        risk: risk.level,
        reasons: risk.reasons,
        confirmed: false,
        workdir: failedProposal.workdir,
        createdAt: Date.now(),
        result: null,
        closed: false,
        copied: false,
        fingerprint: null,
        verified: false,
        status: "pending",
        recovery: true,
        recoverySuggestion: recovery.suggestion,
        ...failure ? { failure } : {}
      };
      proposalService.closeOpen(sessionId);
      storeProposal(sessionId, proposal);
      console.log("easygit \u4FEE\u6B63\u5EFA\u8BAE\u767B\u8BB0", proposal.proposalId, "session=", sessionId, "risk=", risk.level);
      return proposal;
    }
    function registerFailureProposal(sessionId, workdir, command, failure) {
      if (proposalService.hasRunning(sessionId)) return null;
      const risk = classifyRisk(command);
      const proposal = {
        proposalId: proposalService.newId(),
        sessionId,
        intent: "Git \u64CD\u4F5C\u5931\u8D25\uFF0C\u7B49\u5F85\u5206\u6790",
        command,
        steps: [{ command, result: { ok: false, stderr: failure.stderr, stdout: failure.stdout, exitCode: failure.exitCode } }],
        explanation: "\u539F\u547D\u4EE4\uFF1A" + command + "\n\u9519\u8BEF\uFF1A" + (failure.stderr || failure.message),
        risk: risk.level,
        reasons: risk.reasons,
        confirmed: false,
        workdir,
        createdAt: failure.occurredAt,
        result: { ok: false, error: failure.message },
        closed: false,
        copied: false,
        fingerprint: null,
        verified: false,
        status: "failed",
        failure,
        recovery: true,
        needsAgentAnalysis: true
      };
      proposalService.closeOpen(sessionId);
      storeProposal(sessionId, proposal);
      console.log("easygit \u5931\u8D25\u4E0A\u4E0B\u6587\u767B\u8BB0", proposal.proposalId, "session=", sessionId);
      return proposal;
    }
    function storeProposal(sessionId, proposal) {
      return proposalService.store(sessionId, proposal);
    }
    function findProposal(sessionId, proposalId) {
      return proposalService.find(sessionId, proposalId);
    }
    function proposalView(proposal) {
      return proposalService.view(proposal);
    }
    function latestPending(sessionId) {
      return proposalService.latestPending(sessionId);
    }
    function connectProposalStorage(ctx) {
      let storage;
      try {
        storage = ctx.get("storage");
      } catch (error) {
        storage = null;
      }
      if (!storage || !storage.backend || typeof storage.backend.get !== "function") return Promise.resolve();
      let unit;
      const ready = (async () => {
        const backend = storage.backend.get("json");
        if (!backend || !backend.kv || typeof backend.kv.open !== "function") throw new Error("JSON storage backend does not support key-value units");
        unit = await backend.kv.open({
          name: "easygit_proposals",
          version: 1,
          tables: ["proposals"],
          hasGlobal: false
        });
        await proposalService.attachStorage(unit);
      })();
      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => ready.then(() => unit ? proposalService.closeStorage(unit) : void 0));
      }
      return ready;
    }
    var plugin2 = {
      name: "easygit",
      inject: ["shell", "tools"],
      apply(ctx) {
        const shell = ctx.get("shell");
        const tools = ctx.get("tools");
        const sandboxPolicy = ctx.get("sandboxPolicy");
        const repository = new GitRepositoryService(shell ?? void 0);
        const proposalStorageReady = connectProposalStorage(ctx);
        if (tools) {
          tools.register({
            name: "git_propose",
            description: '\u5F53\u7528\u6237\u7528\u81EA\u7136\u8BED\u8A00\u63CF\u8FF0\u4E00\u4E2A\u60F3\u505A\u7684 git \u64CD\u4F5C\uFF08\u4F46\u4E0D\u77E5\u9053/\u4E0D\u786E\u5B9A\u5177\u4F53\u547D\u4EE4\uFF09\u65F6\uFF0C\u8C03\u7528\u672C\u5DE5\u5177\u63D0\u51FA\u547D\u4EE4\u5EFA\u8BAE\u5E76\u767B\u8BB0\u4E3A\u5F85\u5904\u7406\u63D0\u8BAE\u3002\u53EF\u5148\u8C03\u7528 git_repo_state \u4E86\u89E3\u4ED3\u5E93\u73B0\u72B6\uFF0C\u518D\u9009\u62E9\u6700\u7B80\u6D01\u3001\u6700\u5B89\u5168\u3001\u526F\u4F5C\u7528\u6700\u5C0F\u7684\u7EAF git \u547D\u4EE4\u5E76\u7ED9\u51FA\u6E05\u6670\u4E2D\u6587\u89E3\u91CA\u3002\u5206\u652F\u521B\u5EFA\u6216\u5207\u6362\u5FC5\u987B\u4F18\u5148\u4F7F\u7528 git switch\uFF0C\u6587\u4EF6\u8FD8\u539F\u5FC5\u987B\u4F18\u5148\u4F7F\u7528 git restore\uFF1B\u9664\u975E\u6CA1\u6709\u73B0\u4EE3\u7B49\u4EF7\u547D\u4EE4\uFF0C\u5426\u5219\u4E0D\u8981\u4F7F\u7528\u8BED\u4E49\u542B\u6DF7\u7684 git checkout\u3002\u591A\u6761\u547D\u4EE4\u8BF7\u7528 steps \u6570\u7EC4\u5206\u5F00\u4F20\u5165\uFF08\u5982 ["git add -A", "git commit -m \\"msg\\""]\uFF09\uFF0C\u4E0D\u8981\u7528 && \u62FC\u6210\u4E00\u6761\uFF1B\u63D2\u4EF6\u4F1A\u9010\u6B65\u6267\u884C\u3001\u9010\u6B65\u6821\u9A8C\u3001\u5931\u8D25\u5373\u505C\u3002\u767B\u8BB0\u6210\u529F\u540E\u672C\u8F6E Agent \u4F1A\u7ED3\u675F\uFF0CGit \u5DE5\u4F5C\u53F0\u5C06\u5C55\u793A\u63D0\u8BAE\uFF1B\u6A21\u578B\u4E0D\u5F97\u8BE2\u95EE\u662F\u5426\u6267\u884C\uFF0C\u4E5F\u4E0D\u80FD\u6267\u884C\u63D0\u8BAE\u3002\u9AD8\u98CE\u9669\u63D0\u8BAE\u7684\u660E\u786E\u98CE\u9669\u786E\u8BA4\u7531\u5DE5\u4F5C\u53F0\u4E2D\u7684\u7528\u6237\u64CD\u4F5C\u5B8C\u6210\u3002',
            parameters: {
              type: "object",
              properties: {
                intent: { type: "string", maxLength: 500, description: "\u7528\u6237\u60F3\u8981\u5B8C\u6210\u7684 git \u64CD\u4F5C\u610F\u56FE\uFF08\u81EA\u7136\u8BED\u8A00\uFF0C\u7B80\u77ED\u63CF\u8FF0\uFF09" },
                command: { type: "string", maxLength: 800, description: "\u5355\u6761 git \u547D\u4EE4\uFF08steps \u4E3A\u7A7A\u65F6\u5FC5\u586B\uFF09\u3002\u521B\u5EFA/\u5207\u6362\u5206\u652F\u4F7F\u7528 switch\uFF0C\u8FD8\u539F\u6587\u4EF6\u4F7F\u7528 restore\uFF1B\u53EA\u5141\u8BB8\u56FA\u5B9A\u767D\u540D\u5355\u5185\u7684\u7EAF git \u5B50\u547D\u4EE4\uFF0C\u4E0D\u5141\u8BB8\u5168\u5C40\u9009\u9879\u3001\u7BA1\u9053\u3001\u91CD\u5B9A\u5411\u6216 shell \u5C55\u5F00" },
                steps: { type: "array", maxItems: MAX_STEPS, items: { type: "string", maxLength: 800 }, description: "\u591A\u6761 git \u547D\u4EE4\u6309\u6267\u884C\u987A\u5E8F\u5206\u5F00\u4F20\u5165\uFF08\u63A8\u8350\uFF0C\u4EE3\u66FF && \u62FC\u63A5\uFF09\uFF1B\u4F18\u5148\u4F7F\u7528 switch/restore \u7B49\u804C\u8D23\u660E\u786E\u7684\u73B0\u4EE3\u547D\u4EE4\uFF0C\u6BCF\u6761\u5355\u72EC\u6821\u9A8C\u3001\u9010\u6B65\u6267\u884C\u3001\u5931\u8D25\u5373\u505C" },
                explanation: { type: "string", maxLength: 4e3, description: "\u4E3A\u4EC0\u4E48\u7528\u8FD9\u4E9B\u547D\u4EE4\uFF1A\u5B83\u4EEC\u505A\u4EC0\u4E48\u3001\u4E3A\u4EC0\u4E48\u6700\u7B80\u6D01\u5B89\u5168\u3001\u6709\u4EC0\u4E48\u526F\u4F5C\u7528" },
                workdir: { type: "string", maxLength: 4096, description: "git \u4ED3\u5E93\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF09\u3002\u7701\u7565\u65F6\u4F7F\u7528\u5F53\u524D\u4F1A\u8BDD\u7684\u5DE5\u4F5C\u76EE\u5F55" }
              },
              required: ["intent", "explanation"]
            },
            output: {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  proposalId: { type: "string" },
                  intent: { type: "string" },
                  command: { type: "string" },
                  steps: { type: "array", items: { type: "object", properties: { command: { type: "string" } }, additionalProperties: false } },
                  explanation: { type: "string" },
                  risk: { type: "string", enum: ["safe", "normal", "hard"] },
                  reasons: { type: "array", items: { type: "string" } },
                  workdir: { type: "string" },
                  error: { type: "string" }
                },
                additionalProperties: false
              },
              render(_args, value) {
                return [{ type: "text", text: JSON.stringify(value, null, 2) }];
              }
            },
            async execute(args, exec) {
              await proposalStorageReady;
              const sessionId = sessionIdOf(exec);
              if (!sessionId) {
                return { ok: false, proposalId: "", intent: String(args && args.intent || ""), command: "", steps: [], explanation: String(args && args.explanation || ""), risk: "normal", reasons: [], workdir: "", error: "\u5F53\u524D\u5DE5\u5177\u8C03\u7528\u7F3A\u5C11\u4F1A\u8BDD\u8EAB\u4EFD\uFF0C\u62D2\u7EDD\u521B\u5EFA\u65E0\u6CD5\u9694\u79BB\u7684\u63D0\u8BAE" };
              }
              args = args || {};
              if (String(args.intent || "").length > 500 || String(args.explanation || "").length > 4e3 || String(args.workdir || "").length > 4096) {
                return { ok: false, proposalId: "", intent: "", command: "", steps: [], explanation: "", risk: "normal", reasons: [], workdir: "", error: "\u8F93\u5165\u8FC7\u957F\uFF1Aintent \u6700\u591A 500 \u5B57\u7B26\u3001explanation \u6700\u591A 4000 \u5B57\u7B26\u3001workdir \u6700\u591A 4096 \u5B57\u7B26" };
              }
              const workdir = sessionWorkdir(exec, args, ctx);
              const rawCommands = Array.isArray(args.steps) && args.steps.length ? args.steps : args.command ? [args.command] : [];
              if (rawCommands.length === 0) {
                return { ok: false, proposalId: "", intent: String(args.intent || ""), command: "", steps: [], explanation: String(args.explanation || ""), risk: "normal", reasons: [], workdir: workdir || "", error: "command \u6216 steps \u81F3\u5C11\u63D0\u4F9B\u4E00\u4E2A" };
              }
              if (rawCommands.length > MAX_STEPS) {
                return { ok: false, proposalId: "", intent: String(args.intent || ""), command: "", steps: [], explanation: String(args.explanation || ""), risk: "normal", reasons: [], workdir: workdir || "", error: "\u6B65\u9AA4\u8FC7\u591A\uFF08\u6700\u591A " + MAX_STEPS + " \u6B65\uFF09" };
              }
              const steps = [];
              for (const raw of rawCommands) {
                const modern = modernizeCommand(raw);
                const v = validateCommand(modern.command);
                if (!v.ok) {
                  return { ok: false, proposalId: "", intent: String(args.intent || ""), command: String(raw), steps: [], explanation: String(args.explanation || ""), risk: "normal", reasons: [], workdir: workdir || "", error: "\u6B65\u9AA4\u300C" + raw + "\u300D\u6821\u9A8C\u5931\u8D25\uFF1A" + v.error };
                }
                if (v.subcommand === "checkout") {
                  return { ok: false, proposalId: "", intent: String(args.intent || ""), command: String(raw), steps: [], explanation: String(args.explanation || ""), risk: "normal", reasons: [], workdir: workdir || "", error: "\u6B65\u9AA4\u300C" + raw + "\u300D\u4ECD\u4F7F\u7528\u8BED\u4E49\u542B\u6DF7\u7684 git checkout\uFF1B\u5207\u6362\u5206\u652F\u8BF7\u6539\u7528 git switch\uFF0C\u8FD8\u539F\u6587\u4EF6\u8BF7\u6539\u7528 git restore" };
                }
                steps.push({ command: modern.command, result: null });
              }
              if (steps.length === 0) {
                return { ok: false, proposalId: "", intent: String(args.intent || ""), command: "", steps: [], explanation: String(args.explanation || ""), risk: "normal", reasons: [], workdir: workdir || "", error: "\u6CA1\u6709\u53EF\u6267\u884C\u7684\u547D\u4EE4\u6B65\u9AA4" };
              }
              if (shell) {
                const r = await runGit(shell, workdir, "git rev-parse --show-toplevel", 15e3, 4096, exec.signal);
                if (r.exitCode !== 0) {
                  const errText = ((r.stderr?.text ?? "") + " " + (r.stdout?.text ?? "")).trim();
                  return { ok: false, proposalId: "", intent: String(args.intent || ""), command: steps.map((s) => s.command).join(" && "), steps: steps.map((s) => ({ command: s.command })), explanation: String(args.explanation || ""), risk: "normal", reasons: [], workdir: workdir || "", error: "\u76EE\u6807\u76EE\u5F55\u4E0D\u662F git \u4ED3\u5E93\uFF08workdir=" + (workdir || "\u9ED8\u8BA4\u5DE5\u4F5C\u76EE\u5F55") + "\uFF09\uFF1A" + errText.slice(0, 200) };
                }
              }
              const commandTexts = steps.map((s) => s.command);
              const risk = classifyStepsRisk(commandTexts);
              const prev = proposalService.list(sessionId);
              if (prev && prev.some((proposal2) => proposal2.status === "running")) {
                return { ok: false, proposalId: "", intent: String(args.intent || ""), command: "", steps: [], explanation: String(args.explanation || ""), risk: risk.level, reasons: risk.reasons, workdir: workdir || "", error: "\u540C\u4E00\u4F1A\u8BDD\u5DF2\u6709\u63D0\u8BAE\u6B63\u5728\u6267\u884C\uFF0C\u8BF7\u7B49\u5F85\u6267\u884C\u7ED3\u675F\u540E\u518D\u521B\u5EFA\u65B0\u63D0\u8BAE" };
              }
              const analysisSource = prev?.find((candidate) => !candidate.closed && candidate.needsAgentAnalysis === true && typeof candidate.analysisRequestedAt === "number" && !!candidate.failure);
              proposalService.closeOpen(sessionId);
              const proposal = {
                proposalId: proposalService.newId(),
                sessionId,
                intent: String(args.intent || ""),
                command: commandTexts.join(" && "),
                steps,
                explanation: String(args.explanation || ""),
                risk: risk.level,
                reasons: risk.reasons,
                confirmed: false,
                workdir: workdir || "",
                createdAt: Date.now(),
                result: null,
                closed: false,
                copied: false,
                fingerprint: null,
                verified: false,
                status: "pending",
                ...analysisSource?.failure ? {
                  failure: analysisSource.failure,
                  recovery: true,
                  recoverySuggestion: String(args.explanation || ""),
                  analyzedFailureProposalId: analysisSource.proposalId
                } : {}
              };
              storeProposal(sessionId, proposal);
              await proposalService.flush(sessionId);
              if (typeof exec.concludeTurn === "function") exec.concludeTurn();
              console.log("git_propose \u767B\u8BB0", proposal.proposalId, "session=", sessionId, "risk=", risk.level, "steps=", steps.length);
              return { ok: true, proposalId: proposal.proposalId, intent: proposal.intent, command: proposal.command, steps: steps.map((s) => ({ command: s.command })), explanation: proposal.explanation, risk: risk.level, reasons: risk.reasons, workdir: proposal.workdir, error: "" };
            }
          });
          tools.register({
            name: "git_repo_state",
            description: "\u8BFB\u53D6\u5F53\u524D git \u4ED3\u5E93\u7684\u53EA\u8BFB\u72B6\u6001\uFF08\u9876\u5C42\u76EE\u5F55\u3001\u5F53\u524D\u5206\u652F\u3001\u5DE5\u4F5C\u533A\u72B6\u6001\u3001\u6700\u8FD1\u63D0\u4EA4\u3001stash\u3001\u8FDC\u7A0B\uFF09\uFF0C\u7528\u4E8E\u5728\u63D0\u51FA\u547D\u4EE4\u5EFA\u8BAE\u524D\u4E86\u89E3\u4ED3\u5E93\u73B0\u72B6\u3002\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u4E1C\u897F\u3002",
            parameters: {
              type: "object",
              properties: {
                workdir: { type: "string", description: "git \u4ED3\u5E93\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF09\u3002\u7701\u7565\u65F6\u4F7F\u7528\u5F53\u524D\u4F1A\u8BDD\u7684\u5DE5\u4F5C\u76EE\u5F55" }
              }
            },
            output: {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  isRepo: { type: "boolean" },
                  workdir: { type: "string" },
                  topLevel: { type: "string" },
                  branch: { type: "string" },
                  status: { type: "string" },
                  recentCommits: { type: "string" },
                  stashes: { type: "string" },
                  remotes: { type: "string" },
                  error: { type: "string" }
                },
                additionalProperties: false
              },
              render(_args, value) {
                return [{ type: "text", text: JSON.stringify(value, null, 2) }];
              }
            },
            async execute(args, exec) {
              const workdir = sessionWorkdir(exec, args, ctx);
              if (!shell) return { ok: false, isRepo: false, workdir: workdir || "", topLevel: "", branch: "", status: "", recentCommits: "", stashes: "", remotes: "", error: "shell \u670D\u52A1\u4E0D\u53EF\u7528" };
              const command = "echo '__TOP__'; git rev-parse --show-toplevel 2>&1; echo '__BRANCH__'; git branch --show-current 2>&1; echo '__STATUS__'; git status --short --branch 2>&1; echo '__LOG__'; git log --oneline -8 2>&1; echo '__STASH__'; git stash list 2>&1; echo '__REMOTE__'; git remote -v 2>&1";
              const r = await runGit(shell, workdir, command, 2e4, 3e4, exec.signal);
              const text = (r.stdout?.text ?? "") + (r.stderr?.text ?? "");
              const keys = ["__TOP__", "__BRANCH__", "__STATUS__", "__LOG__", "__STASH__", "__REMOTE__"];
              const parts = {};
              let idx = 0;
              for (const [k, key] of keys.entries()) {
                const start = text.indexOf(key, idx);
                if (start < 0) {
                  parts[key] = "";
                  continue;
                }
                const valueStart = start + key.length;
                const nextKey = keys[k + 1];
                const end = nextKey ? text.indexOf(nextKey, valueStart) : text.length;
                parts[key] = end < 0 ? text.slice(valueStart) : text.slice(valueStart, end);
                idx = end < 0 ? text.length : end;
              }
              const top = (parts.__TOP__ ?? "").trim();
              const isRepo = /^\/|^[A-Za-z]:[\\/]/.test(top);
              return {
                ok: true,
                isRepo,
                workdir: workdir || "",
                topLevel: top,
                branch: redactAndLimit((parts.__BRANCH__ ?? "").trim(), 4096),
                status: redactAndLimit((parts.__STATUS__ ?? "").trim()),
                recentCommits: redactAndLimit((parts.__LOG__ ?? "").trim()),
                stashes: redactAndLimit((parts.__STASH__ ?? "").trim()),
                remotes: redactAndLimit((parts.__REMOTE__ ?? "").trim()),
                error: ""
              };
            }
          });
        }
        const registerWebServer = (webServer, connection) => registerEasyGitActions(webServer, {
          repository,
          proposalStorageReady,
          shell,
          repositoryContext: (sessionId) => repositoryContextForSession(ctx, sandboxPolicy, sessionId),
          latestPending,
          findProposal,
          proposalView,
          flushProposal: (sessionId) => proposalService.flush(sessionId),
          captureFingerprint,
          runChecks,
          verifyProposal,
          executeProposal: (activeShell, proposal, policy, persist) => executeRegisteredProposal(activeShell, proposal, void 0, policy, persist),
          recoverFailedCommand: (sessionId, workdir, operationId, action, command, message, errorOutput, errorCode, reason) => recoverFailedCommand(
            shell,
            sessionId,
            workdir,
            operationId,
            action,
            command,
            message,
            errorOutput,
            errorCode,
            reason
          ),
          resolveExecutionPolicy: async (sessionId) => {
            const context = await repositoryContextForSession(ctx, sandboxPolicy, sessionId);
            if (!context) throw new Error("\u65E0\u6CD5\u786E\u5B9A\u5F53\u524D\u4F1A\u8BDD\u7684\u4ED3\u5E93\u76EE\u5F55");
            return context.policy;
          }
        }, connection);
        if (typeof ctx.inject === "function") {
          ctx.inject(["webServer", "connection"], (webCtx) => registerWebServer(webCtx.get("webServer"), webCtx.get("connection")));
        } else {
          registerWebServer(ctx.get("webServer"), ctx.get("connection"));
        }
      }
    };
    var helpers = {
      parseCommand,
      validateCommand,
      modernizeCommand,
      classifyRisk,
      classifyStepsRisk,
      quoteShellArg,
      redactSecrets,
      redactAndLimit,
      addPathsOf,
      deriveChecks,
      runChecks,
      verifyProposal,
      captureFingerprint,
      captureDiagnostics,
      executeProposalSteps,
      executeRegisteredProposal,
      buildRecovery,
      buildRecoveryForCommand,
      recoverFailedCommand,
      registerRecoveryProposal,
      storeProposal,
      findProposal,
      proposalView,
      latestPending,
      ProposalService,
      GitRepositoryService
    };
    module2.exports = Object.assign(plugin2, { helpers });
  }
});

// src/host/index.ts
var plugin = require_plugin();
module.exports = plugin;
