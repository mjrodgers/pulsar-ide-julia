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

// Stateful, because a block can arrive split across chunks, and a chunk can end in the middle
// of a line: that unfinished line is kept until the rest of it arrives (or until flush()).
// Returns [{ level, text }], with consecutive lines of one level grouped into one message.
function createStderrClassifier() {
  let current = "debug";
  let inBlock = false;
  let afterError = false; // between the end of an Error block and the next block
  let partial = ""; // the start of a line whose end has not arrived yet

  function classifyLines(lines) {
    const groups = [];
    const emit = (level, line) => {
      const last = groups[groups.length - 1];
      if (last && last.level === level) last.text += `\n${line}`;
      else groups.push({ level, text: line });
    };

    for (const line of lines) {
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
  }

  function classify(chunk) {
    const lines = (partial + String(chunk)).split(/\r?\n/);
    partial = lines.pop(); // "" when the chunk ended with a newline
    return classifyLines(lines);
  }

  // Treat an unfinished line as complete (when nothing more has arrived for a while).
  classify.flush = () => {
    const line = partial;
    partial = "";
    return line ? classifyLines([line]) : [];
  };
  classify.hasPartial = () => partial !== "";
  return classify;
}

// JETLS writes to stderr in small chunks, so logging each chunk would split one error and its
// stack trace over dozens of console messages. This collects what arrives within `delay` ms
// and logs it as one message per level: `output(level, text)`.
function createStderrLogger(output, { delay = 100, timers = require("timers") } = {}) {
  const classify = createStderrClassifier();
  let groups = [];
  let timer = null;
  let wroteSinceFlush = false;

  const add = (newGroups) => {
    for (const group of newGroups) {
      const last = groups[groups.length - 1];
      if (last && last.level === group.level) last.text += `\n${group.text}`;
      else groups.push({ level: group.level, text: group.text });
    }
  };

  function flush({ partial = false } = {}) {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    // An unfinished line is held back while more is still arriving, so it is not cut in two.
    if (partial || (!wroteSinceFlush && classify.hasPartial())) add(classify.flush());
    wroteSinceFlush = false;
    const out = groups;
    groups = [];
    for (const { level, text } of out) output(level, text);
    if (classify.hasPartial()) timer = timers.setTimeout(flush, delay);
  }

  return {
    write(chunk) {
      add(classify(chunk));
      wroteSinceFlush = true;
      if (!timer) timer = timers.setTimeout(flush, delay);
    },
    // Log everything now, unfinished line included (when the server stops).
    flush: () => flush({ partial: true }),
    dispose() {
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { createStderrClassifier, createStderrLogger };
