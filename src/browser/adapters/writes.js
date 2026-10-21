// Known rendered-UI write adapters for the modern desktop www.reddit.com surface.
//
// Every one of the 11 write tools is split into a network-free preparation and a single final commit:
//
//   prepare: navigate, verify the canonical target, read the recognized control state, and (for text
//            writes) fill the already-validated fields. Nothing is submitted.
//   commit:  re-verify the account and the canonical target, then perform exactly one final UI action
//            and look for bounded evidence. A definite refusal is FAILED_KNOWN; silence is
//            OUTCOME_UNKNOWN and is never retried here or by another backend.
//
// A state that is already complete (saved item, current vote, joined subreddit, deleted target) is
// reported as a no-change success instead of being toggled the other way. Unfamiliar controls are
// unsupported rather than clicked. The shared write boundary (src/write-boundary.js) owns approval,
// durable admission, spacing, and duplicate checks; these adapters never guard a write themselves.

import { OperationError, OUTCOMES } from '../../errors.js';
import { WRITE_TOOL_NAMES } from '../../operations.js';
import {
  clickControl,
  fillControl,
  findControl,
  readControls,
  redactText,
  scopeSelectorFor,
  securityScreenOf,
} from '../steps.js';

export const BROWSER_WRITE_TOOLS = Object.freeze([...WRITE_TOOL_NAMES]);

const SUBMIT_SPECS = Object.freeze([{ role: 'button', name: /^post$/i }]);
const COMMENT_SPECS = Object.freeze([{ role: 'button', name: /^comment$/i }]);
const EDIT_SAVE_SPECS = Object.freeze([{ role: 'button', name: /^save(?: changes| edit)?$/i }]);
const MENU_SPECS = Object.freeze([{ role: 'button', name: /^(more options|actions|more|overflow menu)$/i }]);
const DELETE_ITEM_SPECS = Object.freeze([
  { role: 'button', name: /^delete$/i },
  { role: 'menuitem', name: /^delete$/i },
]);
const DELETE_CONFIRM_SPECS = Object.freeze([{ role: 'button', name: /^delete (?:post|comment)$/i }]);
const SAVE_SPECS = Object.freeze([{ role: 'button', name: /^(save|saved|unsave)$/i }]);
const JOIN_SPECS = Object.freeze([{ role: 'button', name: /^(join|joined|leave)$/i }]);
const UP_SPECS = Object.freeze([{ role: 'button', name: /^upvote$/i }]);
const DOWN_SPECS = Object.freeze([{ role: 'button', name: /^downvote$/i }]);
const REPLY_SPECS = Object.freeze([{ role: 'button', name: /^reply$/i }]);
const EDIT_ENTRY_SPECS = Object.freeze([{ role: 'button', name: /^edit$/i }]);

const TITLE_SPECS = Object.freeze([{ role: 'textbox', name: /title/i }]);
const BODY_SPECS = Object.freeze([{ role: 'textbox', name: /body|text/i }]);
const LINK_SPECS = Object.freeze([{ role: 'textbox', name: /url|link/i }]);
const COMMENT_FIELD_SPECS = Object.freeze([{ role: 'textbox', name: /add a comment|comment|reply/i }]);
const EDIT_FIELD_SPECS = Object.freeze([{ role: 'textbox', name: /edit|body|text/i }]);

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PREPARED = new WeakMap();

function unsupported(reason, details = {}) {
  return new OperationError('UNSUPPORTED_OPERATION', 'This action does not match a recognized Reddit control. Nothing was clicked.', {
    safeDetails: { reason, ...details },
  });
}

function stale(reason) {
  return new OperationError('STEP_STALE', 'The page no longer matches the prepared operation. Nothing was clicked.', {
    safeDetails: { reason },
  });
}

function preDispatch(error) {
  if (error instanceof OperationError) {
    return new OperationError(error.code, error.message, {
      outcome: OUTCOMES.FAILED_KNOWN,
      retryAfterMs: error.retryAfterMs,
      safeDetails: error.safeDetails,
    });
  }
  return new OperationError('BACKEND_UNAVAILABLE', 'The prepared operation could not be re-verified. Nothing was clicked.', {
    outcome: OUTCOMES.FAILED_KNOWN,
    safeDetails: { reason: 'recheck_failed' },
  });
}

function withFooter(text, footer) {
  return typeof footer === 'string' && footer !== '' ? `${text}${footer}` : text;
}

function usernameKeyOf(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

// Canonical target for a write operation, reduced to the exact page and id that may be touched.
function targetOf(operation) {
  const args = operation.args ?? {};
  const tool = operation.tool;
  if (tool === 'create_post') {
    const subreddit = String(args.subreddit ?? '');
    // Defense in depth: the dispatcher validates this, but a direct adapter call must not build a path
    // from an unchecked value.
    if (!/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) throw unsupported('target_unrecognized');
    return { pageKind: 'submit', subreddit: subreddit.toLowerCase() };
  }
  if (tool === 'subscribe_to_subreddit' || tool === 'unsubscribe_from_subreddit') {
    const subreddit = String(args.subreddit ?? '');
    if (!/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) throw unsupported('target_unrecognized');
    return { pageKind: 'subreddit', subreddit: subreddit.toLowerCase() };
  }
  const fullname = String(args.fullname ?? args.parent ?? '').toLowerCase();
  const id = fullname.replace(/^t[0-9]_/, '');
  if (!/^[a-z0-9]+$/i.test(id)) throw unsupported('target_unrecognized');
  // A comment target has no post id in the operation. Preparation resolves its post page from the
  // account's own comment listing; the comment id is never used as a post id.
  if (fullname.startsWith('t1_')) {
    return { pageKind: 'comment', kind: 't1', targetId: id, commentId: id, canonicalId: null, postId: null, fullname };
  }
  if (fullname !== '' && !fullname.startsWith('t3_')) throw unsupported('target_unrecognized');
  return { pageKind: 'permalink', kind: 't3', targetId: id, canonicalId: id, postId: id, fullname };
}

function targetPath(target) {
  if (target.pageKind === 'submit') return `/r/${target.subreddit}/submit`;
  if (target.pageKind === 'subreddit') return `/r/${target.subreddit}/`;
  if (typeof target.postId === 'string' && target.postId !== '') return `/comments/${target.postId}/`;
  throw unsupported('target_not_located');
}

function validateOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new TypeError('A write operation descriptor is required.');
  }
  if (operation.kind !== 'write') {
    throw new OperationError('UNSUPPORTED_OPERATION', `The browser write adapter cannot run a ${operation.kind ?? 'non-write'} operation.`);
  }
  if (!BROWSER_WRITE_TOOLS.includes(operation.tool)) {
    throw unsupported('write_not_supported', { tool: typeof operation.tool === 'string' ? operation.tool.slice(0, 40) : null });
  }
  const args = operation.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Write arguments must be an object.');
  return operation;
}

function shapeOf(tool, expected) {
  switch (tool) {
    case 'save_content': return { desired: { saved: true } };
    case 'unsave_content': return { desired: { saved: false } };
    case 'subscribe_to_subreddit': return { desired: { joined: true } };
    case 'unsubscribe_from_subreddit': return { desired: { joined: false } };
    case 'vote_on_thing': return { desired: { vote: expected.direction === 'clear' ? 'none' : expected.direction } };
    case 'delete_post':
    case 'delete_comment': return { desired: { deleted: true } };
    default: return { desired: {} };
  }
}

function isSatisfied(tool, controls, desired) {
  if (tool === 'save_content' || tool === 'unsave_content') return controls.saved === desired.saved;
  if (tool === 'subscribe_to_subreddit' || tool === 'unsubscribe_from_subreddit') return controls.joined === desired.joined;
  if (tool === 'vote_on_thing') {
    // An absent aria-pressed state is unknown, not "no vote". Assuming "none" would silently turn a
    // clear request into a no-change success when the control state was simply not observed.
    const current = typeof controls.vote === 'string' ? controls.vote : null;
    return current !== null && current === desired.vote;
  }
  if (tool === 'delete_post' || tool === 'delete_comment') return controls.deleted === true;
  return false;
}

// A toggle whose current state was not observed cannot be clicked: the same control means "set"
// and "unset" depending on that state, and picking a polarity would invert the user's intent. This
// runs before dispatch (and again at commit), so the refusal is a known failure with no click.
function requireKnownToggle(tool, controls) {
  if (tool === 'save_content' || tool === 'unsave_content') {
    if (typeof controls.saved !== 'boolean') throw unsupported('state_unverified', { state: 'saved' });
    return;
  }
  if (tool === 'subscribe_to_subreddit' || tool === 'unsubscribe_from_subreddit') {
    if (typeof controls.joined !== 'boolean') throw unsupported('state_unverified', { state: 'joined' });
    return;
  }
  if (tool === 'vote_on_thing') {
    const vote = controls.vote;
    if (vote !== 'up' && vote !== 'down' && vote !== 'none') throw unsupported('state_unverified', { state: 'vote' });
  }
}

function currentVote(desired, controls) {
  // Clearing needs the vote that is actually pressed now, not the desired end state. Both callers
  // have already required a known vote state.
  if (desired.vote === 'none') return controls.vote === 'down' ? DOWN_SPECS : UP_SPECS;
  return desired.vote === 'down' ? DOWN_SPECS : UP_SPECS;
}

export function createWriteAdapters({ sleep = defaultSleep, pollMs = 250, maxEvidenceAttempts = 4 } = {}) {
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function.');
  if (!Number.isSafeInteger(maxEvidenceAttempts) || maxEvidenceAttempts < 1) {
    throw new TypeError('maxEvidenceAttempts must be a positive whole number.');
  }

  async function verifyPageSecurity(page, controls) {
    // The extractor returns the page title and bounded visible text, so a challenge overlay on an
    // ordinary post URL is detected at commit rather than only via the URL path.
    const screen = securityScreenOf({
      url: page.url(),
      title: typeof controls?.title === 'string' ? controls.title : '',
      security: controls?.security ?? null,
      observationText: typeof controls?.observationText === 'string' ? controls.observationText : '',
    });
    if (screen) {
      throw new OperationError(
        'USER_HANDOFF_REQUIRED',
        'Reddit is showing a sign-in or security screen. Finish it in the visible browser window; nothing was clicked.',
        { safeDetails: { reason: 'security_screen', screen } },
      );
    }
  }

  function assertTarget(prepared, controls) {
    if (prepared.target.pageKind === 'submit' || prepared.target.pageKind === 'subreddit') {
      const shown = typeof controls.subreddit === 'string' ? controls.subreddit.toLowerCase() : null;
      if (prepared.target.subreddit && shown && shown !== prepared.target.subreddit) throw stale('target_changed');
      return;
    }
    const shown = typeof controls.canonicalId === 'string' ? controls.canonicalId.toLowerCase() : null;
    if (!shown) throw stale('target_unverified');
    if (shown !== prepared.target.canonicalId) throw stale('target_changed');
  }

  function clickSpecs(tool, desired, controls) {
    switch (tool) {
      case 'create_post': return SUBMIT_SPECS;
      case 'reply_to_post': return COMMENT_SPECS;
      case 'edit_post':
      case 'edit_comment': return EDIT_SAVE_SPECS;
      case 'save_content':
      case 'unsave_content': return SAVE_SPECS;
      case 'vote_on_thing': return currentVote(desired, controls);
      case 'subscribe_to_subreddit':
      case 'unsubscribe_from_subreddit': return JOIN_SPECS;
      default: return null;
    }
  }

  async function waitForControl(page, specs, scopeSelector, attempts = maxEvidenceAttempts) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const found = await findControl(page, specs, scopeSelector);
      if (found) return found;
      if (attempt < attempts - 1) await sleep(pollMs);
    }
    return null;
  }

  // A comment operation carries only the comment id. Its post page is resolved from the account's own
  // comment listing, never by treating the comment id as a post id.
  async function resolveCommentPost(page, target, ctx) {
    const username = typeof ctx.account?.username === 'string' ? ctx.account.username : null;
    if (!username) {
      throw new OperationError('IDENTITY_UNVERIFIED', 'A comment target needs the verified signed-in account. Nothing was clicked.', {
        safeDetails: { reason: 'identity_unverified' },
      });
    }
    await navigate(page, `/user/${encodeURIComponent(username)}/comments/`);
    const listing = await readControls(page, { focusId: target.targetId, focusKind: 't1' });
    await verifyPageSecurity(page, listing);
    const postId = typeof listing.focus?.postId === 'string' ? listing.focus.postId.toLowerCase() : null;
    if (!postId || !/^[a-z0-9]+$/i.test(postId)) throw unsupported('target_not_located');
    return postId;
  }

  async function prepare(operation, ctx = {}) {
    validateOperation(operation);
    const page = ctx.page;
    if (!page) throw new TypeError('The browser write adapter needs a page.');
    const target = targetOf(operation);
    if (target.pageKind === 'comment') {
      target.postId = await resolveCommentPost(page, target, ctx);
      target.canonicalId = target.postId;
    }
    await navigate(page, targetPath(target));
    const controls = await readControls(page, {
      focusId: target.targetId,
      focusKind: target.kind,
    });
    await verifyPageSecurity(page, controls);
    assertTarget({ tool: operation.tool, target }, controls);
    // A named t1/t3 target must be present and scoped. Without its element, control state can only
    // come from unrelated same-labeled controls (for example a comment's Save or Delete menu).
    if ((target.kind === 't1' || target.kind === 't3') && !controls.focus) throw unsupported('target_not_located');
    requireKnownToggle(operation.tool, controls);

    const args = operation.args ?? {};
    const footer = typeof ctx.footer === 'string' ? ctx.footer : '';
    const desired = shapeOf(operation.tool, { direction: args.direction }).desired;
    const alreadySatisfied = isSatisfied(operation.tool, controls, desired);
    // Both comment and post controls are scoped to the named target, so a write never acts on a
    // same-labeled control for a different thing on the page.
    const scope = target.kind === 't1' || target.kind === 't3'
      ? scopeSelectorFor(target.kind, target.targetId)
      : null;

    let fields = [];
    if (operation.tool === 'create_post') {
      fields = [
        { specs: TITLE_SPECS, value: String(args.title) },
        args.url !== undefined
          ? { specs: LINK_SPECS, value: String(args.url) }
          : { specs: BODY_SPECS, value: withFooter(String(args.text ?? ''), footer) },
      ];
    } else if (operation.tool === 'reply_to_post') {
      fields = [{ specs: COMMENT_FIELD_SPECS, value: withFooter(String(args.text ?? ''), footer) }];
    } else if (operation.tool === 'edit_post' || operation.tool === 'edit_comment') {
      fields = [{ specs: EDIT_FIELD_SPECS, value: withFooter(String(args.text ?? ''), footer) }];
    }

    if (!alreadySatisfied) {
      // A recognized final control must exist before anything is typed. An unfamiliar button is an
      // unsupported variant, never a guess. The delete flow opens a menu first: only its entry point
      // has to exist now, and the item/confirmation are waited for during commit.
      if (operation.tool === 'delete_post' || operation.tool === 'delete_comment') {
        const entry = (await findControl(page, MENU_SPECS, scope))
          || (await findControl(page, DELETE_ITEM_SPECS, scope))
          || (await findControl(page, DELETE_CONFIRM_SPECS, scope));
        if (!entry) throw unsupported('control_not_recognized');
      } else {
        // Replying to a comment first opens that comment's own reply form; opening a form is not a
        // submission. The single final effect is still the guarded commit click.
        if (operation.tool === 'reply_to_post' && target.kind === 't1') {
          await clickControl(page, REPLY_SPECS, scope);
        }
        if (operation.tool === 'edit_comment' && target.kind === 't1') {
          await clickControl(page, EDIT_ENTRY_SPECS, scope);
        }
        const specs = clickSpecs(operation.tool, desired, controls);
        if (specs && !(await findControl(page, specs, scope))) throw unsupported('control_not_recognized');
        const scopedFields = target.kind === 't1'
          && (operation.tool === 'reply_to_post' || operation.tool === 'edit_comment');
        for (const field of fields) {
          await fillControl(page, field.specs, field.value, scopedFields ? scope : null);
        }
      }
    }

    const prepared = Object.freeze({
      backend: 'browser',
      tool: operation.tool,
      policyKey: operation.policyKey,
      target,
      account: {
        username: ctx.account?.username ?? null,
        accountKey: ctx.account?.accountKey ?? null,
      },
      desired,
      expectedText: fields.length > 0 ? fields[fields.length - 1].value : null,
      alreadySatisfied,
    });
    PREPARED.set(prepared, {
      page,
      operation,
      target,
      desired,
      expectedText: prepared.expectedText,
      fields,
      scope,
      fullname: args.fullname ?? args.parent ?? null,
      kind: target.kind,
    });
    return prepared;
  }

  async function navigate(page, path) {
    const url = new URL(path, 'https://www.reddit.com').toString();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      throw new OperationError('BACKEND_UNAVAILABLE', 'The Reddit page could not be opened. Nothing was clicked.', {
        safeDetails: { reason: 'navigation_failed' },
      });
    }
  }

  // Runs before the one final effect. Every failure here means nothing was clicked, so it is a known
  // failure for the durable ledger rather than an uncertain outcome.
  async function recheck(prepared, state, ctx) {
    const identity = typeof ctx.verifyIdentity === 'function' ? await ctx.verifyIdentity() : ctx.account;
    if (!identity || identity.verified === false || !identity.username) {
      throw new OperationError('IDENTITY_UNVERIFIED', 'The account could not be re-verified before the click. Nothing was clicked.', {
        safeDetails: { reason: 'identity_unverified' },
      });
    }
    if (prepared.account.username && usernameKeyOf(identity.username) !== usernameKeyOf(prepared.account.username)) {
      throw new OperationError('IDENTITY_MISMATCH', 'The signed-in account changed before the click. Nothing was clicked.', {
        safeDetails: { reason: 'account_changed' },
      });
    }
    await verifyPageSecurity(state.page, state.controls);
    assertTarget(prepared, state.controls);
    // The control state can re-render between preparation and commit; an unknown toggle is refused
    // here too, before dispatch.
    requireKnownToggle(prepared.tool, state.controls);
  }

  async function evidence(prepared, state, ctx) {
    const controls = state.controls;
    if (typeof controls.refusal === 'string' && controls.refusal.trim() !== '') {
      // A definite on-page refusal is a known failure. A person may need to look at the account or
      // the community, so the canonical public code is USER_HANDOFF_REQUIRED, never a retry hint.
      throw new OperationError(
        'USER_HANDOFF_REQUIRED',
        `Reddit refused this action: ${redactText(controls.refusal, { maxLength: 300 })}`,
        { outcome: OUTCOMES.FAILED_KNOWN, safeDetails: { reason: 'refused' } },
      );
    }
    const plan = PREPARED.get(prepared);
    switch (prepared.tool) {
      case 'create_post': {
        const id = typeof controls.createdId === 'string' && controls.createdId !== '' ? controls.createdId : null;
        if (!id) return null;
        return { data: { id, name: `t3_${id}`, url: typeof controls.createdPermalink === 'string' ? controls.createdPermalink : null } };
      }
      case 'reply_to_post': {
        const created = controls.lastComment;
        if (!created || typeof created !== 'object' || typeof created.id !== 'string' || created.id === '') return null;
        return {
          data: {
            things: [{
              kind: 't1',
              data: {
                id: created.id,
                name: `t1_${created.id}`,
                parent_id: typeof created.parentId === 'string' ? created.parentId : plan.fullname,
                body: typeof created.body === 'string' ? created.body : plan.expectedText,
              },
            }],
          },
        };
      }
      case 'edit_post':
      case 'edit_comment': {
        if (typeof controls.bodyText !== 'string' || controls.bodyText !== plan.expectedText) return null;
        // The written thing is the named target (a comment for edit_comment), not its post page.
        const id = plan.target.targetId;
        return {
          data: {
            things: [{
              kind: plan.kind ?? 't3',
              data: { id, name: `${plan.kind ?? 't3'}_${id}`, body: controls.bodyText },
            }],
          },
        };
      }
      case 'delete_post':
      case 'delete_comment':
        return controls.deleted === true ? { data: {} } : null;
      case 'save_content':
      case 'unsave_content':
        return controls.saved === prepared.desired.saved ? { data: {} } : null;
      case 'vote_on_thing': {
        const vote = typeof controls.vote === 'string' ? controls.vote : null;
        return vote !== null && vote === prepared.desired.vote ? { data: {} } : null;
      }
      case 'subscribe_to_subreddit':
      case 'unsubscribe_from_subreddit':
        return controls.joined === prepared.desired.joined ? { data: {} } : null;
      default:
        return null;
    }
  }

  async function commit(prepared, ctx = {}) {
    const plan = PREPARED.get(prepared);
    if (!plan) throw new TypeError('commitWrite needs a prepared plan from this browser write adapter.');
    const page = plan.page;

    let controls;
    try {
      controls = await readControls(page, {
        focusId: plan.target.targetId,
        focusKind: plan.target.kind,
        expectedText: plan.expectedText,
        accountUsername: prepared.account?.username ?? null,
      });
      await recheck(prepared, { page, controls }, ctx);
    } catch (error) {
      throw preDispatch(error);
    }

    // Only the freshly observed state decides a no-op. A prepare-time flag can be stale: if the item
    // was unsaved elsewhere between prepare and commit, the requested write must still happen.
    if (isSatisfied(prepared.tool, controls, prepared.desired)) {
      return Object.freeze({
        data: { alreadySatisfied: true, changed: false },
        meta: { completeness: 'complete', missingFields: [] },
      });
    }

    // Re-find the final control after the recheck. Its disappearance is a pre-dispatch refusal.
    try {
      if (prepared.tool === 'delete_post' || prepared.tool === 'delete_comment') {
        // The real menu is sequential: open it, then wait for the item, then wait for the
        // confirmation. Opening a menu is not a mutation; only the confirmation deletes.
        if (await findControl(page, MENU_SPECS, plan.scope)) {
          await clickControl(page, MENU_SPECS, plan.scope);
          if (!(await waitForControl(page, DELETE_ITEM_SPECS, plan.scope))) throw unsupported('control_not_recognized');
        }
        await clickControl(page, DELETE_ITEM_SPECS, plan.scope);
        if (!(await waitForControl(page, DELETE_CONFIRM_SPECS, plan.scope))) throw unsupported('control_not_recognized');
        await clickControl(page, DELETE_CONFIRM_SPECS, plan.scope);
      } else {
        const specs = clickSpecs(prepared.tool, prepared.desired, controls);
        if (!specs) throw unsupported('write_not_supported');
        await clickControl(page, specs, plan.scope);
      }
    } catch (error) {
      if (error instanceof OperationError && error.code === 'UNSUPPORTED_OPERATION') throw preDispatch(error);
      // Any transport failure once a click was attempted may have reached Reddit.
      throw error;
    }

    for (let attempt = 0; attempt < maxEvidenceAttempts; attempt += 1) {
      const after = await readControls(page, {
        focusId: plan.target.targetId,
        focusKind: plan.target.kind,
        expectedText: plan.expectedText,
        accountUsername: prepared.account?.username ?? null,
      });
      const result = await evidence(prepared, { page, controls: after }, ctx);
      if (result) {
        return Object.freeze({
          data: result.data,
          meta: { completeness: prepared.tool === 'create_post' || prepared.tool === 'reply_to_post' ? 'complete' : 'complete', missingFields: [] },
        });
      }
      if (attempt < maxEvidenceAttempts - 1) await sleep(pollMs);
    }
    throw new OperationError(
      'OUTCOME_UNKNOWN',
      'The click was sent, but Reddit did not show a completion this profile can verify. It is recorded as uncertain and is not retried.',
      { outcome: OUTCOMES.OUTCOME_UNKNOWN, safeDetails: { reason: 'no_visible_evidence' } },
    );
  }

  return Object.freeze({
    tools: BROWSER_WRITE_TOOLS,
    supports(tool) {
      return BROWSER_WRITE_TOOLS.includes(tool);
    },
    prepare,
    commit,
  });
}
