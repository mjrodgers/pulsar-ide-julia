// Readable notifications for the ways starting or running JETLS goes wrong (as pulsar-ide-python does for pylsp):
// what happened, the last lines JETLS printed, and what to do about it.
const INSTALL = "julia -e 'using Pkg; Pkg.Apps.add(; url=\"https://github.com/aviatesk/JETLS.jl\", rev=\"release\")'";

const tail = (text, lines = 12) => String(text || "").trim().split(/\r?\n/).slice(-lines).join("\n");
const block = (text) => (text ? `\n\n\`\`\`\n${text}\n\`\`\`` : "");

// Starting the server failed. `error`: what connecting or spawning threw; `exe`: the command that was run;
// `stderr`: what it printed before it gave up. Returns {title, description}.
function explainStartFailure({ error, exe, stderr = "" }) {
  const printed = tail(stderr);
  if (error && error.code === "ENOENT") {
    return {
      title: "Julia (JETLS): could not find the `jetls` command",
      description:
        `\`${exe}\` was not found. Install JETLS once with:\n\n\`\`\`\n${INSTALL}\n\`\`\`\n\n` +
        "It goes into `~/.julia/bin`, where this package looks for it. If it lives elsewhere, set " +
        "**Language server → JETLS executable** in the package settings.",
    };
  }
  if (/requires Julia|Julia v?1\.1[01]|UndefVarError: `?@?main/i.test(printed)) {
    return {
      title: "Julia (JETLS): JETLS needs a newer Julia",
      description: `JETLS needs Julia 1.12 or later (1.12.2+ recommended). Install it (with juliaup: \`juliaup add release\`), then reinstall JETLS with it.${block(printed)}`,
    };
  }
  if (/exited|before connecting/i.test(String(error && error.message))) {
    return {
      title: "Julia (JETLS): the server stopped before it started",
      description: `\`${exe}\` exited before it connected to Pulsar. What it printed last:${block(printed) || "\n\n(nothing)"}`,
    };
  }
  return {
    title: "Julia (JETLS): could not connect to the server",
    description:
      `${(error && error.message) || error}${block(printed)}\n\n` +
      "If your `jetls` is older, set **Language server → Communication channel** to `stdio` in the package settings.",
  };
}

// A running server stopped by itself (the language client starts it again, up to a limit).
function explainCrash({ code, stderr = "" }) {
  return {
    title: "Julia (JETLS): the language server stopped",
    description: `It exited with code ${code}; it is started again for open Julia files.${block(tail(stderr)) ? ` What it printed last:${block(tail(stderr))}` : ""}`,
  };
}

module.exports = { explainStartFailure, explainCrash, INSTALL };
