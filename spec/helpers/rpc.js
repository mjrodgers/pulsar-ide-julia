// Minimal LSP base-protocol framing (Content-Length headers), no dependencies.
function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function createParser(onMessage) {
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
      onMessage(JSON.parse(buf.slice(start, start + len).toString("utf8")));
      buf = buf.slice(start + len);
    }
  };
}

module.exports = { encode, createParser };
