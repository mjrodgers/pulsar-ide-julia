// When JETLS cannot resolve and instantiate a package environment, it analyzes the package as a script (fewer
// diagnostics), logs the reason to stderr and sends a short warning. This module recognizes both and offers ways to
// fix the environment from a notification, then restarts that folder's server. No Pulsar APIs in here.
//
// What JETLS prints (JETLSCore, analysis/full-analysis.jl, `ensure_instantiated!`):
//
//   ┌ Error: Failed to instantiate package environment;
//   │ …
//   │   env_path = "/Users/me/Oscar/Project.toml"
//   └ @ JETLSCore …/full-analysis.jl:1974
//   <what Pkg printed while resolving>
//   empty intersection between Hecke@0.41.0 and project compatibility 0.41.1 - 0.41
//
//   Stacktrace:
//    …
//
// and the warning (window/showMessage): "Failed to instantiate package environment at <env_path>.\n…".

const path = require("path");

const WARNING_PREFIX = "Failed to instantiate package environment at ";
const REASON_LINES = 12;

// The Project.toml path from JETLS's warning, or null for any other message.
function envPathFromWarning(message) {
  const first = String(message || "").split(/\r?\n/)[0];
  if (!first.startsWith(WARNING_PREFIX)) return null;
  const rest = first.slice(WARNING_PREFIX.length).replace(/\.\s*$/, "");
  return rest || null;
}

// The value of a Julia string literal as `repr` prints it ("…" with \\, \", \$, \n, \t escaped).
function parseJuliaString(literal) {
  const m = /^"(.*)"$/.exec(String(literal).trim());
  if (!m) return null;
  return m[1].replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t" })[c] || c);
}

// Follows JETLS's stderr (the lines of error-level messages, in order) and calls onFailure({ envPath, reason }) for
// each failed instantiation: `reason` is what was printed between the error block and the stack trace.
function createFailureWatcher(onFailure) {
  let capture = null; // { envPath, inBlock, reason: [] }

  const finish = () => {
    if (capture && capture.envPath) onFailure({ envPath: capture.envPath, reason: capture.reason.join("\n") });
    capture = null;
  };

  return function feed(text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (/^\s*┌/.test(line)) {
        finish();
        if (/Failed to instantiate package environment/.test(line)) capture = { envPath: null, inBlock: true, reason: [] };
        continue;
      }
      if (!capture) continue;
      if (capture.inBlock) {
        const env = /env_path\s*=\s*(".*")\s*$/.exec(line);
        if (env) capture.envPath = parseJuliaString(env[1]);
        if (/^\s*└/.test(line)) capture.inBlock = false;
      } else if (/^\s*Stacktrace:/.test(line)) {
        finish();
      } else if (line.trim() !== "") {
        capture.reason.push(line);
      }
    }
  };
}

// The end of a failure's reason, short enough for a notification.
function shortReason(reason, lines = REASON_LINES) {
  return String(reason || "").split(/\r?\n/).filter((l) => l.trim() !== "").slice(-lines).join("\n");
}

// A dependency whose version in the environment is outside what the project now allows, so resolving cannot keep it
// (after switching to a branch that raised a compat bound, for example):
//   "empty intersection between Hecke@0.41.0 and project compatibility 0.41.1 - 0.41"
//   "empty intersection between Hecke@0.41.0 (recorded in the manifest) and project compatibility …"
//   "empty intersection between Hecke@0.41.0 (version of the developed package at ~/Hecke) and project compatibility …"
// `Pkg.resolve()`, which is what JETLS runs, keeps the versions recorded in the manifest; `Pkg.update` moves them.
// The part in brackets (newer Pkg versions only) says where the version comes from.
function fixedPackageFrom(reason) {
  const m = /empty intersection between ([A-Za-z_][A-Za-z0-9_]*)@(\S+?)(?: \(([^)]*)\))? and (?:project|workspace) compatibility (.+)/.exec(String(reason || ""));
  if (!m) return null;
  const origin = m[3] || null;
  // Only a developed package, one from a git repository, or a pinned one cannot be moved by Pkg.update.
  const notFromRegistry = !!origin && /developed package|package from|pinned/.test(origin);
  return { name: m[1], version: m[2], origin, compat: m[4].trim(), notFromRegistry };
}

// What the notification offers: [{ id, title, progress, code }]. `code` runs with `--project=<environment>`; an
// action without `code` only restarts the server (for when the user fixed the environment themselves).
function recoveryActions(reason) {
  const retry = { id: "retry", title: "Retry", progress: "Restarting the language server" };
  const updateAll = {
    id: "update",
    title: "Update all packages and retry",
    progress: "Updating all packages (Pkg.update)",
    code: "using Pkg; Pkg.update(); Pkg.instantiate()",
  };
  const fixed = fixedPackageFrom(reason);
  if (fixed && fixed.notFromRegistry) {
    return [
      {
        id: "free",
        title: `Use released ${fixed.name} and retry`,
        progress: `Switching ${fixed.name} to its released version`,
        code: `using Pkg; Pkg.free("${fixed.name}"); Pkg.update("${fixed.name}"); Pkg.instantiate()`,
      },
      retry,
    ];
  }
  if (fixed) {
    // Pkg names only the first dependency it finds out of range. After a branch switch there are usually several
    // (Oscar: AlgebraicSolving and AbstractAlgebra), so updating everything, as `]up` does, comes first.
    return [
      updateAll,
      {
        id: "update-one",
        title: `Update ${fixed.name} and retry`,
        progress: `Updating ${fixed.name}`,
        // Updates the registry first, as `]up` does; other packages move only as far as this one needs.
        code: `using Pkg; Pkg.update("${fixed.name}"); Pkg.instantiate()`,
      },
      retry,
    ];
  }
  return [
    {
      id: "registry",
      title: "Update registry and retry",
      progress: "Updating the package registry and resolving",
      code: "using Pkg; Pkg.Registry.update(); Pkg.resolve(); Pkg.instantiate()",
    },
    updateAll,
    retry,
  ];
}

// The notification's text (Markdown): what happened, the reason, and what the buttons do.
function describeFailure({ reason }) {
  const parts = [
    "JETLS could not resolve and instantiate this environment, so the package is analyzed as a script and some " +
      "diagnostics may be missing.",
  ];
  const short = shortReason(reason);
  parts.push(short ? "```\n" + short + "\n```" : "The full error is in the developer console (**View → Developer → Toggle Developer Tools**).");
  const fixed = fixedPackageFrom(reason);
  if (fixed && fixed.notFromRegistry) {
    parts.push(
      `\`${fixed.name}\` is at ${fixed.version} (${fixed.origin}), but the project needs ${fixed.compat}. Updating ` +
        `does not move it. Either update it yourself (for a developed package, \`git pull\` in its folder) and ` +
        `choose **Retry**, or switch to the released \`${fixed.name}\`.`
    );
  } else if (fixed) {
    parts.push(
      `The environment has \`${fixed.name}\` ${fixed.version}, but the project now needs ${fixed.compat} (as after ` +
        `switching to a branch that requires a newer version). JETLS only resolves, which keeps the versions already ` +
        `in the manifest, so it has to be updated. Pkg names only the first package it finds out of range; ` +
        `after a branch switch others usually are too, so **Update all packages** (\`]up\`) is the surer choice. ` +
        `**Update ${fixed.name}** updates only it and what it needs.`
    );
  } else {
    parts.push(
      "**Update registry and retry** fetches the newest package registry, then resolves without upgrading anything " +
        "else: this fixes a project that needs versions released since the registry was last updated. " +
        "**Update all packages** also upgrades every dependency to its newest allowed version (`]up`)."
    );
  }
  return parts.join("\n\n");
}

// Arguments for `julia` running an action's code in the environment of `envPath` (a Project.toml or its folder).
function actionArgs(envPath, code) {
  const dir = /\.toml$/i.test(envPath) ? path.dirname(envPath) : envPath;
  return ["--startup-file=no", `--project=${dir}`, "-e", code];
}

// The command a user can run instead, shown when an action fails.
function actionCommand(envPath, code) {
  const [, project] = actionArgs(envPath, code);
  return `julia ${project.includes(" ") ? `"${project}"` : project} -e '${code}'`;
}

module.exports = {
  envPathFromWarning, parseJuliaString, createFailureWatcher, shortReason, fixedPackageFrom, recoveryActions,
  describeFailure, actionArgs, actionCommand,
};
