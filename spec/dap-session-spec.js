const { startFakeAdapter } = require("./helpers/fake-adapter");
const { DapClient } = require("../lib/dap/client");
const { DapSession } = require("../lib/dap/session");

// Wait until `predicate()` holds, polling real time.
const settled = (session) => () => session.state.status === "stopped" && !session.state.loading && session.state.contexts.length > 0;
const until = async (predicate, what = "condition", ms = 3000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
};

describe("DapSession (against a fake adapter)", () => {
  let server, client, session, states;

  const open = async (options) => {
    server = await startFakeAdapter(options);
    client = new DapClient(await server.connect(), { requestTimeout: 3000 });
    session = new DapSession(client, { logger: { warn() {}, error() {}, debug() {}, info() {} } });
    states = [];
    session.on("state", (s) => states.push(s));
    await until(() => server.adapter, "adapter connection");
  };

  afterEach(async () => {
    if (client) client.close();
    if (server) await server.close();
    client = server = session = undefined;
  });

  it("runs the startup sequence in the right order", async () => {
    await open();
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: false }, breakpoints: new Map([["/work/a.jl", [{ line: 99 }]]]).set("/work/b.jl", []), exceptionFilters: ["error"] });
    // The breakpoint at line 99 makes the fake stop right away; wait for that and check the order.
    await until(settled(session), "stop");
    const cmds = server.adapter.commands();
    expect(cmds.slice(0, 6)).toEqual([
      "initialize", "launch", "setBreakpoints", "setBreakpoints", "setExceptionBreakpoints", "configurationDone",
    ]);
    expect(cmds).toContain("stackTrace");
  });

  it("always states the exception filters, keeping only those the adapter offers", async () => {
    await open({ answerLaunchEarly: true });
    await session.start({ args: { program: "/work/a.jl" } });
    const none = server.adapter.requests.find((r) => r.command === "setExceptionBreakpoints");
    expect(none && none.arguments).toEqual({ filters: [] });
    client.close();
    await server.close();

    await open({ answerLaunchEarly: true });
    await session.start({ args: { program: "/work/a.jl" }, exceptionFilters: ["error", "made-up"] });
    const some = server.adapter.requests.find((r) => r.command === "setExceptionBreakpoints");
    expect(some.arguments).toEqual({ filters: ["error"] });
  });

  it("asks for the threads without arguments when the stop names none", async () => {
    await open({ omitThreadId: true });
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: true } });
    await until(settled(session));
    const threads = server.adapter.requests.find((r) => r.command === "threads");
    expect(threads).toBeDefined();
    expect("arguments" in threads).toBe(false);
    expect(session.state.threadId).toBe(1);
  });

  it("works when the adapter answers launch before configurationDone", async () => {
    await open({ answerLaunchEarly: true });
    await session.start({ args: { program: "/work/a.jl" } });
    expect(session.state.status).toBe("running");
  });

  it("fails start() with the adapter's message when launch is refused", async () => {
    await open({ failLaunch: "no such program" });
    let error;
    try { await session.start({ args: { program: "/nope.jl" } }); } catch (e) { error = e; }
    expect(error && error.message).toBe("no such program");
  });

  it("stops on entry and reads frames, scopes and variables", async () => {
    await open();
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: true } });
    await until(settled(session), "variables");
    const s = session.state;
    expect(s.status).toBe("stopped");
    expect(s.reason).toBe("entry");
    expect(s.frames.map((f) => [f.name, f.file, f.line])).toEqual([["inner", "/work/a.jl", 3], ["outer", "/work/a.jl", 20]]);
    expect(s.frameId).toBe(100);
    expect(s.contexts.map((c) => [c.name, c.lazy])).toEqual([["Local", false], ["Global", true]]);
    expect(s.contexts[0].items.map((v) => [v.name, v.value, v.type, v.ref > 0])).toEqual([
      ["x", "0", "Int64", false], ["v", "[1, 2, 3]", "Vector{Int64}", true], ["s", '"hello"', "String", false],
    ]);
    expect(s.contexts[1].items).toEqual([]); // expensive scope is not loaded until asked for
  });

  it("loads children and expensive scopes on demand", async () => {
    await open();
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: true } });
    await until(settled(session));
    const v = session.state.contexts[0].items.find((i) => i.name === "v");
    expect((await session.loadVariables(v.ref)).map((c) => c.value)).toEqual(["1", "2", "3"]);
    await session.loadScope(session.state.contexts[1].ref);
    expect(session.state.contexts[1].items.map((i) => i.name)).toEqual(["G"]);
    expect(session.state.contexts[1].lazy).toBe(false);
  });

  it("switches frames", async () => {
    await open();
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: true } });
    await until(settled(session));
    await session.selectFrame(101);
    expect(session.state.frameId).toBe(101);
    expect(session.state.contexts[0].items.map((i) => i.name)).toEqual(["y"]);
  });

  it("steps, refreshing the variables each time", async () => {
    await open();
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: true } });
    await until(settled(session));
    const before = states.length;
    await session.stepOver();
    await until(settled(session), "step stop");
    expect(states.slice(before).some((st) => st.status === "running")).toBe(true);
    expect(session.state.frames[0].line).toBe(4);
    expect(session.state.contexts[0].items[0].value).toBe("1");
    await session.stepIn();
    await until(() => settled(session)() && session.state.frames[0].line === 5);
    await session.stepOut();
    await until(() => settled(session)() && session.state.frames[0].line === 6);
    expect(server.adapter.commands().filter((c) => ["next", "stepIn", "stepOut"].includes(c))).toEqual(["next", "stepIn", "stepOut"]);
  });

  it("does nothing when asked to step while running", async () => {
    await open();
    await session.start({ args: { program: "/work/a.jl" } });
    await session.stepOver();
    expect(server.adapter.commands()).not.toContain("next");
  });

  it("ends when the program terminates", async () => {
    await open();
    let ended = 0;
    session.on("ended", () => ended++);
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: true } });
    await until(settled(session));
    await session.continue();
    await until(() => session.state.status === "ended", "end");
    expect(ended).toBe(1);
    expect(session.state.frames).toEqual([]);
  });

  it("stops the program on request and closes the connection", async () => {
    await open();
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: true } });
    await until(settled(session));
    await session.stop();
    expect(session.state.status).toBe("ended");
    expect(server.adapter.commands()).toContain("terminate");
  });

  it("evaluates in the selected frame", async () => {
    await open();
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: true } });
    await until(settled(session));
    expect(await session.evaluate("x + 1")).toEqual({ value: "value of x + 1", type: "String", ref: 0 });
  });

  it("rejects pending requests when the connection drops", async () => {
    await open();
    server.adapter.socket.destroy();
    let error;
    try { await client.request("threads", {}); } catch (e) { error = e; }
    expect(error).toBeDefined();
  });
});
