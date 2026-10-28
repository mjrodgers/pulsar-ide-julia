// Which file changes JETLS wants to hear about (`workspace/didChangeWatchedFiles`).
//
// The fork forwards every change under a project folder by default (`.git` churn, build output, editor backups).
// JETLS registers watchers for exactly these (JETLSCore/src/did-change-watched-files.jl): Julia sources, its
// configuration file, and `.JETLSProfile`, which a developer creates to ask JETLS to profile itself.
const path = require("path");

const WATCHED_NAMES = new Set([".JETLSConfig.toml", ".JETLSProfile"]);

function isWatchedByJetls(filePath) {
  const name = path.basename(String(filePath || ""));
  return name.endsWith(".jl") || WATCHED_NAMES.has(name);
}

module.exports = { isWatchedByJetls, WATCHED_NAMES };
