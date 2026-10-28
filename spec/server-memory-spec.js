// Memory sampling for the language servers pane (no real processes involved).
const { parseProcessTable, treeBytes, processTableCommand, sampleMemory, formatBytes } = require("../lib/server/memory");

const PS = [
  "    1     0   1000",
  "  500     1  20000", // the jetls launcher
  "  501   500 400000", // julia, started by it
  "  502   501  50000", // a test run
  "  600     1   7000", // something else
  "garbage line",
  "",
].join("\n");

describe("server memory", () => {
  it("parses a pid/ppid/kilobytes table", () => {
    const t = parseProcessTable(PS);
    expect(t.size).toBe(5);
    expect(t.get(501)).toEqual({ ppid: 500, kb: 400000 });
  });

  it("adds up a process and everything it started", () => {
    const t = parseProcessTable(PS);
    expect(treeBytes(t, 500)).toBe((20000 + 400000 + 50000) * 1024);
    expect(treeBytes(t, 600)).toBe(7000 * 1024);
    expect(treeBytes(t, 999)).toBe(null);
  });

  it("does not loop on a process that is its own parent", () => {
    expect(treeBytes(parseProcessTable("0 0 5\n7 0 1"), 0)).toBe(6 * 1024);
  });

  it("uses ps, or PowerShell on Windows", () => {
    expect(processTableCommand("darwin")).toEqual({ file: "ps", args: ["-A", "-o", "pid=,ppid=,rss="] });
    expect(processTableCommand("win32").file).toBe("powershell.exe");
  });

  it("samples several servers with one listing, and reports unknown when listing fails", async () => {
    let calls = 0;
    const run = async () => { calls++; return PS; };
    const got = await sampleMemory([500, 600, 999], { platform: "linux", run });
    expect(calls).toBe(1);
    expect(got.get(500)).toBe(470000 * 1024);
    expect(got.get(999)).toBe(null);
    const failed = await sampleMemory([500], { run: async () => { throw new Error("no ps"); } });
    expect(failed.get(500)).toBe(null);
    expect((await sampleMemory([], { run })).size).toBe(0);
    expect(calls).toBe(1);
  });

  it("formats sizes", () => {
    expect(formatBytes(null)).toBe("–");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2.2 * 1024 ** 3)).toBe("2.2 GB");
    expect(formatBytes(470000 * 1024)).toBe("459 MB");
  });
});
