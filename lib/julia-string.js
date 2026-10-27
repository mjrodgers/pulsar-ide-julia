// A Julia raw string literal for a path. In `raw"..."` only backslashes in front of a quote (or of the closing
// quote) and the quote itself are special: `2n+1` backslashes plus a quote give n backslashes and a literal quote.
const rawString = (p) =>
  `raw"${String(p).replace(/(\\*)"/g, (_, slashes) => `${slashes}${slashes}\\"`).replace(/(\\+)$/, "$1$1")}"`;

module.exports = { rawString };
