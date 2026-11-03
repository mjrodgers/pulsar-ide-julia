// What the notifications say when JETLS cannot start or stops (lib/server/failures.js).
const { explainStartFailure, explainCrash, INSTALL } = require("../lib/server/failures");

describe("JETLS failure messages", () => {
  it("says how to install jetls when it is not found", () => {
    const { title, description } = explainStartFailure({ error: Object.assign(new Error("spawn jetls ENOENT"), { code: "ENOENT" }), exe: "jetls" });
    expect(title).toMatch(/could not find the `jetls` command/);
    expect(description).toContain(INSTALL);
    expect(description).toMatch(/JETLS executable/);
  });

  it("recognises a Julia that is too old", () => {
    const { title, description } = explainStartFailure({
      error: new Error("The server exited (code 1, signal null) before connecting to the pipe."),
      exe: "/u/.julia/bin/jetls",
      stderr: "ERROR: LoadError: JETLS requires Julia 1.12 or later",
    });
    expect(title).toMatch(/newer Julia/);
    expect(description).toContain("requires Julia 1.12");
  });

  it("shows the last lines the server printed when it exits before connecting", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const { title, description } = explainStartFailure({ error: new Error("The server exited (code 1, signal null) before connecting to the pipe."), exe: "jetls", stderr: lines });
    expect(title).toMatch(/stopped before it started/);
    expect(description).toContain("line 19");
    expect(description).not.toContain("line 7\n"); // only the end
  });

  it("falls back to the error and the stdio hint", () => {
    const { description } = explainStartFailure({ error: new Error("EADDRINUSE"), exe: "jetls" });
    expect(description).toMatch(/EADDRINUSE/);
    expect(description).toMatch(/stdio/);
  });

  it("describes a crash with what the server printed last", () => {
    expect(explainCrash({ code: 1, stderr: "ERROR: boom" }).description).toMatch(/code 1[\s\S]*ERROR: boom/);
    expect(explainCrash({ code: 1 }).description).not.toMatch(/printed/);
  });
});

describe("formatting failure messages", () => {
  const { explainFormatFailure } = require("../lib/server/failures");
  const jetlsError = (message, code = -32803) => Object.assign(new Error(message), { code });

  it("says how to install the formatter JETLS could not find", () => {
    const jlfmt = explainFormatFailure(jetlsError("`jlfmt` executable is not found on the `PATH`.Follow this [instruction](https://github.com/domluna/JuliaFormatter.jl#installation)\nto install the `jlfmt` app.\n"));
    expect(jlfmt.kind).toBe("error");
    expect(jlfmt.title).toBe("Julia: could not format, `jlfmt` is not installed");
    expect(jlfmt.description).toContain('Pkg.Apps.add("JuliaFormatter")');
    const runic = explainFormatFailure(jetlsError("`runic.bat` executable is not found on the `PATH`."));
    expect(runic.title).toMatch(/`runic` is not installed/);
    expect(runic.description).toContain('Pkg.Apps.add("Runic")');
    const custom = explainFormatFailure(jetlsError("`myfmt` executable is not found on the `PATH`."));
    expect(custom.description).toContain("myfmt");
  });

  it("explains a formatter that failed, usually on a syntax error", () => {
    const plain = explainFormatFailure(jetlsError("Formatter returned an error. See server logs for details."));
    expect(plain.kind).toBe("warning");
    expect(plain.description).toMatch(/syntax error/);
    expect(plain.description).not.toMatch(/2\.7\.0/);
    const range = explainFormatFailure(jetlsError("Formatter returned an error. See server logs for details. Note that range formatting requires JuliaFormatter v2.7.0 or later."));
    expect(range.description).toMatch(/version 2\.7\.0 or later/);
  });

  it("stays quiet for cancelled requests, and passes other errors on", () => {
    expect(explainFormatFailure(jetlsError("cancelled", -32800))).toBe(null);
    expect(explainFormatFailure(jetlsError("content modified", -32801))).toBe(null);
    expect(explainFormatFailure(null)).toBe(null);
    expect(explainFormatFailure(jetlsError("Custom formatter does not specify `executable`."))).toEqual({
      kind: "error", title: "Julia: could not format", description: "Custom formatter does not specify `executable`.",
    });
  });
});
