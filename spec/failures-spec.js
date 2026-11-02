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
