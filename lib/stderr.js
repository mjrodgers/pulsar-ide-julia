// JETLS writes ordinary progress to stderr in Julia's logging format:
//
//   ┌ Info: Running JETLS with the following setup:
//   │   Threads.nthreads() = 11
//   └   JETLS_TEST_MODE = false
//
// The fork logs every stderr line at `warn`, which buries real problems in the dev
// console. Classify by the block's level instead: Info/Debug -> debug (shown with
// core.debugLSP), Warning -> warn, Error / uncaught exceptions -> error.
//
// JETLS often logs an `@error` block and then prints the exception itself right after it,
// outside the block, as plain lines:
//
//   ┌ Error: Failed to instantiate package environment; ...
//   └ @ JETLSCore …/full-analysis.jl:1974
//   Unsatisfiable requirements detected for package Hecke [3e1990a7]: …
//
//   Stacktrace:
//    [1] …
//
// Pkg's errors print with no "ERROR:" prefix, so those lines would look like ordinary output
// and be hidden, leaving only the summary. So everything after an Error block, blank lines
// included, stays at error level until the next log block (`┌`) starts.
function headerLevel(line) {
  const m = /^\s*┌\s*(\w+)/.exec(line);
  if (!m) return null;
  switch (m[1].toLowerCase()) {
    case "error": return "error";
    case "warn":
    case "warning": return "warn";
    default: return "debug";
  }
}

// Stateful, because a block can arrive split across chunks. Returns
// [{ level, text }], with consecutive lines of one level grouped into one message.
function createStderrClassifier() {
  let current = "debug";
  let inBlock = false;
  let afterError = false; // between the end of an Error block and the next block

  return function classify(chunk) {
    const groups = [];
    const emit = (level, line) => {
      const last = groups[groups.length - 1];
      if (last && last.level === level) last.text += `\n${line}`;
      else groups.push({ level, text: line });
    };

    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === "") {
        if (!inBlock && !afterError) current = "debug";
        continue;
      }
      const header = headerLevel(line);
      if (header) {
        current = header;
        inBlock = true;
        afterError = false;
      } else if (afterError) {
        current = "error";
      } else if (/^\s*ERROR\b/.test(line) || /^\s*Stacktrace:/.test(line)) {
        current = "error";
        inBlock = false;
      } else if (/^\s*WARNING\b/.test(line)) {
        current = "warn";
        inBlock = false;
      } else if (!/^\s/.test(line) && !/^[│└]/.test(line) && current !== "error") {
        current = "debug"; // an unrelated plain line
      }
      emit(current, line);
      if (inBlock && /^\s*└/.test(line)) {
        afterError = current === "error";
        inBlock = false;
        current = afterError ? "error" : "debug";
      }
    }
    return groups;
  };
}

module.exports = { createStderrClassifier };
