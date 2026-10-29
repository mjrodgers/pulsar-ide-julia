// Case-insensitive subsequence match, the same loose matching people expect from a fuzzy filter.
function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = String(text).toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
}

module.exports = { fuzzyMatch };
