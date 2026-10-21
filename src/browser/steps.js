// Task-bound browser helpers for the rendered-UI backend.
//
// A task is a server-generated handle bound to one profile, account, operation, target, policy
// generation, visibility, and expiry. Observations are bounded, sanitized, and tied to the latest
// observation id. Steps are a finite allowlist of ordinary preparation actions; nothing here can
// submit, vote, save, delete, subscribe, fetch an arbitrary URL, evaluate arbitrary JavaScript, or
// change an account. A mutation is only ever the logical operation's guarded commit (Task 6/11).
//
// Login, password, 2FA, recovery, and challenge screens are never observed: they return a user
// handoff with no page title, text, or element list, so a secret-entry surface cannot reach a model
// or a log. URLs are reduced to the exact Reddit origin with sensitive query parameters removed.

import { OperationError } from '../errors.js';
import { SORTS } from '../validation.js';

export const REDDIT_ORIGIN = 'https://www.reddit.com';
export const DEFAULT_TASK_TTL_MS = 120_000;
export const DEFAULT_MAX_TASKS = 16;
export const MAX_OBSERVED_ELEMENTS = 100;
export const MAX_OBSERVATION_TEXT = 4_000;

// Steps a host may take. Every one is non-mutating; the mutation steps of a write go through the
// named operation's boundary commit instead.
export const SAFE_STEPS = Object.freeze(['navigate', 'scroll', 'sort', 'expand_branch', 'prepare_field']);
// Names that are explicitly refused rather than "unknown", so an attempt to reach a generic browser
// automation surface gets a precise reason.
export const REFUSED_STEP_NAMES = Object.freeze([
  'click', 'submit', 'vote', 'save', 'subscribe', 'delete', 'edit', 'evaluate', 'eval', 'fetch',
  'request', 'header', 'headers', 'cookie', 'cookies', 'press', 'upload', 'type', 'screenshot',
]);

const SENSITIVE_PARAMS = new Set([
  'token', 'access_token', 'refresh_token', 'code', 'password', 'passwd', 'secret', 'session',
  'sessionid', 'session_id', 'authorization', 'auth', 'cookie', 'otp', 'sso', 'sig', 'signature',
  'state', 'api_key', 'key', 'jwt', 'id_token',
]);
const SECURITY_PATH_RE = /^\/(?:login|register|account\/login|password|recovery|verification|two-factor|2fa)(?:[/?#]|$)/i;
const SECURITY_TEXT_RE = /captcha|are you a (?:human|robot)|verify (?:you are|it'?s) (?:a )?human|two[- ]?factor|verification code|recovery code|unusual (?:activity|traffic)/i;

// Element labels that belong to credential entry. They are dropped from observations even though no
// value is ever copied in the first place.
const SECRET_FIELD_RE = /password|passcode|one[- ]time|verification code|2fa|two[- ]factor|recovery code|authenticator|security code/i;

const FIELD_SPECS = Object.freeze({
  title: Object.freeze([{ role: 'textbox', name: /title/i }]),
  body: Object.freeze([{ role: 'textbox', name: /body|text/i }]),
  url: Object.freeze([{ role: 'textbox', name: /url|link/i }]),
  comment: Object.freeze([{ role: 'textbox', name: /add a comment|comment|reply/i }]),
  edit: Object.freeze([{ role: 'textbox', name: /edit|body|text/i }]),
});
const REFUSED_FIELDS = new Set(['password', 'passwd', 'username', 'otp', 'two_factor', '2fa', 'recovery_code', 'verification_code', 'secret']);

function stale(reason, details = {}) {
  return new OperationError('STEP_STALE', 'This browser task or observation is no longer valid. Take a fresh observation.', {
    safeDetails: { reason, ...details },
  });
}

function unsupported(reason, details = {}) {
  return new OperationError('UNSUPPORTED_OPERATION', 'This browser step is not supported. Use the named Reddit operation instead.', {
    safeDetails: { reason, ...details },
  });
}

export function sanitizeUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.reddit.com' || url.port !== '') return '';
  const safe = new URL(`${url.origin}${url.pathname}`);
  for (const [key, entry] of url.searchParams) {
    const name = key.toLowerCase();
    if (SENSITIVE_PARAMS.has(name) || name.startsWith('utm_')) continue;
    safe.searchParams.append(key, entry);
  }
  return safe.toString();
}

export function redactText(value, { maxLength = MAX_OBSERVATION_TEXT } = {}) {
  if (typeof value !== 'string' || value === '') return '';
  let text = value.slice(0, Math.max(0, maxLength));
  text = text.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]');
  text = text.replace(
    /\b(token|access_token|refresh_token|code|password|passwd|secret|sessionid|session_id|session|authorization|cookie|api_key|otp|jwt|sig|signature|state)\b\s*[=:]\s*("[^"]*"|'[^']*'|[^&\s,;]+)/gi,
    '$1=[redacted]',
  );
  return text;
}

// The browser module returns only this allowlisted subset. Values, cookies, headers, and storage
// state can never be part of an observation even if a caller supplies them.
export function sanitizeObservation(raw) {
  const model = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const elements = [];
  const source = Array.isArray(model.elements) ? model.elements : [];
  for (const element of source) {
    if (elements.length >= MAX_OBSERVED_ELEMENTS) break;
    if (!element || typeof element !== 'object') continue;
    const name = typeof element.name === 'string' ? element.name : '';
    if (element.attributes?.type === 'password' || SECRET_FIELD_RE.test(name)) continue;
    const role = typeof element.role === 'string' ? element.role.slice(0, 32) : '';
    if (!role || !name) continue;
    elements.push({ role, name: redactText(name, { maxLength: 200 }) });
  }
  return {
    url: sanitizeUrl(model.url),
    title: redactText(typeof model.title === 'string' ? model.title : '', { maxLength: 200 }),
    elements,
    text: redactText(typeof model.observationText === 'string' ? model.observationText : ''),
    security: securityScreenOf(model),
  };
}

// Only the screen kind is exposed, never the page. A login form on any Reddit path is a login screen.
export function securityScreenOf(model) {
  const declared = typeof model?.security === 'string' ? model.security.toLowerCase() : '';
  if (declared) {
    if (/two|2fa|otp/.test(declared)) return 'two_factor';
    if (/recovery/.test(declared)) return 'recovery';
    if (/password|passcode/.test(declared)) return 'password';
    if (/captcha|challenge|verify/.test(declared)) return 'challenge';
    return 'login';
  }
  const raw = typeof model?.url === 'string' ? model.url : '';
  let pathname = '';
  try {
    pathname = new URL(raw, REDDIT_ORIGIN).pathname;
  } catch {
    pathname = '';
  }
  if (pathname && SECURITY_PATH_RE.test(pathname)) return 'login';
  if (typeof model?.title === 'string' && /^(sign in|log in|verify it'?s you)/i.test(model.title)) return 'login';
  if (typeof model?.observationText === 'string' && SECURITY_TEXT_RE.test(model.observationText)) return 'challenge';
  return null;
}

function securityHandoff(profileId, screen) {
  return new OperationError(
    'USER_HANDOFF_REQUIRED',
    'Reddit is showing a sign-in or security screen. Finish it in the visible browser window; no page content was read.',
    { safeDetails: { reason: 'security_screen', profileId, screen } },
  );
}

// In-page extractor: executes inside the real page. It only reads role/label pairs and visible text,
// skips credential fields, and is bounded. It is not live-verified; see docs/experiments/browser-ui.md.
const BOUNDED_OBSERVATION = ({ kind }) => {
  const implicitRole = (node) => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'a' && node.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (node.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password') return null;
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'checkbox') return 'checkbox';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return node.getAttribute('role');
  };
  const nodes = Array.from(document.querySelectorAll('[role],a,button,input,textarea,h1,h2,h3')).slice(0, 400);
  const elements = [];
  const labelOf = (node) => String(
    node.getAttribute('aria-label')
      || node.getAttribute('placeholder')
      || node.innerText
      || node.value
      || '',
  ).replace(/\s+/g, ' ').trim().slice(0, 80);
  for (const node of nodes) {
    const role = implicitRole(node);
    const name = labelOf(node);
    if (!role || !name) continue;
    if (/password|passcode|one[- ]time|verification code|2fa|two[- ]factor/i.test(name)) continue;
    elements.push({ role, name });
    if (elements.length >= 100) break;
  }
  return {
    kind: typeof kind === 'string' ? kind : 'page',
    url: String(location.href),
    title: String(document.title || ''),
    elements,
    observationText: String(document.body?.innerText ?? '').slice(0, 4000),
  };
};

export async function extractObservation(page, kind = 'page') {
  if (!page || typeof page.evaluate !== 'function') {
    throw new OperationError('BACKEND_UNAVAILABLE', 'The browser page cannot be observed.', { safeDetails: { reason: 'page_unavailable' } });
  }
  try {
    return await page.evaluate(BOUNDED_OBSERVATION, { kind });
  } catch {
    // Never echo a browser/SDK error: a failed evaluate can contain page text.
    throw new OperationError('BACKEND_UNAVAILABLE', 'The page could not be read safely.', { safeDetails: { reason: 'observation_failed' } });
  }
}

// Fixed scope selectors for a named target. Ids are validated before reaching this helper, so no
// caller-supplied selector text ever reaches Playwright.
export function scopeSelectorFor(kind, id) {
  if (typeof id !== 'string' || !/^[a-z0-9]+$/i.test(id)) return null;
  if (kind === 't1') return `shreddit-comment[thingid="t1_${id}"]`;
  if (kind === 't3') return `shreddit-post[id="t3_${id}"]`;
  return null;
}

function controlRoot(page, scopeSelector) {
  if (!scopeSelector) return page;
  if (!page || typeof page.locator !== 'function') return null;
  return page.locator(scopeSelector);
}

// Shared page helpers used by both adapter modules. The specs are fixed; no caller-supplied selector
// or role ever reaches Playwright. An optional scope selector limits the search to one post/comment,
// so a comment write can never act on the post-level control with the same label.
export async function findControl(page, specs, scopeSelector = null) {
  const root = controlRoot(page, scopeSelector);
  if (!root) return null;
  for (const spec of specs) {
    const locator = root.getByRole(spec.role, { name: spec.name, exact: spec.exact === true });
    if (await locator.count() > 0) return locator.first();
  }
  return null;
}

export async function clickControl(page, specs, scopeSelector = null) {
  const control = await findControl(page, specs, scopeSelector);
  if (!control) throw unsupported('control_not_recognized');
  await control.click();
  return control;
}

export async function fillControl(page, specs, value, scopeSelector = null) {
  const control = await findControl(page, specs, scopeSelector);
  if (!control) throw unsupported('control_not_recognized');
  await control.fill(value);
  return control;
}

export async function gotoReddit(page, target, { timeoutMs = 30_000 } = {}) {
  if (!page || typeof page.goto !== 'function') {
    throw new OperationError('BACKEND_UNAVAILABLE', 'The browser page is not available.', { safeDetails: { reason: 'page_unavailable' } });
  }
  const url = sanitizeUrl(new URL(target, REDDIT_ORIGIN).toString());
  if (!url) throw unsupported('redirect_not_allowed');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch {
    throw new OperationError('BACKEND_UNAVAILABLE', 'The page could not be opened.', { safeDetails: { reason: 'navigation_failed' } });
  }
  return url;
}

// In-page state extractor for writes and commit-time checks. It reports only aria-pressed / aria-label
// facts on recognized controls, the canonical id parsed from the page URL, and bounded evidence that
// the write adapters verify outcomes with. It never returns cookies, tokens, headers, or storage.
//
// Exported for the offline extraction tests. A tree variant that does not expose a state returns null
// for it: callers must refuse an unknown toggle direction rather than click it.
export const BOUNDED_CONTROLS = ({ focusId, focusKind, expectedText, accountUsername } = {}) => {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const textOf = (node) => clean(node?.innerText ?? node?.textContent ?? '');
  const idFrom = (value) => {
    const match = /\/comments\/([a-z0-9]+)/i.exec(String(value ?? ''));
    return match ? match[1].toLowerCase() : null;
  };
  const safeFocus = typeof focusId === 'string' && /^[a-z0-9]+$/i.test(focusId) ? focusId.toLowerCase() : null;
  let focusNode = null;
  if (safeFocus && focusKind === 't1') {
    focusNode = document.querySelector(`shreddit-comment[thingid="t1_${safeFocus}"]`)
      || document.querySelector(`[data-comment-id="${safeFocus}"]`);
  } else if (safeFocus && focusKind === 't3') {
    focusNode = document.querySelector(`shreddit-post[id="t3_${safeFocus}"]`)
      || document.querySelector(`shreddit-post[permalink*="/comments/${safeFocus}"]`);
  }
  // A named t1/t3 target is a hard scope. When its element is not present, the control state is
  // unknown rather than every same-labeled control elsewhere on the page: a comment's Save/Upvote/
  // More options (or its "Delete comment" item) must never be attributed to the post target.
  const focusRequired = focusKind === 't1' || focusKind === 't3';
  const scope = focusNode || (focusRequired ? null : document);
  const controls = scope ? [...scope.querySelectorAll('[aria-label],[role="button"]')] : [];
  const nodeFor = (...names) => {
    const wanted = names.map((name) => name.toLowerCase());
    return controls.find((candidate) => {
      const label = clean(candidate.getAttribute('aria-label') || candidate.innerText || '');
      return wanted.includes(label.toLowerCase());
    }) ?? null;
  };
  const pressed = (node) => {
    if (!node) return undefined;
    const value = node.getAttribute('aria-pressed');
    return value === null ? null : value === 'true';
  };

  const up = nodeFor('upvote');
  const down = nodeFor('downvote');
  const upPressed = pressed(up);
  const downPressed = pressed(down);
  let vote = null;
  if (upPressed === true) vote = 'up';
  else if (downPressed === true) vote = 'down';
  else if (upPressed === false && downPressed === false) vote = 'none';

  let saved = null;
  if (nodeFor('unsave', 'remove from saved')) saved = true;
  else if (nodeFor('saved')) saved = pressed(nodeFor('saved')) === false ? false : true;
  else if (nodeFor('save')) saved = pressed(nodeFor('save')) === null ? null : pressed(nodeFor('save'));

  let joined = null;
  if (nodeFor('leave')) joined = true;
  else if (nodeFor('joined')) joined = pressed(nodeFor('joined')) === false ? false : true;
  else if (nodeFor('join')) joined = pressed(nodeFor('join')) === null ? null : pressed(nodeFor('join'));

  const path = location.pathname;
  const postMatch = /^\/r\/[^/]+\/comments\/([a-z0-9]+)/i.exec(path) || /^\/comments\/([a-z0-9]+)/i.exec(path);
  const canonicalId = postMatch ? postMatch[1].toLowerCase() : null;
  const bodyText = String(document.body?.innerText ?? '').slice(0, 4000);

  const focus = focusNode ? {
    id: safeFocus,
    author: focusNode.getAttribute('author') || null,
    body: textOf(focusNode.querySelector(focusKind === 't1' ? '[slot="comment"]' : '[slot="text-body"]')),
    permalink: focusNode.getAttribute('permalink') || null,
    postId: idFrom(focusNode.getAttribute('permalink')) || idFrom(focusNode.closest?.('shreddit-post')?.getAttribute?.('permalink')) || canonicalId,
  } : null;

  let lastComment = null;
  if (typeof expectedText === 'string' && expectedText !== '') {
    const probe = expectedText.slice(0, 80);
    const comments = [...document.querySelectorAll('shreddit-comment')];
    for (let index = comments.length - 1; index >= 0; index -= 1) {
      const candidate = comments[index];
      const author = candidate.getAttribute('author') || '';
      const body = textOf(candidate.querySelector('[slot="comment"]'));
      const sameAuthor = typeof accountUsername !== 'string' || accountUsername === ''
        || author.toLowerCase() === accountUsername.toLowerCase();
      if (sameAuthor && body.includes(probe)) {
        const id = (candidate.getAttribute('thingid') || candidate.getAttribute('id') || '').replace(/^t1_/, '');
        if (/^[a-z0-9]+$/i.test(id)) lastComment = { id, parentId: candidate.getAttribute('parentid') || null, body };
        break;
      }
    }
  }

  const deletedPattern = /this (?:post|comment) (?:has been |was )?deleted|comment deleted|\[deleted\]|\[removed\]/i;
  const deletedMarker = deletedPattern.test(bodyText);
  // Deletion evidence is scoped to the named target when the page still shows it, so another
  // comment's "[deleted]" on the same page cannot be read as this operation's success. When the
  // target element is absent, a same-page marker is ambiguous (a markup variant), not proof.
  const focusDeleted = focus ? deletedPattern.test(`${focus.body} ${focusNode ? textOf(focusNode) : ''}`) : false;
  let deleted = null;
  if (focusRequired) {
    if (focusNode) deleted = focusDeleted;
    // A deleted post commonly redirects to its subreddit. That is positive evidence for this t3.
    else if (focusKind === 't3' && /^\/r\/[^/]+\/?$/.test(path)) deleted = true;
  } else if (postMatch) {
    deleted = deletedMarker;
  } else if (/^\/r\/[^/]+\/?$/.test(path)) {
    deleted = true;
  }

  const refusalPattern = /too much|not allowed|not permitted|unable to (?:post|comment|save|vote|delete|edit)|something went wrong|can(?:'|no)?t (?:post|comment|save|vote|delete|edit)|does(?:n'| no)t allow|you (?:are|'re) banned|content policy/i;
  const alerts = [...document.querySelectorAll('[role="alert"]')].map(textOf).filter((value) => value !== '');
  let refusal = alerts.find((value) => refusalPattern.test(value)) ?? null;
  if (!refusal) {
    const match = refusalPattern.exec(bodyText);
    if (match) refusal = bodyText.slice(Math.max(0, match.index - 40), match.index + 260);
  }

  const securityMarker = document.querySelector('[data-testid="captcha"]')
    || document.querySelector('iframe[src*="captcha"]')
    || document.querySelector('shreddit-captcha');
  const security = (securityMarker || /captcha|verify (?:you are|it'?s) (?:a )?human|are you a robot|unusual (?:activity|traffic)/i.test(bodyText))
    ? 'challenge'
    : null;

  return {
    canonicalId,
    subreddit: (/^\/r\/([A-Za-z0-9_]+)/.exec(path) ?? [])[1] ?? null,
    saved,
    vote,
    joined,
    deleted,
    focus,
    bodyText: focus ? focus.body : (postMatch ? textOf(document.querySelector('[slot="text-body"]')) || null : null),
    lastComment,
    createdId: canonicalId,
    createdPermalink: canonicalId ? path : null,
    refusal: refusal ? refusal.slice(0, 300) : null,
    security,
    title: String(document.title || '').slice(0, 200),
    observationText: bodyText,
  };
};

export async function readControls(page, options = {}) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new OperationError('BACKEND_UNAVAILABLE', 'The browser page is not available.', { safeDetails: { reason: 'page_unavailable' } });
  }
  let raw;
  try {
    raw = await page.evaluate(BOUNDED_CONTROLS, { kind: 'controls', ...options });
  } catch {
    throw new OperationError('BACKEND_UNAVAILABLE', 'The page state could not be read.', { safeDetails: { reason: 'controls_unreadable' } });
  }
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export function createBrowserTasks({
  clock = () => Date.now(),
  newId = () => `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  ttlMs = DEFAULT_TASK_TTL_MS,
  maxTasks = DEFAULT_MAX_TASKS,
} = {}) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  if (typeof newId !== 'function') throw new TypeError('newId must be a function.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive whole number.');
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1) throw new TypeError('maxTasks must be a positive whole number.');

  const tasks = new Map();
  // Whole-operation registrations. A write can wait for a scheduling slot or a local approval before
  // its page task exists; the session manager must still treat that profile as busy.
  const operations = new Map();

  function now() {
    const value = clock();
    if (!Number.isFinite(value)) throw new TypeError('Task clock must return a finite timestamp.');
    return value;
  }

  function sweep() {
    const at = now();
    for (const task of tasks.values()) {
      if (task.state === 'closed' || task.state === 'expired') continue;
      if (task.expiresAt <= at) {
        task.state = 'expired';
        task.page = null;
        task.observationId = null;
      }
    }
  }

  // A task waiting for the user is still resumable: the handoff instructions tell the user to finish
  // the step and take a fresh observation. Only a closed or expired task rejects every call.
  function requireOpen(taskId) {
    sweep();
    const task = typeof taskId === 'string' ? tasks.get(taskId) : null;
    if (!task) throw stale('task_not_found');
    if (task.state === 'expired') throw stale('expired');
    if (task.state !== 'open' && task.state !== 'handoff') throw stale('task_closed');
    return task;
  }

  function create(context = {}) {
    if (!context || typeof context !== 'object') throw new TypeError('A task context is required.');
    if (typeof context.profileId !== 'string' || context.profileId.length === 0) {
      throw new TypeError('A task needs a profile id.');
    }
    if (!context.operation || typeof context.operation.tool !== 'string' || context.operation.tool.length === 0) {
      throw new TypeError('A task needs an operation with a tool name.');
    }
    if (typeof context.operation.target !== 'string' || context.operation.target.length === 0) {
      throw new TypeError('A task needs an operation target.');
    }
    if (!context.page || typeof context.page !== 'object') throw new TypeError('A task needs a browser page.');
    sweep();
    const active = [...tasks.values()].filter((task) => task.state === 'open' || task.state === 'handoff');
    if (active.length >= maxTasks) {
      throw new OperationError('PROFILE_IN_USE', 'Too many browser tasks are open. Close one before starting another.', {
        safeDetails: { reason: 'task_limit', maxTasks },
      });
    }
    const taskId = String(newId());
    if (tasks.has(taskId)) throw new TypeError('Task ids must be unique.');
    const at = now();
    tasks.set(taskId, {
      taskId,
      profileId: context.profileId,
      accountKey: typeof context.accountKey === 'string' ? context.accountKey : null,
      operation: {
        tool: context.operation.tool,
        target: context.operation.target,
        policyKey: context.operation.policyKey ?? context.operation.tool,
      },
      policyGeneration: Number.isInteger(context.policyGeneration) ? context.policyGeneration : 0,
      credentialGeneration: Number.isInteger(context.credentialGeneration) ? context.credentialGeneration : 0,
      visibility: typeof context.visibility === 'string' ? context.visibility : 'visible',
      page: context.page,
      state: 'open',
      observationId: null,
      createdAt: at,
      expiresAt: at + ttlMs,
    });
    return Object.freeze({ taskId, expiresAt: at + ttlMs });
  }

  async function observe(taskId, { kind = 'page' } = {}) {
    const task = requireOpen(taskId);
    const model = await extractObservation(task.page, kind);
    const screen = securityScreenOf(model);
    if (screen) throw securityHandoff(task.profileId, screen);
    const sanitized = sanitizeObservation(model);
    const observationId = `${taskId}_obs_${String(newId())}`;
    task.state = 'open';
    task.observationId = observationId;
    return Object.freeze({
      observationId,
      taskId,
      kind: typeof kind === 'string' ? kind : 'page',
      url: sanitized.url,
      title: sanitized.title,
      elements: Object.freeze(sanitized.elements),
      text: sanitized.text,
      security: null,
      expiresAt: task.expiresAt,
    });
  }

  async function step(taskId, { observationId, step, args = {} } = {}) {
    const task = requireOpen(taskId);
    if (typeof step !== 'string' || !SAFE_STEPS.includes(step)) {
      throw unsupported('step_not_allowed', { step: typeof step === 'string' ? step.slice(0, 32) : null });
    }
    if (task.observationId === null || observationId !== task.observationId) {
      throw stale('observation_stale');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw unsupported('invalid_step_arguments');

    let result;
    switch (step) {
      case 'navigate': {
        const url = sanitizeUrl(args.url);
        if (!url) throw unsupported('redirect_not_allowed');
        try {
          await task.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch {
          throw new OperationError('BACKEND_UNAVAILABLE', 'The page could not be opened.', { safeDetails: { reason: 'navigation_failed' } });
        }
        result = { url };
        break;
      }
      case 'scroll': {
        const direction = args.direction === 'up' ? 'up' : args.direction === 'down' ? 'down' : null;
        const amount = args.amount === undefined ? 500 : args.amount;
        if (!direction || !Number.isInteger(amount) || amount < 1 || amount > 5_000) throw unsupported('invalid_step_arguments');
        if (!task.page.mouse || typeof task.page.mouse.wheel !== 'function') throw unsupported('control_not_recognized');
        await task.page.mouse.wheel(0, direction === 'down' ? amount : -amount);
        result = { direction, amount };
        break;
      }
      case 'sort': {
        if (!SORTS.includes(args.sort)) throw unsupported('invalid_step_arguments');
        const label = args.sort.charAt(0).toUpperCase() + args.sort.slice(1);
        const control = await findControl(task.page, [{ role: 'link', name: label }, { role: 'button', name: label }]);
        if (!control) throw unsupported('control_not_recognized');
        await control.click();
        result = { sort: args.sort };
        break;
      }
      case 'expand_branch': {
        const ids = Array.isArray(args.commentIds) ? args.commentIds : [];
        if (ids.length === 0 || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !/^[a-z0-9]+$/i.test(id))) {
          throw unsupported('invalid_step_arguments');
        }
        if (typeof task.page.locator !== 'function') throw unsupported('control_not_recognized');
        for (const id of ids) {
          const scope = task.page.locator(`[data-comment-id="${id}"]`);
          if (await scope.count() === 0) throw stale('branch_not_found', { branchId: id });
          const control = scope.getByRole('button', { name: /^load more/i });
          if (await control.count() === 0) throw unsupported('control_not_recognized');
          await control.first().click();
        }
        result = { expanded: [...ids] };
        break;
      }
      case 'prepare_field': {
        const field = typeof args.field === 'string' ? args.field : '';
        if (REFUSED_FIELDS.has(field.toLowerCase())) throw unsupported('field_not_allowed');
        const specs = FIELD_SPECS[field];
        if (!specs) throw unsupported('field_not_allowed');
        if (typeof args.value !== 'string' || args.value.length > 4_000) throw unsupported('invalid_step_arguments');
        await fillControl(task.page, specs, args.value);
        result = { field };
        break;
      }
      default:
        throw unsupported('step_not_allowed');
    }

    task.observationId = null;
    return Object.freeze({ taskId, step, ...result });
  }

  async function handoff(taskId, { reason = 'user_action_required' } = {}) {
    const task = requireOpen(taskId);
    task.state = 'handoff';
    task.observationId = null;
    const headless = task.visibility !== 'visible';
    return Object.freeze({
      taskId,
      profileId: task.profileId,
      state: 'waiting_for_user',
      reason: typeof reason === 'string' ? reason.slice(0, 64) : 'user_action_required',
      visibility: task.visibility,
      instructions: Object.freeze([
        headless
          ? 'Finish this step in the dedicated browser profile. If a visible window is required, reopen the profile visibly (this does not resubmit the operation).'
          : 'Finish this step in the visible Reddit window, then take a fresh observation.',
        'No automatic solve, retry, or alternate route was attempted.',
      ]),
    });
  }

  async function close(taskId) {
    sweep();
    const task = typeof taskId === 'string' ? tasks.get(taskId) : null;
    if (!task) throw stale('task_not_found');
    task.state = 'closed';
    task.page = null;
    task.observationId = null;
    return Object.freeze({ closed: true, taskId });
  }

  function activeTasks() {
    sweep();
    return [...tasks.values()].filter((task) => task.state === 'open' || task.state === 'handoff');
  }

  function activeOperationCount(profileId) {
    return operations.get(profileId) ?? 0;
  }

  function beginOperation(profileId) {
    if (typeof profileId !== 'string' || profileId === '') throw new TypeError('An operation needs a profile id.');
    operations.set(profileId, activeOperationCount(profileId) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const next = activeOperationCount(profileId) - 1;
      if (next > 0) operations.set(profileId, next);
      else operations.delete(profileId);
    };
  }

  return Object.freeze({
    create,
    observe,
    step,
    handoff,
    close,
    closeAll() {
      for (const task of activeTasks()) {
        task.state = 'closed';
        task.page = null;
        task.observationId = null;
      }
      return tasks.size;
    },
    hasActiveTask(profileId) {
      return activeOperationCount(profileId) > 0 || activeTasks().some((task) => task.profileId === profileId);
    },
    activeCount(profileId) {
      return activeOperationCount(profileId) + activeTasks().filter((task) => task.profileId === profileId).length;
    },
    beginOperation,
    hasActiveOperation(profileId) {
      return activeOperationCount(profileId) > 0;
    },
    listActiveTasks() {
      return activeTasks().map((task) => Object.freeze({
        taskId: task.taskId,
        profileId: task.profileId,
        tool: task.operation.tool,
        visibility: task.visibility,
        expiresAt: task.expiresAt,
      }));
    },
  });
}
