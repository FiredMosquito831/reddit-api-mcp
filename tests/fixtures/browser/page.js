// Synthetic page/accessibility fixtures for the rendered-UI adapters.
//
// These are NOT captured Reddit DOM or a real browser session. They model the small, sanitized shape the
// adapters read: a page URL/title, an accessibility element list, and an extracted data model. The fake
// page implements just the Playwright surface src/browser/{steps,adapters/*}.js use, so every browser
// test runs offline with no Playwright package and no network.

function matches(elementName, spec, exact) {
  const name = String(elementName ?? '');
  if (spec instanceof RegExp) return spec.test(name);
  if (exact === true) return name === String(spec);
  return name.toLowerCase() === String(spec).toLowerCase();
}

function createLocator(elements, role, spec, exact, page, scopeId = null) {
  const matching = () => elements.filter((element) => element.role === role
    && matches(element.name, spec, exact)
    && (scopeId === null || element.scopeId === scopeId)
    && element.present !== false);
  const first = () => matching()[0] ?? null;
  const locator = {
    async count() { return matching().length; },
    first() { return locator; },
    async click() {
      const element = first();
      if (!element) throw new Error('fixture locator: no element to click');
      page.actions.push({ kind: 'click', role, name: element.name, scopeId: element.scopeId ?? null });
      if (typeof element.onClick === 'function') await element.onClick(element, page);
      if (element.pressOnClick === true) element.pressed = true;
    },
    async fill(value) {
      const element = first();
      if (!element) throw new Error('fixture locator: no element to fill');
      page.actions.push({ kind: 'fill', role, name: element.name, value });
      element.filled = value;
    },
    async press(key) {
      page.actions.push({ kind: 'press', role, name: first()?.name ?? null, key });
    },
    async isVisible() { return first() !== null; },
    async isEnabled() { return first() !== null && first().disabled !== true; },
    async innerText() { return first()?.text ?? first()?.name ?? ''; },
    async allInnerTexts() { return matching().map((element) => element.text ?? element.name ?? ''); },
    async getAttribute(name) {
      const element = first();
      if (!element) return null;
      if (name === 'aria-pressed') return String(element.pressed === true);
      if (name === 'disabled') return element.disabled === true ? '' : null;
      return element.attributes?.[name] ?? null;
    },
    async waitFor() { if (!first()) throw new Error('fixture locator: not present'); },
  };
  return locator;
}

export function createFixturePage(model = {}, { evaluate } = {}) {
  const state = { url: model.url ?? 'https://www.reddit.com/', title: model.title ?? 'Reddit' };
  const elements = () => model.elements ?? [];
  const page = {
    model,
    actions: [],
    url() { return state.url; },
    async title() { return state.title; },
    async goto(next) {
      page.actions.push({ kind: 'goto', url: next });
      state.url = next;
      if (typeof model.onGoto === 'function') await model.onGoto(next, page);
    },
    getByRole(role, options = {}) {
      return createLocator(elements(), role, options.name ?? '', options.exact, page);
    },
    locator(selector) {
      // Only the fixed scope templates used by src/browser/{steps,adapters/writes}.js are accepted.
      const match = /^\[data-comment-id="([A-Za-z0-9]+)"\]$/.exec(selector)
        ?? /^shreddit-comment\[thingid="t1_([A-Za-z0-9]+)"\]$/.exec(selector)
        ?? /^shreddit-post\[id="t3_([A-Za-z0-9]+)"\]$/.exec(selector);
      if (!match) throw new Error(`fixture page: unexpected selector ${selector}`);
      const scopeId = match[1];
      return {
        async count() { return elements().filter((element) => element.scopeId === scopeId).length; },
        getByRole(role, options = {}) {
          return createLocator(elements(), role, options.name ?? '', options.exact, page, scopeId);
        },
      };
    },
    mouse: {
      async wheel(dx, dy) { page.actions.push({ kind: 'wheel', dx, dy }); },
    },
    async evaluate(fn, arg) {
      page.actions.push({ kind: 'evaluate', arg });
      if (typeof evaluate === 'function') return await evaluate(fn, arg, page);
      if (arg?.kind === 'controls') {
        return { ...(model.controls ?? {}), canonicalId: model.canonicalId ?? null, security: model.security ?? null };
      }
      if (arg?.kind === 'observation') return model;
      return model;
    },
  };
  return page;
}

export default createFixturePage;
