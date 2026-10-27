// Where the editor should show the "current line" for a session state: the selected stack frame, only while
// the program is stopped and the frames are known.
function currentLocation(state) {
  if (!state || state.status !== "stopped") return null;
  const frame = state.frames.find((f) => f.id === state.frameId) || state.frames[0];
  if (!frame || !frame.file || !(frame.line >= 1)) return null;
  return { file: frame.file, line: frame.line, frameId: frame.id };
}

module.exports = { currentLocation };
