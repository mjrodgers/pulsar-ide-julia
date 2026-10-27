// Debug Adapter Protocol base framing: the same `Content-Length: N\r\n\r\n<json>` as LSP.
function encode(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

// Returns a function to feed chunks of bytes; `onMessage` gets each parsed message.
function createParser(onMessage, onError = () => {}) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const m = /Content-Length: *(\d+)/i.exec(buf.slice(0, sep).toString("ascii"));
      if (!m) { buf = buf.slice(sep + 4); continue; } // skip stray non-protocol output
      const start = sep + 4;
      const len = Number(m[1]);
      if (buf.length < start + len) return;
      const raw = buf.slice(start, start + len).toString("utf8");
      buf = buf.slice(start + len);
      try { onMessage(JSON.parse(raw)); } catch (e) { onError(e, raw); }
    }
  };
}

module.exports = { encode, createParser };
