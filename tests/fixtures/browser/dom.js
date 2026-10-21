// Minimal fake DOM for exercising the real in-page extractor functions offline.
//
// The extractors inside src/browser/{steps,adapters/reads}.js run inside page.evaluate and therefore
// reference `document`, `location`, and `URL`. This fixture installs exactly those globals with a
// selector map, so a test can prove the production extractor produces the fields the adapters need —
// not just the synthetic models the adapter tests inject directly.
//
// Selectors are matched by exact string: the extractors use a fixed, small set. This is not a CSS
// engine and must never grow into one.

class FakeNode {
  constructor({ tag = 'div', attrs = {}, text = '', query = {}, queryAll = {}, closest = {} } = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.text = text;
    this.queryMap = query;
    this.queryAllMap = queryAll;
    this.closestMap = closest;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attrs, name) ? String(this.attrs[name]) : null;
  }

  hasAttribute(name) {
    return Object.hasOwn(this.attrs, name);
  }

  get innerText() {
    return this.text;
  }

  get textContent() {
    return this.text;
  }

  querySelector(selector) {
    return this.queryMap[selector] ?? null;
  }

  querySelectorAll(selector) {
    return this.queryAllMap[selector] ?? [];
  }

  closest(selector) {
    return this.closestMap[selector] ?? null;
  }
}

export function node(options = {}) {
  return new FakeNode(options);
}

export function createDom({
  url = 'https://www.reddit.com/',
  title = 'Reddit',
  bodyText = '',
  query = {},
  queryAll = {},
} = {}) {
  const location = new URL(url);
  const document = {
    title,
    body: { innerText: bodyText },
    querySelector: (selector) => query[selector] ?? null,
    querySelectorAll: (selector) => queryAll[selector] ?? [],
  };
  return { document, location };
}

// Installs the fake globals for one extractor call and always restores them. A returned promise keeps
// the globals installed until it settles, so an async evaluate that runs the extractor is covered too.
export function withDom(dom, fn) {
  const savedDocument = globalThis.document;
  const savedLocation = globalThis.location;
  globalThis.document = dom.document;
  globalThis.location = dom.location;
  const restore = () => {
    globalThis.document = savedDocument;
    globalThis.location = savedLocation;
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    return result.finally(restore);
  }
  restore();
  return result;
}

export default { createDom, node, withDom };
