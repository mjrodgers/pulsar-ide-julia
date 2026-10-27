const { encode, createParser } = require("../lib/dap/framing");

describe("DAP framing", () => {
  it("prefixes the byte length, not the character count", () => {
    const frame = encode({ s: "héllo ✓" });
    const text = frame.toString("utf8");
    const body = JSON.stringify({ s: "héllo ✓" });
    expect(text.startsWith(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`)).toBe(true);
  });

  it("parses several messages from one chunk", () => {
    const got = [];
    const feed = createParser((m) => got.push(m));
    feed(Buffer.concat([encode({ n: 1 }), encode({ n: 2 })]));
    expect(got).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("parses a message delivered one byte at a time, including multibyte characters", () => {
    const got = [];
    const feed = createParser((m) => got.push(m));
    for (const byte of encode({ s: "π ✓ ünï" })) feed(Buffer.from([byte]));
    expect(got).toEqual([{ s: "π ✓ ünï" }]);
  });

  it("skips stray output that is not a protocol header", () => {
    const got = [];
    const feed = createParser((m) => got.push(m));
    feed(Buffer.concat([Buffer.from("warning: something\r\n\r\n"), encode({ ok: true })]));
    expect(got).toEqual([{ ok: true }]);
  });

  it("reports invalid JSON and keeps going", () => {
    const got = [];
    const errors = [];
    const feed = createParser((m) => got.push(m), (e, raw) => errors.push(raw));
    feed(Buffer.from("Content-Length: 3\r\n\r\n{x}"));
    feed(encode({ ok: 1 }));
    expect(errors).toEqual(["{x}"]);
    expect(got).toEqual([{ ok: 1 }]);
  });
});
