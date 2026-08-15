window.__ModuleLoader__.load({ id: "dsh-easygit-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";

// src/client/panel-controller.ts
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function markWorkbenchOpen(open) {
  if (typeof document === "undefined" || !document.documentElement) return;
  if (open) document.documentElement.setAttribute("data-easygit-workbench-open", "");
  else document.documentElement.removeAttribute("data-easygit-workbench-open");
}
function createPanelController(options) {
  const slots = options.slots;
  const layout = options.layout;
  const renderPanel = options.renderPanel;
  const listeners = /* @__PURE__ */ new Set();
  let detailsReady = false;
  let activeSessionId = null;
  let disposePanel = null;
  let error = "";
  const snapshot = () => ({
    detailsReady,
    activeSessionId,
    open: activeSessionId !== null && disposePanel !== null,
    error
  });
  const notify = () => {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  };
  const close = (sessionId) => {
    if (sessionId !== void 0 && sessionId !== null && activeSessionId !== String(sessionId)) return false;
    const dispose = disposePanel;
    const wasOpen = activeSessionId !== null || typeof dispose === "function";
    activeSessionId = null;
    disposePanel = null;
    markWorkbenchOpen(false);
    if (typeof dispose === "function") {
      try {
        dispose();
      } catch (caught) {
        error = errorText(caught);
      }
    }
    if (wasOpen && layout && typeof layout.closeDetails === "function") {
      try {
        layout.closeDetails();
      } catch (caught) {
        error = errorText(caught);
      }
    }
    notify();
    return wasOpen;
  };
  const open = (sessionId) => {
    const targetSessionId = String(sessionId || "");
    if (!targetSessionId) {
      error = "\u5F53\u524D\u4F1A\u8BDD\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u6253\u5F00 Git \u5DE5\u4F5C\u53F0";
      notify();
      return false;
    }
    if (!detailsReady || !slots || typeof slots.register !== "function") {
      error = "\u5F53\u524D Harness \u5C1A\u672A\u63D0\u4F9B\u53F3\u4FA7\u8BE6\u60C5\u680F\uFF0C\u65E0\u6CD5\u6253\u5F00 Git \u5DE5\u4F5C\u53F0";
      notify();
      return false;
    }
    if (!layout || typeof layout.openDetails !== "function" || typeof layout.closeDetails !== "function") {
      error = "\u5F53\u524D Harness \u4E0D\u652F\u6301\u8BE6\u60C5\u680F\u5F00\u5173\uFF0C\u65E0\u6CD5\u6253\u5F00 Git \u5DE5\u4F5C\u53F0";
      notify();
      return false;
    }
    if (activeSessionId === targetSessionId && typeof disposePanel === "function") {
      try {
        layout.openDetails();
        error = "";
      } catch (caught) {
        error = errorText(caught);
      }
      notify();
      return error === "";
    }
    if (activeSessionId !== null || typeof disposePanel === "function") close();
    let dispose = null;
    try {
      layout.openDetails();
      dispose = slots.register(
        { name: "details", priority: -10 },
        (props) => {
          const currentSessionId = String(props.sessionId || "");
          if (currentSessionId !== targetSessionId || activeSessionId !== targetSessionId) return null;
          return renderPanel({ sessionId: currentSessionId, close: () => close(currentSessionId) });
        }
      );
      if (typeof dispose !== "function") throw new Error("details \u63D2\u69FD\u672A\u8FD4\u56DE\u53EF\u91CA\u653E\u7684\u6CE8\u518C\u53E5\u67C4");
      activeSessionId = targetSessionId;
      disposePanel = dispose;
      markWorkbenchOpen(true);
      error = "";
      notify();
      return true;
    } catch (caught) {
      if (typeof dispose === "function") {
        try {
          dispose();
        } catch (disposeError) {
        }
      }
      activeSessionId = null;
      disposePanel = null;
      markWorkbenchOpen(false);
      try {
        layout.closeDetails();
      } catch (closeError) {
      }
      error = errorText(caught);
      notify();
      return false;
    }
  };
  return {
    attachDetails() {
      detailsReady = true;
      error = "";
      notify();
      return () => {
        detailsReady = false;
        close();
      };
    },
    open,
    close,
    toggle(sessionId) {
      return activeSessionId === String(sessionId || "") ? close(sessionId) : open(sessionId);
    },
    isOpen(sessionId) {
      return activeSessionId === String(sessionId || "") && typeof disposePanel === "function";
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot
  };
}

// src/client/view-model.ts
var WORKBENCH_RATIO_KEY = "dsh-easygit-plugin:workbench-ratio";
var WORKBENCH_TRACK = "--dsh-easygit-plugin-workbench-width";
var WORKBENCH_DEFAULT_RATIO = 0.36;
var WORKBENCH_MIN_RATIO = 0.24;
var WORKBENCH_MAX_RATIO = 0.75;
function appendCommandLog(current, entry) {
  return [...current, entry].slice(-100);
}
function filterLocalBranches(branches, query) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return branches;
  return branches.filter((branch) => String(branch.name || "").toLocaleLowerCase().includes(normalized));
}
function isCurrentCommitRequest(selectedHash, requestedHash, currentSequence, requestSequence) {
  return selectedHash === requestedHash && currentSequence === requestSequence;
}
function nextCommitSelection(currentHash, requestedHash) {
  return currentHash === requestedHash ? "" : requestedHash;
}
function commitFileTone(status) {
  if (/^[AC]/.test(status)) return " added";
  if (/^D/.test(status)) return " deleted";
  return " modified";
}
function isLatestRequest(currentSequence, requestSequence) {
  return currentSequence === requestSequence;
}
function beginTrackedRequest(ref) {
  ref.current.controller?.abort();
  const controller = new AbortController();
  const sequence = ref.current.sequence + 1;
  ref.current = { controller, sequence };
  return { sequence, signal: controller.signal };
}
function cancelTrackedRequest(ref) {
  ref.current.controller?.abort();
  ref.current = { controller: null, sequence: ref.current.sequence + 1 };
}
function isTrackedRequestCurrent(ref, request) {
  return ref.current.sequence === request.sequence && !request.signal.aborted;
}
function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
function deriveCommitGraph(commits) {
  let lanes = [];
  return commits.map((commit) => {
    const hash = String(commit.hash || "");
    let lane = lanes.indexOf(hash);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(hash);
    }
    const before = [...lanes];
    const parents = Array.isArray(commit.parents) ? commit.parents.map(String).filter(Boolean) : [];
    let after = [...before];
    if (parents.length === 0) after.splice(lane, 1);
    else {
      after[lane] = parents[0];
      for (let index = 1; index < parents.length; index += 1) {
        const parent = parents[index];
        if (!after.includes(parent)) after.splice(lane + index, 0, parent);
      }
    }
    after = after.filter((value, index) => value && after.indexOf(value) === index);
    const edges = [];
    before.forEach((value, from) => {
      if (value === hash) {
        if (parents.length === 0) edges.push({ from, to: null, active: true });
        else parents.forEach((parent) => edges.push({ from, to: after.indexOf(parent), active: true }));
      } else {
        const to = after.indexOf(value);
        if (to >= 0) edges.push({ from, to, active: false });
      }
    });
    const row = { commit, lane, laneCount: Math.max(1, before.length, after.length), edges };
    lanes = after;
    return row;
  });
}
function clampWorkbenchRatio(value) {
  return Math.min(WORKBENCH_MAX_RATIO, Math.max(WORKBENCH_MIN_RATIO, value));
}
function readWorkbenchRatio() {
  if (typeof window === "undefined" || !window.localStorage) return WORKBENCH_DEFAULT_RATIO;
  try {
    const value = Number(window.localStorage.getItem(WORKBENCH_RATIO_KEY));
    return Number.isFinite(value) && value > 0 ? clampWorkbenchRatio(value) : WORKBENCH_DEFAULT_RATIO;
  } catch (error) {
    return WORKBENCH_DEFAULT_RATIO;
  }
}
function persistWorkbenchRatio(value) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    if (value === null) window.localStorage.removeItem(WORKBENCH_RATIO_KEY);
    else window.localStorage.setItem(WORKBENCH_RATIO_KEY, String(value));
  } catch (error) {
  }
}
function workbenchTrackForRatio(ratio) {
  return `${Number((ratio * 100).toFixed(2))}vw`;
}
function repositoryName(topLevel) {
  const normalized = String(topLevel || "").replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized || "Git \u4ED3\u5E93";
}
function displayShellArg(value) {
  return "'" + String(value ?? "").replace(/'/g, "'\\''") + "'";
}
function mutationCommand(action, payload = {}) {
  const paths = Array.isArray(payload.paths) ? payload.paths.map(displayShellArg).join(" ") : "";
  if (action === "stage-paths") return { label: "\u6682\u5B58\u6587\u4EF6", command: "git add -- " + paths };
  if (action === "unstage-paths") return { label: "\u53D6\u6D88\u6682\u5B58\u6587\u4EF6", command: "git reset HEAD -- " + paths };
  if (action === "stage-all") return { label: "\u5168\u90E8\u6682\u5B58", command: "git add -A" };
  if (action === "unstage-all") return { label: "\u53D6\u6D88\u5168\u90E8\u6682\u5B58", command: "git reset HEAD -- :/" };
  if (action === "commit") return { label: "\u63D0\u4EA4\u53D8\u66F4", command: "git commit -m " + displayShellArg(payload.message) };
  if (action === "create-branch") return { label: "\u65B0\u5EFA\u5206\u652F", command: "git switch -c " + displayShellArg(payload.name) + " " + displayShellArg(payload.base) };
  if (action === "switch-branch") return { label: "\u5207\u6362\u5206\u652F", command: "git switch " + displayShellArg(payload.name) };
  if (action === "delete-branch") return {
    label: payload.force ? "\u5F3A\u5236\u5220\u9664\u5206\u652F" : "\u5B89\u5168\u5220\u9664\u5206\u652F",
    command: "git branch " + (payload.force ? "-D" : "-d") + " -- " + displayShellArg(payload.name)
  };
  return null;
}
function viewportWidth() {
  return typeof window === "undefined" ? 0 : Math.max(1, window.innerWidth);
}
function sidebarTrackWidth(layout) {
  const rectWidth = layout.sidebar.getBoundingClientRect().width;
  if (rectWidth > 0) return rectWidth;
  const styleWidth = Number.parseFloat(window.getComputedStyle(layout.sidebar).width);
  return Number.isFinite(styleWidth) ? styleWidth : 0;
}
function findWorkbenchHostSplit(anchor) {
  if (typeof window === "undefined") return null;
  const detailsRoot = anchor.closest("[data-side='details']");
  let directChild = detailsRoot instanceof HTMLElement ? detailsRoot : anchor;
  for (let candidate = directChild.parentElement; candidate; candidate = candidate.parentElement) {
    if (window.getComputedStyle(candidate).display === "grid") {
      const children = Array.from(candidate.children).filter((child) => child instanceof HTMLElement);
      const detailsIndex = children.indexOf(directChild);
      const sidebar = children[0];
      const center = children[detailsIndex - 1];
      if (detailsIndex >= 2 && sidebar && center) return { frame: candidate, sidebar, center, details: directChild };
    }
    directChild = candidate;
  }
  return null;
}
function buildFileTree(files) {
  const root = { name: "", path: "", folders: [], files: [] };
  const folder = (parent, name) => {
    const existing = parent.folders.find((entry) => entry.name === name);
    if (existing) return existing;
    const created = { name, path: parent.path ? parent.path + "/" + name : name, folders: [], files: [] };
    parent.folders.push(created);
    return created;
  };
  for (const file of files) {
    const sourcePath = String(file.path || "");
    const directory = /[\\/]$/.test(sourcePath);
    const parts = sourcePath.split(String.fromCharCode(92)).join("/").split("/").filter(Boolean);
    if (!parts.length) continue;
    let current = root;
    const folderCount = directory ? parts.length : parts.length - 1;
    for (let index = 0; index < folderCount; index += 1) current = folder(current, parts[index]);
    if (!directory) current.files.push(file);
  }
  const sort = (node) => {
    node.folders.sort((left, right) => left.name.localeCompare(right.name));
    node.files.sort((left, right) => String(left.path || "").localeCompare(String(right.path || "")));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}
function parseReviewRows(diff) {
  const rows = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let previousOldNext = 1;
  let previousNewNext = 1;
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const newStart = Number(hunk[3]);
      const skipped = Math.max(oldStart - previousOldNext, newStart - previousNewNext);
      if (skipped > 0) rows.push({ kind: "skipped", oldNumber: null, newNumber: null, text: skipped + " \u884C\u672A\u4FEE\u6539\u5185\u5BB9\uFF08\u7531 Git \u7701\u7565\uFF09" });
      oldLine = oldStart;
      newLine = newStart;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.charCodeAt(0) === 92) {
      rows.push({ kind: "annotation", oldNumber: null, newNumber: null, text: line.slice(1).trim() || "\u6587\u4EF6\u672B\u5C3E\u6CA1\u6709\u6362\u884C\u7B26" });
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldNumber: oldLine, newNumber: newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
      previousOldNext = oldLine;
      previousNewNext = newLine;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "deleted", oldNumber: oldLine, newNumber: null, text: line.slice(1) });
      oldLine += 1;
      previousOldNext = oldLine;
      previousNewNext = newLine;
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "added", oldNumber: null, newNumber: newLine, text: line.slice(1) });
      newLine += 1;
      previousOldNext = oldLine;
      previousNewNext = newLine;
    }
  }
  return rows;
}
function diffLineClass(line) {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) return "gg-diff-meta";
  if (line.startsWith("@@")) return "gg-diff-modified";
  if (line.startsWith("+")) return "gg-diff-added";
  if (line.startsWith("-")) return "gg-diff-deleted";
  return "gg-diff-context";
}

// src/client/index.ts
var React = require("react");
var RPC_URL = "/easygit";
function rpc(body, signal) {
  return fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal
  }).then((r) => r.json());
}
function rpcRepositoryMutation(action, sessionId, payload = {}) {
  const request = { action, sessionId, operationId: operationId(action), ...payload };
  return rpc(request);
}
function errorText2(error) {
  return error instanceof Error ? error.message : String(error);
}
function injectStyles() {
  if (typeof document === "undefined") return () => {
  };
  if (document.getElementById("dsh-easygit-plugin-css")) return () => {
  };
  const tag = document.createElement("style");
  tag.id = "dsh-easygit-plugin-css";
  tag.textContent = `
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
        .gg-expl { opacity: .9; margin: 8px 0; }
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
        html[data-easygit-workbench-open] div[data-side='details'][data-side='details'] { display: none !important; pointer-events: none !important; }
        .gg-workbench { position: fixed; z-index: 1; inset: 0 0 0 auto; box-sizing: border-box; width: var(--dsh-easygit-plugin-workbench-width, 36vw); max-width: 100vw; min-width: 0; display: flex; flex-direction: column; border-left: 1px solid rgba(174,180,184,.75); color: #e9ecef; background: #202224; box-shadow: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
        .gg-workbench-resize { position: absolute; z-index: 5; top: 0; bottom: 0; left: -6px; width: 12px; padding: 0; border: 0; background: transparent; cursor: col-resize; touch-action: none; }
        .gg-workbench-resize::after { content: ''; position: absolute; top: 0; bottom: 0; left: 4px; width: 2px; background: rgba(127,127,127,.32); transition: background-color .12s ease, box-shadow .12s ease; }
        .gg-workbench-resize:hover::after, .gg-workbench-resize:focus-visible::after, .gg-workbench-resize.dragging::after { background: #00c58b; box-shadow: 0 0 0 1px rgba(0,197,139,.28); }
        .gg-workbench-resize:focus-visible { outline: 2px solid #00c58b; outline-offset: -2px; }
        html[data-easygit-workbench-resizing], html[data-easygit-workbench-resizing] * { cursor: col-resize !important; user-select: none !important; }
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
      `;
  document.head.appendChild(tag);
  return () => {
    try {
      tag.remove();
    } catch (e) {
    }
  };
}
function GitWorkbenchAction(props) {
  const sessionId = String(props.sessionId || "");
  const controller = props.controller;
  const intervalFn = props.intervalFn || null;
  const [state, setState] = React.useState(() => controller.snapshot());
  const [pending, setPending] = React.useState(false);
  const pendingProposalId = React.useRef(null);
  const stateRequestRef = React.useRef({ controller: null, sequence: 0 });
  React.useEffect(() => controller.subscribe(setState), [controller]);
  React.useEffect(() => {
    const refresh = () => {
      const request = beginTrackedRequest(stateRequestRef);
      rpc({ action: "state", sessionId }, request.signal).then((res) => {
        if (!isTrackedRequestCurrent(stateRequestRef, request) || !res || res.ok !== true) return;
        const proposal = res.proposal;
        const isPending = !!(proposal && proposal.status === "pending" && proposal.proposalId);
        setPending(isPending);
        const proposalId = isPending ? proposal.proposalId : null;
        if (proposalId && proposalId !== pendingProposalId.current) controller.open(sessionId);
        pendingProposalId.current = proposalId;
      }).catch((error) => {
        if (isTrackedRequestCurrent(stateRequestRef, request) && !isAbortError(error)) setPending(false);
      });
    };
    refresh();
    const stop = intervalFn ? intervalFn(refresh, 1500) : null;
    return () => {
      cancelTrackedRequest(stateRequestRef);
      if (typeof stop === "function") {
        try {
          stop();
        } catch (err) {
        }
      }
      controller.close(sessionId);
    };
  }, [controller, intervalFn, sessionId]);
  const open = state.open && state.activeSessionId === sessionId;
  return React.createElement(
    "button",
    {
      type: "button",
      className: "gg-btn gg-workbench-action",
      title: state.error || (open ? "\u5173\u95ED Git \u5DE5\u4F5C\u53F0" : "\u6253\u5F00 Git \u5DE5\u4F5C\u53F0"),
      "aria-label": state.error || "Git \u5DE5\u4F5C\u53F0",
      "aria-pressed": open,
      onClick: () => controller.toggle(sessionId)
    },
    React.createElement("span", null, "Git"),
    pending ? React.createElement("span", { className: "gg-workbench-action-dot", "aria-hidden": true }) : null
  );
}
function actionError(response) {
  return String(response && (response.message || response.error) || "\u8BF7\u6C42\u5931\u8D25");
}
function actionDiagnostics(response) {
  return typeof (response && response.diagnostics) === "string" ? response.diagnostics : "";
}
function refreshButtonLabel(state) {
  if (state === "loading") return "\u6B63\u5728\u5237\u65B0\u2026";
  if (state === "succeeded") return "\u5DF2\u5237\u65B0";
  if (state === "failed") return "\u5237\u65B0\u5931\u8D25";
  return "\u5237\u65B0";
}
function useManualRefreshFeedback() {
  const [state, setState] = React.useState("idle");
  const resetTimerRef = React.useRef(null);
  const clearResetTimer = () => {
    if (resetTimerRef.current === null) return;
    window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  };
  const begin = () => {
    clearResetTimer();
    setState("loading");
  };
  const finish = (succeeded) => {
    clearResetTimer();
    setState(succeeded ? "succeeded" : "failed");
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setState("idle");
    }, 1200);
  };
  React.useEffect(() => clearResetTimer, []);
  return { state, begin, finish };
}
function operationId(prefix) {
  return "ui:" + prefix + ":" + Date.now().toString(36) + ":" + Math.random().toString(36).slice(2, 10);
}
function renderDiff(diff) {
  return diff.split("\n").map((line, index) => React.createElement("span", { className: diffLineClass(line), key: "diff-" + index }, line || " "));
}
function renderReview(diff) {
  const rows = parseReviewRows(diff);
  if (!rows.length) return React.createElement("div", { className: "gg-idletext" }, diff ? "\u6CA1\u6709\u53EF\u5BA1\u9605\u7684\u4EE3\u7801\u884C\u3002" : "\u6CA1\u6709\u53EF\u663E\u793A\u7684\u5DEE\u5F02\u3002");
  return rows.map((row, index) => {
    if (row.kind === "skipped") return React.createElement("div", { className: "gg-review-skip", key: "review-" + index }, "\u2304 " + row.text);
    if (row.kind === "annotation") return React.createElement("div", { className: "gg-review-annotation", key: "review-" + index }, row.text);
    return React.createElement(
      "div",
      { className: "gg-review-line " + row.kind, key: "review-" + index },
      React.createElement("span", { className: "gg-review-number" }, row.oldNumber === null ? "" : String(row.oldNumber)),
      React.createElement("span", { className: "gg-review-number" }, row.newNumber === null ? "" : String(row.newNumber)),
      React.createElement("code", { className: "gg-review-code" }, row.text || " ")
    );
  });
}
function renderRawDiffSurface(diff) {
  return React.createElement("code", { className: "gg-diff-content" }, renderDiff(diff));
}
function renderReviewSurface(diff) {
  return React.createElement("div", { className: "gg-review-content" }, renderReview(diff));
}
function GitChangesTab(props) {
  const { sessionId, intervalFn, revision, onChanged, onCommand } = props;
  const [summary, setSummary] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [diff, setDiff] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [diagnostics, setDiagnostics] = React.useState("");
  const [commitMessage, setCommitMessage] = React.useState("");
  const [collapsedFolders, setCollapsedFolders] = React.useState({});
  const [reviewMode, setReviewMode] = React.useState("review");
  const refreshFeedback = useManualRefreshFeedback();
  const selectedRef = React.useRef(null);
  const manualRefreshRef = React.useRef(false);
  const summaryRequestRef = React.useRef({ controller: null, sequence: 0 });
  const diffRequestRef = React.useRef({ controller: null, sequence: 0 });
  const loadDiff = (selection, showLoading = true) => {
    if (showLoading) setDiff("\u6B63\u5728\u52A0\u8F7D\u5DEE\u5F02\u2026");
    const request = beginTrackedRequest(diffRequestRef);
    return rpc({ action: "get-diff", sessionId, path: selection.path, staged: selection.staged }, request.signal).then((response) => {
      if (!isTrackedRequestCurrent(diffRequestRef, request)) return false;
      if (response && response.ok === true) {
        setDiff(String(response.data.diff || "\u6CA1\u6709\u53EF\u663E\u793A\u7684\u5DEE\u5F02\u3002"));
        return true;
      }
      setDiff(actionError(response));
      return false;
    }).catch((error) => {
      if (!isTrackedRequestCurrent(diffRequestRef, request) || isAbortError(error)) return false;
      setDiff(errorText2(error));
      return false;
    });
  };
  const load = (manual = false) => {
    if (!manual && manualRefreshRef.current) return Promise.resolve(false);
    if (manual) {
      manualRefreshRef.current = true;
      refreshFeedback.begin();
    }
    const request = beginTrackedRequest(summaryRequestRef);
    const summaryLoad = rpc({ action: "get-summary", sessionId }, request.signal).then((response) => {
      if (!isTrackedRequestCurrent(summaryRequestRef, request)) return false;
      if (response && response.ok === true) {
        setSummary(response.data);
        setMessage("");
        setDiagnostics("");
        return true;
      } else {
        setMessage(actionError(response));
        setDiagnostics(actionDiagnostics(response));
        return false;
      }
    }).catch((error) => {
      if (!isTrackedRequestCurrent(summaryRequestRef, request) || isAbortError(error)) return false;
      setMessage(errorText2(error));
      setDiagnostics("");
      return false;
    });
    const selection = manual ? selectedRef.current : null;
    const diffLoad = selection ? loadDiff(selection, true) : Promise.resolve(true);
    return Promise.all([summaryLoad, diffLoad]).then(([summarySucceeded, diffSucceeded]) => {
      const current = isTrackedRequestCurrent(summaryRequestRef, request);
      if (manual && current) refreshFeedback.finish(summarySucceeded && diffSucceeded);
      if (manual) manualRefreshRef.current = false;
      return current && summarySucceeded && diffSucceeded;
    });
  };
  React.useEffect(() => {
    load();
    const stop = intervalFn ? intervalFn(load, 1800) : null;
    return () => {
      cancelTrackedRequest(summaryRequestRef);
      if (typeof stop === "function") stop();
    };
  }, [sessionId, intervalFn, revision]);
  React.useEffect(() => {
    cancelTrackedRequest(diffRequestRef);
    selectedRef.current = null;
    setSelected(null);
    setDiff("");
  }, [sessionId]);
  React.useEffect(() => () => {
    cancelTrackedRequest(summaryRequestRef);
    cancelTrackedRequest(diffRequestRef);
  }, []);
  const runMutation = (action, payload = {}) => {
    const description = mutationCommand(action, payload);
    const completeCommand = description ? onCommand(description.label, description.command) : null;
    setBusy(true);
    setMessage("");
    setDiagnostics("");
    return rpcRepositoryMutation(action, sessionId, payload).then((response) => {
      if (!response || response.ok !== true) {
        if (completeCommand) completeCommand(false);
        setMessage(actionError(response));
        setDiagnostics(actionDiagnostics(response));
        return false;
      } else {
        if (completeCommand) completeCommand(true);
        cancelTrackedRequest(summaryRequestRef);
        setSummary(response.data);
        onChanged();
        return true;
      }
    }).catch((error) => {
      if (completeCommand) completeCommand(false);
      setMessage(errorText2(error));
      setDiagnostics("");
      return false;
    }).then((succeeded) => {
      setBusy(false);
      return succeeded;
    });
  };
  const selectFile = (file, staged) => {
    const path = String(file.path || "");
    if (!path) return;
    const selection = { path, staged };
    selectedRef.current = selection;
    setSelected(selection);
    void loadDiff(selection);
  };
  const files = summary && Array.isArray(summary.files) ? summary.files : [];
  const stagedFiles = files.filter((file) => file.indexStatus && file.indexStatus !== " " && file.indexStatus !== "?");
  const unstagedFiles = files.filter((file) => file.workTreeStatus && file.workTreeStatus !== " " || file.indexStatus === "?");
  const fileRow = (file, staged, key, depth) => {
    const status = String(file.indexStatus || " ") + String(file.workTreeStatus || " ");
    const tone = /[?A]/.test(status) ? " added" : /D/.test(status) ? " deleted" : " modified";
    const active = !!(selected && selected.path === file.path && selected.staged === staged);
    return React.createElement(
      "div",
      { className: "gg-file" + tone + (active ? " active" : ""), key, style: { paddingLeft: 4 + depth * 14 } },
      React.createElement(
        "button",
        { className: "gg-file-path", type: "button", onClick: () => selectFile(file, staged) },
        React.createElement("code", null, status + " " + String(file.path || ""))
      ),
      React.createElement("button", {
        className: "gg-btn",
        disabled: busy,
        onClick: () => runMutation(staged ? "unstage-paths" : "stage-paths", { paths: [String(file.path || "")] })
      }, staged ? "\u53D6\u6D88\u6682\u5B58" : "\u6682\u5B58")
    );
  };
  const renderFileTree = (groupFiles, staged, group) => {
    const countFiles = (node) => node.files.length + node.folders.reduce((total, folder) => total + countFiles(folder), 0);
    const renderNode = (node, depth) => {
      const entries = [];
      for (const folder of node.folders) {
        const folderKey = group + ":" + folder.path;
        const collapsed = collapsedFolders[folderKey] === true;
        entries.push(React.createElement(
          "div",
          { className: "gg-tree-folder", key: folderKey },
          React.createElement(
            "button",
            {
              className: "gg-folder-toggle",
              type: "button",
              "aria-expanded": !collapsed,
              style: { paddingLeft: 2 + depth * 14 },
              onClick: () => setCollapsedFolders((current) => ({ ...current, [folderKey]: !current[folderKey] }))
            },
            React.createElement("span", { className: "gg-folder-arrow", "aria-hidden": true }, collapsed ? "\u203A" : "\u2304"),
            React.createElement("span", { className: "gg-folder-name" }, folder.name + " (" + countFiles(folder) + ")")
          ),
          collapsed ? null : renderNode(folder, depth + 1)
        ));
      }
      for (const file of node.files) entries.push(fileRow(file, staged, group + ":" + String(file.path || ""), depth));
      return entries;
    };
    return React.createElement("div", { className: "gg-file-tree" }, renderNode(buildFileTree(groupFiles), 0));
  };
  return React.createElement(
    "section",
    { className: "gg-tab-content" },
    React.createElement(
      "div",
      { className: "gg-tab-toolbar" },
      React.createElement("span", { className: "gg-idletext" }, summary ? repositoryName(summary.topLevel) + " \u2192 " + String(summary.branch || summary.head || "\u5206\u79BB HEAD") : "\u6B63\u5728\u8BFB\u53D6\u4ED3\u5E93\u2026"),
      React.createElement("button", {
        className: "gg-btn",
        disabled: busy || refreshFeedback.state === "loading",
        onClick: () => {
          void load(true);
        }
      }, refreshButtonLabel(refreshFeedback.state)),
      React.createElement("button", { className: "gg-btn", disabled: busy, onClick: () => runMutation("stage-all") }, "\u5168\u90E8\u6682\u5B58"),
      React.createElement("button", { className: "gg-btn", disabled: busy, onClick: () => runMutation("unstage-all") }, "\u5168\u90E8\u53D6\u6D88\u6682\u5B58")
    ),
    message ? React.createElement("div", { className: "gg-workbench-error" }, message) : null,
    diagnostics ? React.createElement("pre", { className: "gg-diagnostics" }, diagnostics) : null,
    React.createElement(
      "div",
      { className: "gg-change-layout" },
      React.createElement(
        "div",
        { className: "gg-change-files" },
        React.createElement(
          "div",
          { className: "gg-file-group" },
          React.createElement("strong", null, "\u672A\u6682\u5B58 (" + unstagedFiles.length + ")"),
          unstagedFiles.length ? renderFileTree(unstagedFiles, false, "unstaged") : React.createElement("div", { className: "gg-idletext" }, "\u6CA1\u6709\u672A\u6682\u5B58\u7684\u53D8\u66F4\u3002")
        ),
        React.createElement(
          "div",
          { className: "gg-file-group" },
          React.createElement("strong", null, "\u5DF2\u6682\u5B58 (" + stagedFiles.length + ")"),
          stagedFiles.length ? renderFileTree(stagedFiles, true, "staged") : React.createElement("div", { className: "gg-idletext" }, "\u6CA1\u6709\u5DF2\u6682\u5B58\u7684\u53D8\u66F4\u3002")
        ),
        React.createElement(
          "div",
          { className: "gg-commit-form" },
          React.createElement("input", {
            className: "gg-input",
            value: commitMessage,
            placeholder: "\u63D0\u4EA4\u8BF4\u660E",
            disabled: busy,
            onChange: (event) => setCommitMessage(String(event.target.value || ""))
          }),
          React.createElement("button", {
            className: "gg-btn primary",
            disabled: busy || !commitMessage.trim() || stagedFiles.length === 0,
            onClick: () => runMutation("commit", { message: commitMessage }).then((succeeded) => {
              if (succeeded) setCommitMessage("");
            })
          }, "\u63D0\u4EA4")
        )
      ),
      React.createElement(
        "div",
        { className: "gg-diff" },
        React.createElement("div", { className: "gg-intent" }, selected ? String(selected.path) + (selected.staged ? "\uFF08\u5DF2\u6682\u5B58\uFF09" : "\uFF08\u672A\u6682\u5B58\uFF09") : "\u9009\u62E9\u6587\u4EF6\u4EE5\u67E5\u770B\u5DEE\u5F02"),
        selected ? React.createElement(
          "div",
          { className: "gg-review-toolbar" },
          React.createElement("button", { className: "gg-btn gg-review-mode" + (reviewMode === "review" ? " active" : ""), type: "button", onClick: () => setReviewMode("review") }, "\u6587\u4EF6\u5BA1\u9605"),
          React.createElement("button", { className: "gg-btn gg-review-mode" + (reviewMode === "raw" ? " active" : ""), type: "button", onClick: () => setReviewMode("raw") }, "\u539F\u59CB Diff")
        ) : null,
        selected && reviewMode === "review" ? React.createElement("div", { className: "gg-review" }, renderReviewSurface(diff)) : React.createElement(
          "pre",
          { className: "gg-pre gg-diff-code" },
          renderRawDiffSurface(selected ? diff : "\u5C1A\u672A\u9009\u62E9\u6587\u4EF6\u3002")
        )
      )
    )
  );
}
function GitBranchesTab(props) {
  const { sessionId, revision, onChanged, onCommand } = props;
  const [branches, setBranches] = React.useState([]);
  const [remotes, setRemotes] = React.useState([]);
  const [tags, setTags] = React.useState([]);
  const [referenceTab, setReferenceTab] = React.useState("local");
  const [branchQuery, setBranchQuery] = React.useState("");
  const [name, setName] = React.useState("");
  const [base, setBase] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [diagnostics, setDiagnostics] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState(null);
  const [forceDelete, setForceDelete] = React.useState(null);
  const [riskAccepted, setRiskAccepted] = React.useState(false);
  const refreshFeedback = useManualRefreshFeedback();
  const listRequestRef = React.useRef({ controller: null, sequence: 0 });
  const load = (manual = false) => {
    if (manual) refreshFeedback.begin();
    const request = beginTrackedRequest(listRequestRef);
    return rpc({ action: "get-branches", sessionId }, request.signal).then((response) => {
      if (!isTrackedRequestCurrent(listRequestRef, request)) return false;
      if (response && response.ok === true) {
        const data = response.data && !Array.isArray(response.data) ? response.data : { branches: response.data, remotes: [], tags: [] };
        const next = Array.isArray(data.branches) ? data.branches : [];
        setBranches(next);
        setRemotes(Array.isArray(data.remotes) ? data.remotes : []);
        setTags(Array.isArray(data.tags) ? data.tags : []);
        const current = next.find((branch) => branch.current);
        if (!base && current) setBase(String(current.name || ""));
        if (confirmDelete && !next.some((branch) => branch.name === confirmDelete)) setConfirmDelete(null);
        if (forceDelete && !next.some((branch) => branch.name === forceDelete)) setForceDelete(null);
        setMessage("");
        setDiagnostics("");
        return true;
      } else {
        setMessage(actionError(response));
        setDiagnostics(actionDiagnostics(response));
        return false;
      }
    }).catch((error) => {
      if (!isTrackedRequestCurrent(listRequestRef, request) || isAbortError(error)) return false;
      setMessage(errorText2(error));
      setDiagnostics("");
      return false;
    }).then((succeeded) => {
      if (manual && isTrackedRequestCurrent(listRequestRef, request)) refreshFeedback.finish(succeeded);
      return succeeded;
    });
  };
  React.useEffect(() => {
    load();
    return () => cancelTrackedRequest(listRequestRef);
  }, [sessionId, revision]);
  const mutate = (action, payload) => {
    const description = mutationCommand(action, payload);
    const completeCommand = description ? onCommand(description.label, description.command) : null;
    setBusy(true);
    setMessage("");
    setDiagnostics("");
    rpcRepositoryMutation(action, sessionId, payload).then((response) => {
      if (!response || response.ok !== true) {
        if (completeCommand) completeCommand(false);
        setMessage(actionError(response));
        setDiagnostics(actionDiagnostics(response));
      } else {
        if (completeCommand) completeCommand(true);
        onChanged();
        load();
      }
    }).catch((error) => {
      if (completeCommand) completeCommand(false);
      setMessage(errorText2(error));
      setDiagnostics("");
    }).then(() => setBusy(false));
  };
  const cancelDelete = () => {
    setConfirmDelete(null);
    setForceDelete(null);
    setRiskAccepted(false);
  };
  const deleteBranch = (branchName, force) => {
    const description = mutationCommand("delete-branch", { name: branchName, force });
    const completeCommand = onCommand(description.label, description.command);
    setBusy(true);
    setMessage("");
    setDiagnostics("");
    rpc({
      action: "delete-branch",
      sessionId,
      operationId: operationId(force ? "force-delete-branch" : "delete-branch"),
      name: branchName,
      force,
      confirmRisk: force && riskAccepted
    }).then((response) => {
      if (response && response.ok === true) {
        completeCommand(true);
        cancelDelete();
        onChanged();
        load();
        return;
      }
      completeCommand(false);
      setMessage(actionError(response));
      setDiagnostics(actionDiagnostics(response));
      if (!force && response && response.reason === "UNMERGED_BRANCH") {
        setConfirmDelete(null);
        setForceDelete(branchName);
        setRiskAccepted(false);
      }
    }).catch((error) => {
      completeCommand(false);
      setMessage(errorText2(error));
      setDiagnostics("");
    }).then(() => setBusy(false));
  };
  const referenceRows = (entries, emptyText) => entries.length ? entries.map((entry, index) => React.createElement(
    "div",
    { className: "gg-branch-row gg-reference-row", key: String(entry.name || index) },
    React.createElement("code", null, String(entry.name || "")),
    React.createElement("code", { className: "gg-reference-hash" }, String(entry.hash || "")),
    entry.subject ? React.createElement("span", { className: "gg-idletext", title: String(entry.subject) }, String(entry.subject)) : null
  )) : React.createElement("div", { className: "gg-idletext gg-reference-empty" }, emptyText);
  const visibleBranches = filterLocalBranches(branches, branchQuery);
  return React.createElement(
    "section",
    { className: "gg-tab-content" },
    React.createElement(
      "div",
      { className: "gg-tab-toolbar" },
      React.createElement("button", {
        className: "gg-btn",
        disabled: busy || refreshFeedback.state === "loading",
        onClick: () => {
          void load(true);
        }
      }, refreshButtonLabel(refreshFeedback.state))
    ),
    message ? React.createElement("div", { className: "gg-workbench-error" }, message) : null,
    diagnostics ? React.createElement("pre", { className: "gg-diagnostics" }, diagnostics) : null,
    React.createElement("div", { className: "gg-reference-tabs", role: "tablist", "aria-label": "Git \u5F15\u7528\u7C7B\u578B" }, [
      { id: "local", label: "\u672C\u5730 (" + branches.length + ")" },
      { id: "remote", label: "\u8FDC\u7A0B (" + remotes.length + ")" },
      { id: "tag", label: "\u6807\u7B7E (" + tags.length + ")" }
    ].map((entry) => React.createElement("button", {
      className: "gg-tab" + (referenceTab === entry.id ? " active" : ""),
      type: "button",
      role: "tab",
      key: entry.id,
      "aria-selected": referenceTab === entry.id,
      onClick: () => setReferenceTab(entry.id)
    }, entry.label))),
    referenceTab === "local" ? React.createElement(
      "div",
      { className: "gg-local-branches" },
      React.createElement("input", {
        className: "gg-input",
        type: "search",
        value: branchQuery,
        placeholder: "\u641C\u7D22\u672C\u5730\u5206\u652F",
        "aria-label": "\u641C\u7D22\u672C\u5730\u5206\u652F",
        onChange: (event) => setBranchQuery(String(event.target.value || ""))
      }),
      React.createElement("div", { className: "gg-branch-list" }, visibleBranches.length ? visibleBranches.map((branch, index) => {
        const branchName = String(branch.name || "");
        const confirming = confirmDelete === branchName;
        const forcing = forceDelete === branchName;
        return React.createElement(
          "div",
          { className: "gg-branch-row" + (confirming || forcing ? " confirming" : ""), key: branchName || String(index) },
          React.createElement("code", null, (branch.current ? "* " : "") + branchName),
          branch.upstream ? React.createElement("span", { className: "gg-idletext" }, String(branch.upstream)) : null,
          branch.current ? null : React.createElement("button", { className: "gg-btn", disabled: busy, onClick: () => {
            cancelDelete();
            mutate("switch-branch", { name: branchName });
          } }, "\u5207\u6362"),
          branch.current || confirming || forcing ? null : React.createElement("button", {
            className: "gg-btn",
            disabled: busy,
            onClick: () => {
              setConfirmDelete(branchName);
              setForceDelete(null);
              setRiskAccepted(false);
            }
          }, "\u5220\u9664"),
          confirming ? React.createElement(
            "div",
            { className: "gg-branch-confirm" },
            React.createElement("span", null, `\u786E\u5B9A\u5B89\u5168\u5220\u9664\u5206\u652F\u201C${branchName}\u201D\u5417\uFF1F`),
            React.createElement(
              "div",
              { className: "gg-branch-confirm-actions" },
              React.createElement("button", { className: "gg-btn danger", disabled: busy, onClick: () => deleteBranch(branchName, false) }, "\u786E\u8BA4\u5B89\u5168\u5220\u9664"),
              React.createElement("button", { className: "gg-btn", disabled: busy, onClick: cancelDelete }, "\u53D6\u6D88")
            )
          ) : null,
          forcing ? React.createElement(
            "div",
            { className: "gg-branch-confirm" },
            React.createElement("div", { className: "gg-riskline" }, `\u5206\u652F\u201C${branchName}\u201D\u5305\u542B\u672A\u5408\u5E76\u63D0\u4EA4\u3002\u5F3A\u5236\u5220\u9664\u53EF\u80FD\u5BFC\u81F4\u8FD9\u4E9B\u63D0\u4EA4\u6C38\u4E45\u4E22\u5931\u3002`),
            React.createElement(
              "label",
              { className: "gg-check" },
              React.createElement("input", { type: "checkbox", checked: riskAccepted, disabled: busy, onChange: (event) => setRiskAccepted(!!event.target.checked) }),
              "\u6211\u5DF2\u77E5\u6653\u672A\u5408\u5E76\u63D0\u4EA4\u53EF\u80FD\u6C38\u4E45\u4E22\u5931"
            ),
            React.createElement(
              "div",
              { className: "gg-branch-confirm-actions" },
              React.createElement("button", { className: "gg-btn danger", disabled: busy || !riskAccepted, onClick: () => deleteBranch(branchName, true) }, "\u5F3A\u5236\u5220\u9664"),
              React.createElement("button", { className: "gg-btn", disabled: busy, onClick: cancelDelete }, "\u53D6\u6D88")
            )
          ) : null
        );
      }) : React.createElement("div", { className: "gg-idletext gg-reference-empty" }, branches.length ? "\u6CA1\u6709\u5339\u914D\u7684\u672C\u5730\u5206\u652F\u3002" : "\u6CA1\u6709\u672C\u5730\u5206\u652F\u3002"))
    ) : referenceTab === "remote" ? React.createElement("div", { className: "gg-branch-list" }, referenceRows(remotes, "\u6CA1\u6709\u8FDC\u7A0B\u5206\u652F\u3002")) : React.createElement("div", { className: "gg-branch-list" }, referenceRows(tags, "\u6CA1\u6709\u6807\u7B7E\u3002")),
    referenceTab === "local" ? React.createElement(
      "div",
      { className: "gg-branch-form" },
      React.createElement("input", { className: "gg-input", value: name, placeholder: "\u65B0\u5206\u652F\u540D\u79F0", disabled: busy, onChange: (event) => setName(String(event.target.value || "")) }),
      React.createElement("input", { className: "gg-input", value: base, placeholder: "\u57FA\u7840\u5206\u652F", disabled: busy, onChange: (event) => setBase(String(event.target.value || "")) }),
      React.createElement("button", {
        className: "gg-btn primary",
        disabled: busy || !name.trim() || !base.trim(),
        onClick: () => mutate("create-branch", { name, base })
      }, "\u65B0\u5EFA\u5206\u652F")
    ) : null
  );
}
var COMMIT_GRAPH_COLORS = ["#ff7500", "#ffbf16", "#3ba7ff", "#c57cff", "#38d996", "#ff5c8a"];
function CommitGraph(props) {
  const { row } = props;
  const width = row.laneCount * 16 + 12;
  const laneX = (lane) => 8 + lane * 16;
  const paths = row.edges.map((edge, index) => {
    const fromX = laneX(edge.from);
    const color = COMMIT_GRAPH_COLORS[edge.from % COMMIT_GRAPH_COLORS.length];
    if (edge.to === null) {
      return React.createElement("path", { key: "root-" + index, d: `M ${fromX} 0 L ${fromX} 11`, stroke: color, strokeWidth: 2, fill: "none" });
    }
    const toX = laneX(edge.to);
    return React.createElement("path", {
      key: "edge-" + index,
      d: `M ${fromX} 0 C ${fromX} 18, ${toX} 18, ${toX} 36`,
      stroke: color,
      strokeWidth: 2,
      fill: "none"
    });
  });
  const nodeColor = COMMIT_GRAPH_COLORS[row.lane % COMMIT_GRAPH_COLORS.length];
  const merge = Array.isArray(row.commit.parents) && row.commit.parents.length > 1;
  return React.createElement(
    "svg",
    {
      className: "gg-commit-graph",
      width,
      height: 36,
      viewBox: `0 0 ${width} 36`,
      "aria-hidden": "true"
    },
    paths,
    merge ? React.createElement("circle", { cx: laneX(row.lane), cy: 11, r: 7, fill: "#202224", stroke: nodeColor, strokeWidth: 2 }) : null,
    React.createElement("circle", { cx: laneX(row.lane), cy: 11, r: merge ? 3 : 5, fill: nodeColor })
  );
}
function GitCommitsTab(props) {
  const { sessionId, revision } = props;
  const [commits, setCommits] = React.useState([]);
  const [message, setMessage] = React.useState("");
  const [selectedHash, setSelectedHash] = React.useState("");
  const [detail, setDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailMessage, setDetailMessage] = React.useState("");
  const [commitDiff, setCommitDiff] = React.useState(null);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [diffMessage, setDiffMessage] = React.useState("");
  const refreshFeedback = useManualRefreshFeedback();
  const selectedHashRef = React.useRef("");
  const listRequestRef = React.useRef({ controller: null, sequence: 0 });
  const detailRequestRef = React.useRef({ controller: null, sequence: 0 });
  const diffRequestRef = React.useRef({ controller: null, sequence: 0 });
  const sessionRef = React.useRef(sessionId);
  const clearSelection = () => {
    selectedHashRef.current = "";
    cancelTrackedRequest(detailRequestRef);
    cancelTrackedRequest(diffRequestRef);
    setSelectedHash("");
    setDetail(null);
    setDetailLoading(false);
    setDetailMessage("");
    setCommitDiff(null);
    setDiffLoading(false);
    setDiffMessage("");
  };
  const loadCommitDetail = (hash, resetView) => {
    selectedHashRef.current = hash;
    if (resetView) {
      cancelTrackedRequest(diffRequestRef);
      setDetail(null);
      setCommitDiff(null);
      setDiffLoading(false);
      setDiffMessage("");
    }
    const request = beginTrackedRequest(detailRequestRef);
    setSelectedHash(hash);
    setDetailLoading(true);
    setDetailMessage("");
    return rpc({ action: "get-commit-detail", sessionId, hash }, request.signal).then((response) => {
      if (selectedHashRef.current !== hash || !isTrackedRequestCurrent(detailRequestRef, request)) return false;
      if (response && response.ok === true) {
        setDetail(response.data);
        return true;
      }
      setDetailMessage(actionError(response));
      return false;
    }).catch((error) => {
      if (selectedHashRef.current !== hash || !isTrackedRequestCurrent(detailRequestRef, request) || isAbortError(error)) return false;
      setDetailMessage(errorText2(error));
      return false;
    }).then((succeeded) => {
      if (selectedHashRef.current === hash && isTrackedRequestCurrent(detailRequestRef, request)) setDetailLoading(false);
      return succeeded;
    });
  };
  const load = (manual = false) => {
    if (manual) refreshFeedback.begin();
    const request = beginTrackedRequest(listRequestRef);
    return rpc({ action: "get-commits", sessionId, limit: 80 }, request.signal).then(async (response) => {
      if (!isTrackedRequestCurrent(listRequestRef, request)) return false;
      if (response && response.ok === true) {
        const next = Array.isArray(response.data) ? response.data : [];
        setCommits(next);
        setMessage("");
        const activeHash = selectedHashRef.current;
        if (activeHash && !next.some((commit) => commit.hash === activeHash)) {
          clearSelection();
          return true;
        }
        if (manual && activeHash) return loadCommitDetail(activeHash, false);
        return true;
      }
      setMessage(actionError(response));
      return false;
    }).catch((error) => {
      if (!isTrackedRequestCurrent(listRequestRef, request) || isAbortError(error)) return false;
      setMessage(errorText2(error));
      return false;
    }).then((succeeded) => {
      if (manual && isTrackedRequestCurrent(listRequestRef, request)) refreshFeedback.finish(succeeded);
      return succeeded;
    });
  };
  React.useEffect(() => {
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      clearSelection();
    }
    load();
    return () => cancelTrackedRequest(listRequestRef);
  }, [sessionId, revision]);
  React.useEffect(() => () => {
    cancelTrackedRequest(listRequestRef);
    cancelTrackedRequest(detailRequestRef);
    cancelTrackedRequest(diffRequestRef);
  }, []);
  const selectCommit = (commit) => {
    const hash = String(commit.hash || "");
    if (!hash) return;
    if (!nextCommitSelection(selectedHashRef.current, hash)) {
      clearSelection();
      return;
    }
    void loadCommitDetail(hash, true);
  };
  const loadCommitDiff = () => {
    const hash = selectedHashRef.current;
    if (!hash || diffLoading) return;
    const request = beginTrackedRequest(diffRequestRef);
    setDiffLoading(true);
    setDiffMessage("");
    rpc({ action: "get-commit-diff", sessionId, hash }, request.signal).then((response) => {
      const current = selectedHashRef.current === hash && isTrackedRequestCurrent(diffRequestRef, request);
      if (!current) return;
      if (response && response.ok === true) setCommitDiff(response.data);
      else setDiffMessage(actionError(response));
    }).catch((error) => {
      const current = selectedHashRef.current === hash && isTrackedRequestCurrent(diffRequestRef, request);
      if (current && !isAbortError(error)) setDiffMessage(errorText2(error));
    }).then(() => {
      const current = selectedHashRef.current === hash && isTrackedRequestCurrent(diffRequestRef, request);
      if (current) setDiffLoading(false);
    });
  };
  const rows = deriveCommitGraph(commits);
  const detailPanel = !selectedHash ? null : React.createElement(
    "div",
    { className: "gg-commit-detail" },
    React.createElement(
      "div",
      { className: "gg-commit-detail-head" },
      React.createElement("strong", { className: "gg-commit-detail-title" }, detail ? String(detail.subject || "\uFF08\u65E0\u63D0\u4EA4\u8BF4\u660E\uFF09") : "\u63D0\u4EA4\u8BE6\u60C5"),
      detail ? React.createElement("code", { className: "gg-commit-detail-hash", title: String(detail.hash || "") }, String(detail.hash || "").slice(0, 12)) : null,
      React.createElement("button", {
        className: "gg-btn gg-commit-detail-close",
        type: "button",
        title: "\u5173\u95ED\u63D0\u4EA4\u8BE6\u60C5",
        "aria-label": "\u5173\u95ED\u63D0\u4EA4\u8BE6\u60C5",
        onClick: clearSelection
      }, "\xD7")
    ),
    detailLoading ? React.createElement("div", { className: "gg-idletext" }, "\u6B63\u5728\u52A0\u8F7D\u63D0\u4EA4\u8BE6\u60C5\u2026") : null,
    detailMessage ? React.createElement("div", { className: "gg-workbench-error" }, detailMessage) : null,
    detail ? React.createElement(
      React.Fragment,
      null,
      detail.body ? React.createElement("pre", { className: "gg-commit-message" }, String(detail.body)) : null,
      React.createElement(
        "dl",
        { className: "gg-commit-detail-meta" },
        React.createElement("dt", null, "\u4F5C\u8005"),
        React.createElement("dd", null, String(detail.authorName || "\u672A\u77E5\u4F5C\u8005") + (detail.authorEmail ? " <" + String(detail.authorEmail) + ">" : "")),
        React.createElement("dt", null, "\u4F5C\u8005\u65F6\u95F4"),
        React.createElement("dd", null, String(detail.authoredAt || "\u672A\u77E5")),
        React.createElement("dt", null, "\u63D0\u4EA4\u8005"),
        React.createElement("dd", null, String(detail.committerName || "\u672A\u77E5\u63D0\u4EA4\u8005") + (detail.committerEmail ? " <" + String(detail.committerEmail) + ">" : "")),
        React.createElement("dt", null, "\u63D0\u4EA4\u65F6\u95F4"),
        React.createElement("dd", null, String(detail.committedAt || "\u672A\u77E5")),
        React.createElement("dt", null, "\u7236\u63D0\u4EA4"),
        React.createElement("dd", null, Array.isArray(detail.parents) && detail.parents.length ? detail.parents.map((parent) => parent.slice(0, 12)).join(", ") : "\u6839\u63D0\u4EA4"),
        Array.isArray(detail.parents) && detail.parents.length > 1 ? React.createElement("dt", null, "\u5DEE\u5F02\u57FA\u7EBF") : null,
        Array.isArray(detail.parents) && detail.parents.length > 1 ? React.createElement("dd", null, "\u7B2C\u4E00\u7236\u63D0\u4EA4 " + String(detail.comparisonBase || "").slice(0, 12)) : null
      ),
      React.createElement(
        "div",
        { className: "gg-commit-summary" },
        React.createElement("span", null, String(detail.totals?.files ?? 0) + " \u4E2A\u6587\u4EF6"),
        React.createElement("span", { className: "gg-additions" }, "+" + String(detail.totals?.additions ?? 0)),
        React.createElement("span", { className: "gg-deletions" }, "-" + String(detail.totals?.deletions ?? 0)),
        detail.totals?.binary ? React.createElement("span", null, String(detail.totals.binary) + " \u4E2A\u4E8C\u8FDB\u5236\u6587\u4EF6") : null
      ),
      React.createElement("div", { className: "gg-commit-files" }, Array.isArray(detail.files) && detail.files.length ? detail.files.map((file, index) => React.createElement(
        "div",
        {
          className: "gg-commit-file" + commitFileTone(String(file.status || "")),
          key: String(file.path || index)
        },
        React.createElement("code", null, String(file.status || "?")),
        React.createElement(
          "span",
          { className: "gg-commit-file-path", title: String(file.path || "") },
          file.previousPath ? String(file.previousPath) + " \u2192 " + String(file.path || "") : String(file.path || "")
        ),
        React.createElement("span", { className: "gg-additions" }, file.additions === null ? "\u4E8C\u8FDB\u5236" : "+" + String(file.additions)),
        React.createElement("span", { className: "gg-deletions" }, file.deletions === null ? "" : "-" + String(file.deletions))
      )) : React.createElement("div", { className: "gg-idletext gg-reference-empty" }, "\u8BE5\u63D0\u4EA4\u6CA1\u6709\u53EF\u663E\u793A\u7684\u6587\u4EF6\u53D8\u66F4\u3002")),
      detail.filesTruncated ? React.createElement("div", { className: "gg-riskline" }, "\u6587\u4EF6\u5217\u8868\u8FC7\u957F\uFF0C\u4EC5\u663E\u793A\u524D 500 \u9879\u3002") : null,
      React.createElement(
        "button",
        { className: "gg-btn", type: "button", disabled: diffLoading, onClick: loadCommitDiff },
        diffLoading ? "\u6B63\u5728\u52A0\u8F7D\u8BE6\u7EC6 Diff\u2026" : commitDiff ? "\u91CD\u65B0\u52A0\u8F7D\u8BE6\u7EC6 Diff" : "\u52A0\u8F7D\u8BE6\u7EC6 Diff"
      ),
      diffMessage ? React.createElement("div", { className: "gg-workbench-error" }, diffMessage) : null,
      commitDiff ? React.createElement(
        React.Fragment,
        null,
        commitDiff.truncated ? React.createElement("div", { className: "gg-riskline" }, "Diff \u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD\u4E3A\u524D 300,000 \u4E2A\u5B57\u7B26\u3002") : null,
        React.createElement(
          "pre",
          { className: "gg-pre gg-diff-code gg-commit-diff" },
          renderRawDiffSurface(String(commitDiff.diff || "\u6CA1\u6709\u53EF\u663E\u793A\u7684\u5DEE\u5F02\u3002"))
        )
      ) : null
    ) : null
  );
  return React.createElement(
    "section",
    { className: "gg-tab-content" },
    React.createElement("div", { className: "gg-tab-toolbar" }, React.createElement("button", {
      className: "gg-btn",
      disabled: refreshFeedback.state === "loading",
      onClick: () => {
        void load(true);
      }
    }, refreshButtonLabel(refreshFeedback.state))),
    message ? React.createElement("div", { className: "gg-workbench-error" }, message) : null,
    React.createElement(
      "div",
      { className: "gg-commit-layout" },
      React.createElement("div", { className: "gg-commit-list" }, rows.length ? rows.map((row, index) => {
        const commit = row.commit;
        const refs = Array.isArray(commit.refs) ? commit.refs : [];
        const hash = String(commit.hash || "");
        const activate = () => selectCommit(commit);
        return React.createElement(
          "div",
          {
            className: "gg-commit-row" + (selectedHash === hash ? " active" : ""),
            key: hash || String(index),
            title: [commit.hash, commit.author, commit.date].filter(Boolean).join(" \xB7 "),
            role: "button",
            tabIndex: 0,
            "aria-pressed": selectedHash === hash,
            onClick: activate,
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate();
              }
            }
          },
          React.createElement(CommitGraph, { row }),
          React.createElement(
            "div",
            { className: "gg-commit-copy" },
            React.createElement(
              "div",
              { className: "gg-commit-main" },
              React.createElement("span", { className: "gg-commit-subject" }, String(commit.subject || "\uFF08\u65E0\u63D0\u4EA4\u8BF4\u660E\uFF09")),
              React.createElement("span", { className: "gg-commit-refs" }, refs.map((ref, refIndex) => React.createElement("span", {
                className: "gg-ref " + String(ref.type || "branch") + (ref.current ? " current" : ""),
                key: String(ref.type || "") + ":" + String(ref.name || refIndex),
                title: String(ref.name || "")
              }, String(ref.name || ""))))
            ),
            React.createElement(
              "div",
              { className: "gg-commit-meta" },
              React.createElement("span", { className: "gg-commit-author" }, String(commit.author || "\u672A\u77E5\u4F5C\u8005")),
              React.createElement("code", { className: "gg-commit-hash" }, hash.slice(0, 8))
            )
          )
        );
      }) : React.createElement("div", { className: "gg-idletext" }, "\u6CA1\u6709\u63D0\u4EA4\u8BB0\u5F55\u3002")),
      detailPanel
    )
  );
}
function GitStashesTab(props) {
  const { sessionId, revision } = props;
  const [stashes, setStashes] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const listRequestRef = React.useRef({ controller: null, sequence: 0 });
  const load = () => {
    const request = beginTrackedRequest(listRequestRef);
    setLoading(true);
    setMessage("");
    rpc({ action: "get-stashes", sessionId }, request.signal).then((response) => {
      if (!isTrackedRequestCurrent(listRequestRef, request)) return;
      if (response && response.ok === true) setStashes(Array.isArray(response.data) ? response.data.slice(0, 100) : []);
      else setMessage(actionError(response));
    }).catch((error) => {
      if (isTrackedRequestCurrent(listRequestRef, request) && !isAbortError(error)) setMessage(errorText2(error));
    }).then(() => {
      if (isTrackedRequestCurrent(listRequestRef, request)) setLoading(false);
    });
  };
  React.useEffect(() => {
    load();
    return () => cancelTrackedRequest(listRequestRef);
  }, [sessionId, revision]);
  return React.createElement(
    "section",
    { className: "gg-tab-content" },
    React.createElement(
      "div",
      { className: "gg-tab-toolbar" },
      React.createElement("span", { className: "gg-idletext" }, "\u8D2E\u85CF (" + stashes.length + ")"),
      React.createElement("button", { className: "gg-btn", type: "button", disabled: loading, onClick: load }, loading ? "\u6B63\u5728\u5237\u65B0\u2026" : "\u5237\u65B0")
    ),
    message ? React.createElement("div", { className: "gg-workbench-error" }, message) : null,
    React.createElement("div", { className: "gg-stash-list" }, loading && stashes.length === 0 ? React.createElement("div", { className: "gg-idletext gg-reference-empty" }, "\u6B63\u5728\u8BFB\u53D6\u8D2E\u85CF\u5217\u8868\u2026") : stashes.length ? stashes.map((stash, index) => React.createElement(
      "div",
      {
        className: "gg-stash-row",
        key: String(stash.hash || stash.selector || index),
        title: [stash.selector, stash.hash, stash.subject, stash.author, stash.date].filter(Boolean).join(" \xB7 ")
      },
      React.createElement("code", { className: "gg-stash-selector" }, String(stash.selector || "stash@{?}")),
      React.createElement("span", { className: "gg-stash-subject" }, String(stash.subject || "\uFF08\u65E0\u8D2E\u85CF\u8BF4\u660E\uFF09")),
      React.createElement("code", { className: "gg-stash-hash" }, String(stash.hash || "").slice(0, 8)),
      React.createElement(
        "div",
        { className: "gg-stash-meta" },
        React.createElement("span", { className: "gg-stash-author" }, String(stash.author || "\u672A\u77E5\u4F5C\u8005")),
        React.createElement("span", { className: "gg-stash-date" }, String(stash.date || "\u672A\u77E5\u65F6\u95F4"))
      )
    )) : React.createElement("div", { className: "gg-idletext gg-reference-empty" }, "\u5F53\u524D\u4ED3\u5E93\u6CA1\u6709\u8D2E\u85CF\u3002"))
  );
}
function GitWorkbenchPanel(props) {
  const [tab, setTab] = React.useState("changes");
  const [revision, setRevision] = React.useState(0);
  const [ratio, setRatio] = React.useState(readWorkbenchRatio);
  const [currentViewportWidth, setCurrentViewportWidth] = React.useState(viewportWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const [commandLogs, setCommandLogs] = React.useState([]);
  const rootRef = React.useRef(null);
  const hostSplitRef = React.useRef(null);
  const resizeDragRef = React.useRef(null);
  const commandSeqRef = React.useRef(0);
  const commandLogBodyRef = React.useRef(null);
  const refresh = () => setRevision((current) => current + 1);
  const reportCommand = (label, command) => {
    commandSeqRef.current += 1;
    const id = commandSeqRef.current;
    setCommandLogs((current) => appendCommandLog(current, { id, label, command, status: "running" }));
    let completed = false;
    return (succeeded) => {
      if (completed) return;
      completed = true;
      setCommandLogs((current) => current.map((entry) => entry.id === id ? { ...entry, status: succeeded ? "succeeded" : "failed" } : entry));
    };
  };
  React.useEffect(() => {
    const controller = new AbortController();
    rpc({ action: "state", sessionId: props.sessionId }, controller.signal).then((response) => {
      if (!controller.signal.aborted && response && response.ok === true && response.proposal && response.proposal.status === "pending") setTab("proposal");
    }).catch(() => {
    });
    return () => controller.abort();
  }, [props.sessionId]);
  React.useEffect(() => {
    setCommandLogs([]);
    commandSeqRef.current = 0;
  }, [props.sessionId]);
  React.useEffect(() => {
    const element = commandLogBodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [commandLogs]);
  React.useLayoutEffect(() => {
    if (!rootRef.current) return void 0;
    const layout = findWorkbenchHostSplit(rootRef.current);
    if (!layout) return void 0;
    const previousGridTemplateColumns = layout.frame.style.gridTemplateColumns;
    const previousTrack = layout.frame.style.getPropertyValue(WORKBENCH_TRACK);
    const previousDetailsWidth = layout.details.style.width;
    const previousDetailsMinWidth = layout.details.style.minWidth;
    const previousDetailsMaxWidth = layout.details.style.maxWidth;
    const previousDetailsBorderLeft = layout.details.style.borderLeft;
    const splitColumns = `${sidebarTrackWidth(layout)}px minmax(0, 1fr) var(${WORKBENCH_TRACK})`;
    layout.frame.style.setProperty(WORKBENCH_TRACK, workbenchTrackForRatio(ratio));
    layout.frame.style.gridTemplateColumns = splitColumns;
    layout.details.style.width = "100%";
    layout.details.style.minWidth = "0";
    layout.details.style.maxWidth = "none";
    layout.details.style.borderLeft = "none";
    hostSplitRef.current = {
      layout,
      splitColumns,
      previousGridTemplateColumns,
      previousTrack,
      previousDetailsWidth,
      previousDetailsMinWidth,
      previousDetailsMaxWidth,
      previousDetailsBorderLeft
    };
    return () => {
      if (layout.frame.style.gridTemplateColumns === splitColumns) layout.frame.style.gridTemplateColumns = previousGridTemplateColumns;
      if (previousTrack) layout.frame.style.setProperty(WORKBENCH_TRACK, previousTrack);
      else layout.frame.style.removeProperty(WORKBENCH_TRACK);
      layout.details.style.width = previousDetailsWidth;
      layout.details.style.minWidth = previousDetailsMinWidth;
      layout.details.style.maxWidth = previousDetailsMaxWidth;
      layout.details.style.borderLeft = previousDetailsBorderLeft;
      hostSplitRef.current = null;
    };
  }, [props.sessionId, currentViewportWidth]);
  React.useEffect(() => {
    const resize = () => setCurrentViewportWidth(viewportWidth());
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      document.documentElement.removeAttribute("data-easygit-workbench-resizing");
    };
  }, []);
  const setWorkbenchRatio = (nextValue, persist) => {
    const next = clampWorkbenchRatio(nextValue);
    const active = hostSplitRef.current;
    if (active) active.layout.frame.style.setProperty(WORKBENCH_TRACK, workbenchTrackForRatio(next));
    setRatio(next);
    if (persist) persistWorkbenchRatio(next);
  };
  const onResizePointerDown = (event) => {
    if (event.button !== 0) return;
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: viewportWidth() * ratio,
      currentRatio: ratio
    };
    if (event.currentTarget.focus) event.currentTarget.focus();
    document.documentElement.setAttribute("data-easygit-workbench-resizing", "");
    setIsResizing(true);
    event.preventDefault();
  };
  React.useEffect(() => {
    if (!isResizing) return void 0;
    const move = (event) => {
      const drag = resizeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.currentRatio = clampWorkbenchRatio((drag.startWidth + drag.startX - event.clientX) / viewportWidth());
      setWorkbenchRatio(drag.currentRatio, false);
      event.preventDefault();
    };
    const finish = (event) => {
      const drag = resizeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      resizeDragRef.current = null;
      document.documentElement.removeAttribute("data-easygit-workbench-resizing");
      setIsResizing(false);
      persistWorkbenchRatio(drag.currentRatio);
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
    };
  }, [isResizing]);
  const tabs = [
    { id: "changes", label: "\u53D8\u66F4" },
    { id: "branches", label: "\u5206\u652F" },
    { id: "commits", label: "\u63D0\u4EA4\u8BB0\u5F55" },
    { id: "stashes", label: "\u8D2E\u85CF" },
    { id: "proposal", label: "\u5EFA\u8BAE" }
  ];
  const content = tab === "changes" ? React.createElement(GitChangesTab, { sessionId: props.sessionId, intervalFn: props.intervalFn, revision, onChanged: refresh, onCommand: reportCommand }) : tab === "branches" ? React.createElement(GitBranchesTab, { sessionId: props.sessionId, revision, onChanged: refresh, onCommand: reportCommand }) : tab === "commits" ? React.createElement(GitCommitsTab, { sessionId: props.sessionId, revision }) : tab === "stashes" ? React.createElement(GitStashesTab, { sessionId: props.sessionId, revision }) : React.createElement(GitDock, { sessionId: props.sessionId, intervalFn: props.intervalFn, timeoutFn: props.timeoutFn });
  return React.createElement(
    "aside",
    {
      className: "gg-workbench",
      "aria-label": "Git \u5DE5\u4F5C\u53F0",
      ref: rootRef,
      style: { [WORKBENCH_TRACK]: workbenchTrackForRatio(ratio) }
    },
    React.createElement("div", {
      className: "gg-workbench-resize" + (isResizing ? " dragging" : ""),
      "aria-hidden": "true",
      title: "\u5DE6\u53F3\u62D6\u52A8\u8C03\u6574\u5DE5\u4F5C\u53F0\u5BBD\u5EA6",
      onPointerDown: onResizePointerDown
    }),
    React.createElement(
      "div",
      { className: "gg-workbench-head" },
      React.createElement("span", { className: "gg-workbench-title" }, "Git \u5DE5\u4F5C\u53F0"),
      React.createElement("button", {
        type: "button",
        className: "gg-btn gg-workbench-close",
        title: "\u5173\u95ED Git \u5DE5\u4F5C\u53F0",
        "aria-label": "\u5173\u95ED Git \u5DE5\u4F5C\u53F0",
        onClick: props.close
      }, "\xD7")
    ),
    React.createElement(
      "div",
      { className: "gg-workbench-body" },
      React.createElement("div", { className: "gg-tabs", role: "tablist", "aria-label": "Git \u5DE5\u4F5C\u53F0\u533A\u57DF" }, tabs.map((entry) => React.createElement("button", {
        className: "gg-tab" + (tab === entry.id ? " active" : ""),
        type: "button",
        role: "tab",
        "aria-selected": tab === entry.id,
        onClick: () => setTab(entry.id),
        key: entry.id
      }, entry.label))),
      content
    ),
    React.createElement(
      "section",
      { className: "gg-command-log", "aria-label": "\u547D\u4EE4\u65E5\u5FD7" },
      React.createElement("strong", { className: "gg-command-log-head" }, "\u547D\u4EE4\u65E5\u5FD7"),
      React.createElement("div", { className: "gg-command-log-body", ref: commandLogBodyRef }, commandLogs.length ? commandLogs.map((entry) => React.createElement(
        "div",
        { className: "gg-command-entry", key: entry.id },
        React.createElement("span", { className: "gg-command-label" }, entry.label),
        React.createElement("span", { className: "gg-command-status " + entry.status }, entry.status === "running" ? "\u6267\u884C\u4E2D" : entry.status === "succeeded" ? "\u6210\u529F" : "\u5931\u8D25"),
        React.createElement("code", { className: "gg-command-code" }, entry.command)
      )) : React.createElement("div", { className: "gg-idletext" }, "\u5C1A\u672A\u6267\u884C\u4FEE\u6539\u547D\u4EE4\u3002"))
    )
  );
}
function GitDock(props) {
  const sessionId = props.sessionId || "";
  const intervalFn = props.intervalFn || null;
  const timeoutFn = props.timeoutFn || null;
  const [view, setView] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [understood, setUnderstood] = React.useState(false);
  const [outcome, setOutcome] = React.useState(null);
  const [ranInfo, setRanInfo] = React.useState(null);
  const [partialInfo, setPartialInfo] = React.useState(null);
  const [verifyMsg, setVerifyMsg] = React.useState(null);
  const [collapsed, setCollapsed] = React.useState(false);
  const currentProposalId = React.useRef(null);
  const scheduledCloses = React.useRef(/* @__PURE__ */ new Set());
  const closeDisposers = React.useRef([]);
  const resetProposalState = () => {
    setBusy(false);
    setUnderstood(false);
    setOutcome(null);
    setRanInfo(null);
    setPartialInfo(null);
    setVerifyMsg(null);
  };
  const doDismiss = (pid) => {
    rpc({ action: "dismiss", sessionId: String(sessionId), proposalId: pid }).then(refresh).catch(refresh);
  };
  const scheduleClose = (pid) => {
    if (scheduledCloses.current.has(pid)) return;
    scheduledCloses.current.add(pid);
    if (timeoutFn) {
      let dispose;
      const close = () => {
        scheduledCloses.current.delete(pid);
        closeDisposers.current = closeDisposers.current.filter((item) => item !== dispose);
        doDismiss(pid);
      };
      dispose = timeoutFn(close, 4e3);
      if (typeof dispose === "function") closeDisposers.current.push(dispose);
    } else {
      scheduledCloses.current.delete(pid);
      doDismiss(pid);
    }
  };
  const refresh = () => {
    rpc({ action: "state", sessionId: String(sessionId) }).then((res) => {
      if (res && res.ok === true) {
        const nextId = res.proposal && res.proposal.proposalId ? res.proposal.proposalId : null;
        if (nextId !== currentProposalId.current) {
          currentProposalId.current = nextId;
          resetProposalState();
        }
        setView(res.proposal);
        if (res.verified === true && res.proposal && res.proposal.proposalId) {
          setRanInfo(res.changedState || "\u68C0\u6D4B\u5230\u9884\u671F\u7ED3\u679C\u5DF2\u8FBE\u6210");
          scheduleClose(res.proposal.proposalId);
        } else if (res.partial === true && res.proposal && res.proposal.proposalId) {
          setPartialInfo({ message: res.message || "\u9884\u671F\u7ED3\u679C\u672A\u8FBE\u6210", state: res.changedState || "" });
        } else if (res.proposal && (res.proposal.status === "succeeded" || res.proposal.status === "verified")) {
          setRanInfo(res.proposal.status === "verified" ? "\u624B\u52A8\u6267\u884C\u7684\u9884\u671F\u7ED3\u679C\u5DF2\u9A8C\u8BC1" : "\u547D\u4EE4\u5DF2\u6267\u884C\u6210\u529F");
          scheduleClose(res.proposal.proposalId);
        } else if (res.proposal && res.proposal.status === "failed") {
          setBusy(false);
          setOutcome((current) => current || {
            ok: false,
            error: "\u8BE5\u63D0\u8BAE\u6267\u884C\u5931\u8D25\uFF1B\u5982\u9700\u91CD\u8BD5\uFF0C\u8BF7\u521B\u5EFA\u65B0\u7684\u63D0\u8BAE",
            steps: (res.proposal?.steps || []).map((step) => ({ command: step.command, ok: !!(step.result && step.result.ok) }))
          });
        } else {
          setPartialInfo(null);
          if (res.message) setVerifyMsg(res.message);
        }
      }
    }).catch((err) => {
      console.log("easygit state \u8C03\u7528\u5931\u8D25", errorText2(err));
    });
  };
  React.useEffect(() => {
    currentProposalId.current = null;
    resetProposalState();
    refresh();
    if (!intervalFn) return void 0;
    const disp = intervalFn(refresh, 1200);
    return () => {
      try {
        if (typeof disp === "function") disp();
      } catch (e) {
      }
    };
  }, [sessionId, intervalFn]);
  React.useEffect(() => () => {
    for (const dispose of closeDisposers.current.splice(0)) {
      try {
        dispose();
      } catch (e) {
      }
    }
  }, []);
  if (!view) {
    return React.createElement(
      "div",
      { className: "gg-dock" },
      React.createElement(
        "div",
        { className: "gg-idle" },
        React.createElement("span", { className: "gg-badge normal" }, "Git \u64CD\u4F5C\u5EFA\u8BAE \xB7 \u7A7A\u95F2"),
        React.createElement("span", { className: "gg-idletext" }, "\u7B49\u5F85\u65B0\u7684 git \u64CD\u4F5C\u63D0\u8BAE\u2026\uFF08git_propose \u767B\u8BB0\u540E\u8FD9\u91CC\u4F1A\u51FA\u73B0\u547D\u4EE4\u4E0E\u6309\u94AE\uFF09")
      )
    );
  }
  const proposal = view;
  const steps = proposal.steps && proposal.steps.length ? proposal.steps : [{ command: proposal.command, result: null }];
  const isHard = proposal.risk === "hard";
  const isCopied = proposal.copied === true;
  const isPending = !proposal.status || proposal.status === "pending";
  const canRun = isPending && !busy && (!isHard || understood);
  const canCopy = isPending && !busy && (!isHard || understood);
  const onRun = () => {
    if (!canRun) return;
    setBusy(true);
    setOutcome(null);
    rpc({ action: "execute", sessionId: String(sessionId), proposalId: proposal.proposalId, confirm: understood }).then((res) => {
      setOutcome(res || { ok: false, error: "\u65E0\u8FD4\u56DE" });
      if (res && res.ok === true) scheduleClose(proposal.proposalId);
    }).catch((err) => {
      setOutcome({ ok: false, error: errorText2(err) });
    }).then(() => setBusy(false));
  };
  const onCopy = () => {
    try {
      const nav = typeof navigator !== "undefined" ? navigator : null;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        const text = steps.map((s) => s.command).join(" && \\\n");
        nav.clipboard.writeText(text).then(() => rpc({ action: "mark-copied", sessionId: String(sessionId), proposalId: proposal.proposalId, confirm: understood })).then((res) => {
          if (!res || res.ok !== true) setVerifyMsg(res && res.error || "\u65E0\u6CD5\u8BB0\u5F55\u590D\u5236\u72B6\u6001");
          refresh();
        }).catch((err) => setVerifyMsg("\u590D\u5236\u5931\u8D25\uFF1A" + errorText2(err)));
      } else setVerifyMsg("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u526A\u8D34\u677F API\uFF0C\u8BF7\u9010\u6761\u9009\u62E9\u547D\u4EE4\u540E\u624B\u52A8\u590D\u5236");
    } catch (e) {
      setVerifyMsg("\u590D\u5236\u5931\u8D25\uFF1A" + errorText2(e));
    }
  };
  const onVerify = () => {
    setVerifyMsg(null);
    setPartialInfo(null);
    rpc({ action: "verify", sessionId: String(sessionId), proposalId: proposal.proposalId }).then((res) => {
      if (res && res.verified === true) {
        setRanInfo(res && res.changedState || "\u68C0\u6D4B\u5230\u9884\u671F\u7ED3\u679C\u5DF2\u8FBE\u6210");
        scheduleClose(proposal.proposalId);
      } else if (res && res.partial === true) {
        setPartialInfo({ message: res.message || "\u9884\u671F\u7ED3\u679C\u672A\u8FBE\u6210", state: res && res.changedState || "" });
      } else {
        setVerifyMsg(res && res.message || "\u672A\u68C0\u6D4B\u5230\u9884\u671F\u7ED3\u679C\uFF0C\u770B\u8D77\u6765\u8FD8\u6CA1\u6709\u6267\u884C");
      }
    }).catch((err) => {
      setVerifyMsg(errorText2(err));
    });
  };
  const riskLabel = isHard ? "\u9AD8\u98CE\u9669" : proposal.risk === "safe" ? "\u5B89\u5168" : "\u5E38\u89C4";
  const badgeCls = isHard ? "gg-badge hard" : proposal.risk === "safe" ? "gg-badge safe" : "gg-badge normal";
  const renderSteps = () => steps.map((s, i) => React.createElement(
    "div",
    { className: "gg-step", key: "step" + i },
    React.createElement("span", { className: "gg-stepnum" }, String(i + 1) + "."),
    React.createElement("code", { className: "gg-stepcode" }, String(s.command))
  ));
  const headerEl = React.createElement(
    "div",
    { className: "gg-head", key: "head" },
    React.createElement("span", null, "Git \u64CD\u4F5C\u5EFA\u8BAE"),
    React.createElement("span", { className: badgeCls }, riskLabel),
    React.createElement(
      "button",
      { className: "gg-btn gg-toggle", onClick: () => setCollapsed(!collapsed), title: collapsed ? "\u5C55\u5F00" : "\u6536\u7F29" },
      collapsed ? "\u25B8" : "\u25BE"
    )
  );
  if (collapsed) {
    return React.createElement("div", { className: "gg-dock gg-dock-full" }, headerEl);
  }
  const lines = [headerEl];
  if (proposal.intent) lines.push(React.createElement("div", { className: "gg-intent", key: "intent" }, String(proposal.intent)));
  lines.push(React.createElement("div", { className: "gg-steps", key: "steps" }, renderSteps()));
  if (proposal.explanation) lines.push(React.createElement("div", { className: "gg-expl", key: "expl" }, String(proposal.explanation)));
  if (ranInfo) {
    lines.push(React.createElement("div", { className: "gg-ok gg-ran", key: "ran" }, "\u2714 \u68C0\u6D4B\u5230\u9884\u671F\u7ED3\u679C\u5DF2\u8FBE\u6210\uFF08\u5DF2\u6267\u884C\uFF09\uFF0C\u5373\u5C06\u5173\u95ED\u6B64\u5EFA\u8BAE"));
    lines.push(React.createElement("pre", { className: "gg-pre", key: "ranstate" }, String(ranInfo)));
    return React.createElement("div", { className: "gg-dock gg-dock-full" }, lines);
  }
  if (partialInfo) {
    lines.push(React.createElement("div", { className: "gg-riskline", key: "pmsg" }, "\u26A0 " + String(partialInfo.message)));
    if (partialInfo.state) lines.push(React.createElement("pre", { className: "gg-pre", key: "pstate" }, String(partialInfo.state)));
    const acts = [];
    acts.push(React.createElement("button", { key: "verify", className: "gg-btn primary", onClick: onVerify }, "\u91CD\u65B0\u68C0\u6D4B"));
    acts.push(React.createElement("button", { key: "drop", className: "gg-btn", onClick: () => doDismiss(proposal.proposalId) }, "\u653E\u5F03\u5EFA\u8BAE"));
    lines.push(React.createElement("div", { className: "gg-actions", key: "actions" }, acts));
    return React.createElement("div", { className: "gg-dock gg-dock-full" }, lines);
  }
  if (isCopied && isPending) {
    lines.push(React.createElement("div", { className: "gg-intent", key: "copied" }, "\u547D\u4EE4\u5DF2\u7528 && \u8FDE\u63A5\u540E\u590D\u5236\uFF0C\u4EFB\u4E00\u6B65\u5931\u8D25\u90FD\u4F1A\u505C\u6B62\u3002\u9762\u677F\u4F1A\u6BD4\u5BF9\u590D\u5236\u524D\u540E\u7684\u76EE\u6807\u72B6\u6001\u3002"));
    if (verifyMsg) lines.push(React.createElement("div", { className: "gg-riskline", key: "vmsg" }, verifyMsg));
    const acts = [];
    acts.push(React.createElement("button", { key: "verify", className: "gg-btn primary", onClick: onVerify }, "\u91CD\u65B0\u68C0\u6D4B"));
    acts.push(React.createElement("button", { key: "drop", className: "gg-btn", onClick: () => doDismiss(proposal.proposalId) }, "\u653E\u5F03\u5EFA\u8BAE"));
    lines.push(React.createElement("div", { className: "gg-actions", key: "actions" }, acts));
    return React.createElement("div", { className: "gg-dock gg-dock-full" }, lines);
  }
  if (proposal.status === "running") {
    lines.push(React.createElement("div", { className: "gg-intent", key: "running" }, "\u547D\u4EE4\u6B63\u5728\u6267\u884C\uFF0C\u8BF7\u52FF\u91CD\u590D\u63D0\u4EA4\u2026"));
  } else if (proposal.status === "failed") {
    lines.push(React.createElement("div", { className: "gg-riskline", key: "failed" }, "\u8BE5\u63D0\u8BAE\u5DF2\u7ECF\u5931\u8D25\u5E76\u9501\u5B9A\u3002\u8BF7\u6839\u636E\u8BCA\u65AD\u521B\u5EFA\u4FEE\u6B63\u63D0\u8BAE\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u91CD\u653E\u3002"));
    lines.push(React.createElement(
      "div",
      { className: "gg-actions", key: "failed-actions" },
      React.createElement("button", { className: "gg-btn", onClick: () => doDismiss(proposal.proposalId) }, "\u5173\u95ED\u5931\u8D25\u63D0\u8BAE")
    ));
  } else if (isPending) {
    if (isHard) {
      lines.push(React.createElement("div", { className: "gg-riskline", key: "risk" }, "\u26A0 " + (proposal.reasons && proposal.reasons.length ? proposal.reasons.join("\uFF1B") : "\u8BE5\u64CD\u4F5C\u98CE\u9669\u8F83\u9AD8\uFF0C\u53EF\u80FD\u9020\u6210\u4E0D\u53EF\u9006\u7684\u6539\u52A8")));
      lines.push(React.createElement(
        "label",
        { className: "gg-check", key: "ck" },
        React.createElement("input", { type: "checkbox", checked: understood, onChange: (e) => setUnderstood(e.target.checked) }),
        React.createElement("span", null, "\u6211\u5DF2\u4E86\u89E3\u98CE\u9669\uFF0C\u786E\u8BA4\u6267\u884C\u6216\u590D\u5236")
      ));
    }
    const actions = [];
    actions.push(React.createElement(
      "button",
      { key: "run", className: "gg-btn " + (isHard ? "danger" : "primary"), disabled: !canRun, onClick: onRun },
      busy ? "\u6267\u884C\u4E2D\u2026" : isHard ? "\u786E\u8BA4\u5E76\u76F4\u63A5\u6267\u884C" : "\u76F4\u63A5\u6267\u884C"
    ));
    actions.push(React.createElement("button", { key: "copy", className: "gg-btn", disabled: !canCopy, onClick: onCopy }, "\u590D\u5236\u547D\u4EE4\uFF08\u624B\u52A8\u6267\u884C\uFF09"));
    lines.push(React.createElement("div", { className: "gg-actions", key: "actions" }, actions));
  }
  if (outcome) {
    const ok = outcome.ok === true;
    const oLines = [];
    if (outcome.error) oLines.push(String(outcome.error));
    if (outcome.stdout) oLines.push(String(outcome.stdout));
    if (outcome.stderr) oLines.push(String(outcome.stderr));
    const text = oLines.join("\n").trim() || "\uFF08\u65E0\u8F93\u51FA\uFF09";
    lines.push(React.createElement(
      "div",
      { className: "gg-out", key: "out" },
      React.createElement("div", { className: ok ? "gg-ok" : "gg-fail" }, ok ? "\u2714 \u6267\u884C\u6210\u529F" : "\u2718 \u6267\u884C\u5931\u8D25"),
      React.createElement("pre", null, text)
    ));
    if (outcome.steps && outcome.steps.length) {
      const stepLines = outcome.steps.map((s, i) => React.createElement(
        "div",
        { className: "gg-stepres", key: "sr" + i },
        React.createElement("span", { className: s.ok ? "gg-ok" : "gg-fail" }, s.ok ? "\u2713" : "\u2717"),
        React.createElement("code", { className: "gg-stepcode" }, String(s.command))
      ));
      lines.push(React.createElement("div", { className: "gg-out", key: "stepsout" }, stepLines));
    }
    if (!ok) {
      if (outcome.diagnostics) lines.push(React.createElement(
        "div",
        { className: "gg-out", key: "diag" },
        React.createElement("div", { className: "gg-intent" }, "\u4ED3\u5E93\u8BCA\u65AD\u4FE1\u606F\uFF1A"),
        React.createElement("pre", null, String(outcome.diagnostics))
      ));
      if (outcome.recovery && outcome.recovery.command) {
        lines.push(React.createElement(
          "div",
          { className: "gg-out gg-recovery", key: "recovery" },
          React.createElement("div", { className: "gg-ok" }, "\u{1F4A1} \u5DF2\u751F\u6210\u4FEE\u6B63\u5EFA\u8BAE" + (outcome.recovery.proposalId ? "\uFF08\u5DF2\u767B\u8BB0\u4E3A\u65B0\u7684\u63D0\u8BAE\uFF0C\u53EF\u76F4\u63A5\u6267\u884C\uFF09" : "")),
          React.createElement("div", { className: "gg-intent" }, String(outcome.recovery.suggestion || "")),
          React.createElement("code", { className: "gg-stepcode" }, String(outcome.recovery.command))
        ));
      } else if (outcome.recovery && outcome.recovery.suggestion) {
        lines.push(React.createElement(
          "div",
          { className: "gg-out gg-recovery", key: "recovery" },
          React.createElement("div", { className: "gg-riskline" }, "\u{1F4A1} " + String(outcome.recovery.suggestion))
        ));
      } else {
        lines.push(React.createElement("div", { className: "gg-intent", key: "hint" }, "\u6267\u884C\u5931\u8D25\u3002\u4F60\u53EF\u4EE5\u63CF\u8FF0\u4E0B\u4E00\u6B65\uFF0C\u6216\u8BA9\u6211\u5206\u6790\u539F\u56E0\u5E76\u7ED9\u51FA\u4FEE\u6B63\u547D\u4EE4\u3002"));
      }
    }
  }
  return React.createElement("div", { className: "gg-dock gg-dock-full" }, lines);
}
var plugin = {
  inject: ["slots", "timer", "layout"],
  apply(ctx) {
    if (typeof ctx.effect === "function") ctx.effect(injectStyles, "easygit: styles");
    else injectStyles();
    const slots = ctx.get("slots");
    if (!slots) return;
    const timer = ctx.get("timer") || ctx.timer;
    const intervalFn = timer && typeof timer.interval === "function" ? timer.interval.bind(timer) : null;
    const timeoutFn = timer && typeof timer.timeout === "function" ? timer.timeout.bind(timer) : null;
    const layout = ctx.get("layout") || ctx.layout;
    const controller = createPanelController({
      slots,
      layout,
      renderPanel: (panelProps) => React.createElement(GitWorkbenchPanel, {
        sessionId: panelProps.sessionId,
        close: panelProps.close,
        intervalFn,
        timeoutFn
      })
    });
    slots.inject("details", () => controller.attachDetails());
    slots.inject("conversation.input.left", () => slots.register(
      { name: "conversation.input.left", id: "git-workbench", order: 30, label: "Git \u5DE5\u4F5C\u53F0" },
      (props) => React.createElement(GitWorkbenchAction, { sessionId: props.sessionId, controller, intervalFn })
    ));
  },
  __testing: {
    createPanelController,
    buildFileTree,
    parseReviewRows,
    renderRawDiffSurface,
    renderReviewSurface,
    injectStyles,
    filterLocalBranches,
    clampWorkbenchRatio,
    deriveCommitGraph,
    repositoryName,
    mutationCommand,
    appendCommandLog,
    refreshButtonLabel,
    isCurrentCommitRequest,
    nextCommitSelection,
    commitFileTone,
    isLatestRequest,
    beginTrackedRequest,
    cancelTrackedRequest,
    isTrackedRequestCurrent
  }
};
module.exports = plugin;
return module.exports; } });
