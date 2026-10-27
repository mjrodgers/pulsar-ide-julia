// Pure Node logic (no Pulsar APIs): the pipe channel, run against the fake server.
const path = require("path");
const { spawn } = require("child_process");
const { encode, createParser } = require("./helpers/rpc");
const { deferred } = require("./helpers/deferred");
const { connectViaPipe, pipePath, withSocketStdio } = require("../lib/channel");

const fakeServer = path.join(__dirname, "fixtures", "fake-server.js");
// ELECTRON_RUN_AS_NODE makes process.execPath behave like `node` inside Pulsar; it is ignored by Node.
const nodeEnv = (extra = {}) => Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }, extra);

describe("pipe channel", () => {
  describe("pipePath", () => {
    it("uses a short socket path under the temp dir on POSIX", () => {
      const p = pipePath({ platform: "linux", tmpdir: "/tmp", pid: 7 });
      expect(p).toMatch(/^\/tmp\/pulsar-jetls-7-\d+\.sock$/);
      expect(p.length).toBeLessThan(100);
    });

    it("uses a named pipe on Windows", () => {
      expect(pipePath({ platform: "win32", pid: 7 })).toMatch(/^\\\\\.\\pipe\\pulsar-jetls-7-\d+$/);
    });

    it("never repeats a path within a session", () => {
      expect(pipePath({ pid: 1 })).not.toBe(pipePath({ pid: 1 }));
    });
  });

  describe("connectViaPipe", () => {
    it("speaks LSP over the socket and ignores non-LSP text on stdout", async () => {
      const { child, socket } = await connectViaPipe((pipe) =>
        spawn(process.execPath, [fakeServer, `--pipe-connect=${pipe}`], { env: nodeEnv({ FAKE_SERVER_NOISE: "1" }) }));

      const reply = deferred();
      socket.on("data", createParser((msg) => { if (msg.id === 1) reply.resolve(msg); }));
      socket.write(encode({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));

      const response = await reply.promise;
      expect(response.result.capabilities.hoverProvider).toBe(true);
      socket.destroy();
      child.kill();
    });

    it("rejects, and says why, when the server exits before connecting", async () => {
      let error;
      try {
        await connectViaPipe(() => spawn(process.execPath, ["-e", "process.exit(3)"], { env: nodeEnv() }));
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(error.message).toContain("exited (code 3");
    });

    it("rejects when the server cannot be started at all", async () => {
      let error;
      try {
        await connectViaPipe(() => spawn("/definitely/not/a/real/jetls", []));
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
    });
  });

  describe("withSocketStdio", () => {
    it("swaps stdin/stdout for the socket and forwards everything else", () => {
      const child = { stdin: "real-in", stdout: "real-out", stderr: "err", pid: 42, kill() { return this.pid; } };
      const wrapped = withSocketStdio(child, "SOCKET");
      expect(wrapped.stdin).toBe("SOCKET");
      expect(wrapped.stdout).toBe("SOCKET");
      expect(wrapped.stderr).toBe("err");
      expect(wrapped.pid).toBe(42);
      expect(wrapped.kill()).toBe(42); // methods stay bound to the real child
    });
  });
});
