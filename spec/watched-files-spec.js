// Which file changes are forwarded to JETLS.
const { isWatchedByJetls } = require("../lib/server/watched-files");

describe("isWatchedByJetls", () => {
  it("passes Julia sources and JETLS's own files", () => {
    for (const p of ["/w/src/a.jl", "C:\\w\\src\\b.jl", "/w/.JETLSConfig.toml", "/w/sub/.JETLSProfile"]) {
      expect(isWatchedByJetls(p)).toBe(true);
    }
  });

  it("drops everything else", () => {
    for (const p of ["/w/.git/index", "/w/Project.toml", "/w/Manifest.toml", "/w/notes.md", "/w/a.jl.bak", "/w/x.jlx", "", null]) {
      expect(isWatchedByJetls(p)).toBe(false);
    }
  });
});
