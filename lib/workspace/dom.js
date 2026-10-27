// A very small hyperscript helper, instead of etch/React: h("div", {class: "x", onclick: fn}, child, "text", [more]).
// `createH(document)` lets specs run it against a fake document.
function createH(doc) {
  const append = (el, children) => {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === "object" ? c : doc.createTextNode(String(c)));
    }
  };
  const h = (tag, props, ...children) => {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "value") el.value = value;
      else if (/^on[a-z]/.test(key) && typeof value === "function") el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    append(el, children);
    return el;
  };
  h.replaceChildren = (el, children) => {
    while (el.firstChild) el.removeChild(el.firstChild);
    append(el, children);
  };
  return h;
}

module.exports = { createH };
