// Memory of the JETLS processes: the resident size of a server process plus everything it started (the `jetls`
// launcher may run Julia as a child, and JETLS runs tests in child processes). One `ps` (or PowerShell on Windows)
// call per sample covers every server.
const { execFile } = require("child_process");

// "pid ppid kilobytes" per line -> Map(pid -> {ppid, kb}). Lines that do not parse are skipped.
function parseProcessTable(text) {
  const table = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), kb: Number(m[3]) });
  }
  return table;
}

// Bytes used by `pid` and all its descendants, or null if `pid` is not in the table.
function treeBytes(table, pid) {
  if (!table.has(pid)) return null;
  const children = new Map();
  for (const [p, { ppid }] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(p);
  }
  let kb = 0;
  const seen = new Set();
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    kb += (table.get(p) || { kb: 0 }).kb;
    for (const c of children.get(p) || []) if (c !== p) stack.push(c);
  }
  return kb * 1024;
}

const PS_ARGS = ["-A", "-o", "pid=,ppid=,rss="];
const POWERSHELL_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $([math]::Round($_.WorkingSetSize / 1024))\" }";

function processTableCommand(platform = process.platform) {
  return platform === "win32"
    ? { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT] }
    : { file: "ps", args: PS_ARGS };
}

const runFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

// Map(pid -> bytes | null) for the given pids. On any failure every pid maps to null.
async function sampleMemory(pids, { platform = process.platform, run = runFile } = {}) {
  const out = new Map(pids.map((p) => [p, null]));
  if (pids.length === 0) return out;
  try {
    const { file, args } = processTableCommand(platform);
    const table = parseProcessTable(await run(file, args));
    for (const p of pids) out.set(p, treeBytes(table, p));
  } catch (e) { /* no process listing here: memory shows as unknown */ }
  return out;
}

function formatBytes(bytes) {
  if (bytes == null) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

module.exports = { parseProcessTable, treeBytes, processTableCommand, sampleMemory, formatBytes };
