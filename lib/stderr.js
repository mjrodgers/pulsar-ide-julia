// JETLS writes ordinary progress to stderr in Julia's logging format:
//
//   ┌ Info: Running JETLS with the following setup:
//   │   Threads.nthreads() = 11
//   └   JETLS_TEST_MODE = false
//
// The fork logs every stderr line at `warn`, which buries real problems in the dev
// console. Classify by the block's level instead: Info/Debug -> debug (shown with
// core.debugLSP), Warning -> warn, Error / uncaught exceptions -> error.
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

  return function classify(chunk) {
    const groups = [];
    const emit = (level, line) => {
      const last = groups[groups.length - 1];
      if (last && last.level === level) last.text += `\n${line}`;
      else groups.push({ level, text: line });
    };

    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === "") {
        if (!inBlock) current = "debug";
        continue;
      }
      const header = headerLevel(line);
      if (header) {
        current = header;
        inBlock = true;
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
      if (/^\s*└/.test(line)) { inBlock = false; current = "debug"; }
    }
    return groups;
  };
}

module.exports = { createStderrClassifier };
