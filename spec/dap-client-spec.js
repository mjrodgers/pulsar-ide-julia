const { PassThrough } = require("stream");
const { DapClient, DapError } = require("../lib/dap/client");
const { encode, createParser } = require("../lib/dap/framing");

// A duplex stream pair: what the client writes appears on `sent`, what we push to `inbound` is read by the client.
const makeStream = () => {
  const inbound = new PassThrough();
  const sent = [];
  const stream = inbound;
  const parse = createParser((m) => sent.push(m));
  stream.write = ((orig) => (chunk) => { if (Buffer.isBuffer(chunk) && chunk.toString("ascii", 0, 15) === "Content-Length:") { parse(chunk); return true; } return orig.call(inbound, chunk); })(stream.write);
  return { stream, sent, push: (m) => inbound.push(encode(m)) };
};
const tick = () => new Promise((r) => setImmediate(r));

describe("DapClient", () => {
  it("matches responses to requests", async () => {
    const { stream, sent, push } = makeStream();
    const client = new DapClient(stream);
    const p = client.request("threads", {});
    expect(sent[0]).toEqual({ seq: 1, type: "request", command: "threads", arguments: {} });
    push({ type: "response", request_seq: 1, success: true, command: "threads", body: { threads: [] } });
    expect(await p).toEqual({ threads: [] });
  });

  it("rejects with the adapter's message on failure", async () => {
    const { stream, push } = makeStream();
    const client = new DapClient(stream);
    const p = client.request("next", {});
    push({ type: "response", request_seq: 1, success: false, command: "next", message: "not stopped" });
    let error;
    try { await p; } catch (e) { error = e; }
    expect(error instanceof DapError).toBe(true);
    expect(error.message).toBe("not stopped");
    expect(error.command).toBe("next");
  });

  it("times out requests that are never answered", async () => {
    const { stream } = makeStream();
    const client = new DapClient(stream, { requestTimeout: 20 });
    let error;
    try { await client.request("threads", {}); } catch (e) { error = e; }
    expect(error && error.message).toMatch(/Timed out/);
  });

  it("delivers events by name and lets listeners unsubscribe", async () => {
    const { stream, push } = makeStream();
    const client = new DapClient(stream);
    const seen = [];
    const off = client.onEvent("output", (b) => seen.push(b.output));
    push({ type: "event", event: "output", body: { output: "a" } });
    await tick();
    off();
    push({ type: "event", event: "output", body: { output: "b" } });
    await tick();
    expect(seen).toEqual(["a"]);
  });

  it("answers reverse requests with a failure", async () => {
    const { stream, sent, push } = makeStream();
    new DapClient(stream);
    push({ type: "request", seq: 7, command: "runInTerminal", arguments: {} });
    await tick();
    expect(sent[0].request_seq).toBe(7);
    expect(sent[0].success).toBe(false);
  });

  it("rejects pending requests and refuses new ones after the stream closes", async () => {
    const { stream } = makeStream();
    const client = new DapClient(stream);
    let closed = 0;
    client.on("close", () => closed++);
    const p = client.request("threads", {});
    stream.destroy();
    let error;
    try { await p; } catch (e) { error = e; }
    expect(error).toBeDefined();
    expect(closed).toBe(1);
    let later;
    try { await client.request("threads", {}); } catch (e) { later = e; }
    expect(later && later.message).toMatch(/closed/);
  });
});
