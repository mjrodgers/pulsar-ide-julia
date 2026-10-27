// Just enough DOM for the workspace pane's specs (jsdom is not available here). Real Pulsar specs use the real DOM.
class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = {};
    this.value = "";
    this.scrollTop = 0;
    const el = this;
    this.classList = {
      add: (...c) => { const s = el.classes(); c.forEach((x) => s.add(x)); el.className = [...s].join(" "); },
      remove: (...c) => { const s = el.classes(); c.forEach((x) => s.delete(x)); el.className = [...s].join(" "); },
      contains: (c) => el.classes().has(c),
      toggle: (c, force) => { const on = force === undefined ? !el.classes().has(c) : force; el.classList[on ? "add" : "remove"](c); return on; },
    };
    this.className = "";
  }
  classes() { return new Set(this.className.split(/\s+/).filter(Boolean)); }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  replaceChildren(...nodes) { while (this.firstChild) this.removeChild(this.firstChild); nodes.forEach((n) => this.appendChild(n)); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(t) { this.replaceChildren(new FakeText(t)); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (let el = this; el; el = el.parentNode) {
      (el.listeners && el.listeners[type] || []).forEach((fn) => fn(event));
      if (event.cancelBubble) break;
    }
  }
  click() { this.dispatch("click"); }
  focus() { this.focused = true; }
  matches(sel) {
    const m = /^([a-z0-9]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i.exec(sel.trim());
    if (!m) throw new Error(`unsupported selector ${sel}`);
    const [, tag, classes, attr, attrValue] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const c of classes.split(".").filter(Boolean)) if (!this.classes().has(c)) return false;
    if (attr && (this.getAttribute(attr) === null || (attrValue !== undefined && this.getAttribute(attr) !== attrValue))) return false;
    return true;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => el.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

const fakeDocument = () => ({
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (t) => new FakeText(t),
});

module.exports = { fakeDocument, FakeElement };
