import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPERATION_DESCRIPTORS,
  REDDIT_TOOL_NAMES,
  WRITE_OPERATION_DESCRIPTORS,
  WRITE_TOOL_NAMES,
  describeOperation,
} from '../src/operations.js';
import { OPERATION_ERROR_CODES, OUTCOMES, OperationError, isOperationErrorCode } from '../src/errors.js';
import { VOTE_DIRECTIONS } from '../src/validation.js';

const ALL_WRITES = [
  'create_post',
  'reply_to_post',
  'edit_post',
  'edit_comment',
  'delete_post',
  'delete_comment',
  'save_content',
  'unsave_content',
  'vote_on_thing',
  'subscribe_to_subreddit',
  'unsubscribe_from_subreddit',
];

test('the inventory lists 32 unique, frozen tool names and 11 frozen write names', () => {
  assert.equal(REDDIT_TOOL_NAMES.length, 32);
  assert.equal(new Set(REDDIT_TOOL_NAMES).size, 32);
  assert.ok(Object.isFrozen(REDDIT_TOOL_NAMES));
  assert.deepEqual(WRITE_TOOL_NAMES, ALL_WRITES);
  assert.ok(Object.isFrozen(WRITE_TOOL_NAMES));
  assert.deepEqual(Object.keys(WRITE_OPERATION_DESCRIPTORS), ALL_WRITES);
  assert.deepEqual(Object.keys(OPERATION_DESCRIPTORS).sort(), [...REDDIT_TOOL_NAMES].sort());
  assert.equal(
    Object.values(OPERATION_DESCRIPTORS).filter((descriptor) => descriptor.kind === 'write').length,
    11,
  );
});

test('every descriptor is frozen, keyed by its own tool name, and uses that exact tool as its policy key', () => {
  for (const tool of REDDIT_TOOL_NAMES) {
    const descriptor = OPERATION_DESCRIPTORS[tool];
    assert.ok(Object.isFrozen(descriptor), `${tool} descriptor should be frozen`);
    assert.equal(descriptor.tool, tool);
    assert.equal(descriptor.policyKey, tool);
    assert.ok(['read', 'write', 'offline', 'rss'].includes(descriptor.kind));
  }
});

test('offline and RSS descriptions need no profile, credentials, or settings', () => {
  const explain = describeOperation('reddit_explain', { term: 'Karma' });
  assert.equal(explain.kind, 'offline');
  assert.equal(explain.requiresIdentity, false);
  assert.deepEqual(explain.args, { term: 'Karma' });
  assert.equal(explain.target, 'term:karma');

  const rss = describeOperation('browse_subreddit_rss', { subreddit: 'node', sort: 'new', limit: 5 });
  assert.equal(rss.kind, 'rss');
  assert.equal(rss.requiresIdentity, false);
  assert.deepEqual(rss.args, { subreddit: 'node', sort: 'new', limit: 5 });
  assert.equal(rss.target, 'r/node');
});

test('an operation description is validated, frozen, and never performs backend work', () => {
  const operation = describeOperation('browse_subreddit', { subreddit: 'node', limit: 5 });
  assert.deepEqual(operation, {
    tool: 'browse_subreddit',
    action: 'feed',
    kind: 'read',
    policyKey: 'browse_subreddit',
    target: 'r/node',
    requiresIdentity: false,
    args: { subreddit: 'node', limit: 5 },
  });
  assert.ok(Object.isFrozen(operation));
  assert.ok(Object.isFrozen(operation.args));
  assert.throws(() => {
    operation.args.limit = 99;
  }, TypeError);
});

test('invalid tool input throws before anything else can run', () => {
  assert.throws(() => describeOperation('browse_subreddit', { subreddit: '../admin' }), /Not a valid subreddit/);
  assert.throws(() => describeOperation('browse_subreddit', { subreddit: 'node', sort: 'best' }), /Sort must be/);
  assert.throws(() => describeOperation('browse_subreddit', { subreddit: 'node', limit: 500 }), /between 1 and 100/);
  assert.throws(() => describeOperation('browse_subreddit', { subreddit: 'node', after: '  ' }), /after cursor/);
  assert.throws(() => describeOperation('search_reddit', { query: 'x', limit: 101 }), /between 1 and 100/);
  assert.throws(() => describeOperation('search_reddit', { query: 'x', sort: 'newest' }), /Search sort/);
  assert.throws(() => describeOperation('search_reddit', {}), /search query/);
  assert.throws(() => describeOperation('get_user_info', { username: 'a' }), /username/);
  assert.throws(() => describeOperation('get_post_comments', { post_id: 'abc', depth: 11 }), /Depth must be/);
  assert.throws(() => describeOperation('get_post_comments', { post_id: '../etc' }), /Not a valid Reddit id/);
  assert.throws(() => describeOperation('vote_on_thing', { fullname: 't3_abc', direction: 'toString' }), /Direction/);
  assert.throws(() => describeOperation('create_post', { subreddit: 'node', title: ' ' }), /title is required/);
  assert.throws(() => describeOperation('create_post', { subreddit: 'node', title: 'x', url: 'ftp://x' }), /http/);
  assert.throws(() => describeOperation('create_post', { subreddit: 'node', title: 'x', text: 'a', url: 'https://e.com' }), /exactly one/);
});

test('edit and delete keep posts and comments apart by the exact tool name', () => {
  const editPost = describeOperation('edit_post', { fullname: 't3_abc', text: 'x' });
  const editComment = describeOperation('edit_comment', { fullname: 't1_abc', text: 'x' });
  const deletePost = describeOperation('delete_post', { fullname: 't3_abc' });
  const deleteComment = describeOperation('delete_comment', { fullname: 't1_abc' });
  assert.equal(editPost.policyKey, 'edit_post');
  assert.equal(editComment.policyKey, 'edit_comment');
  assert.equal(deletePost.policyKey, 'delete_post');
  assert.equal(deleteComment.policyKey, 'delete_comment');
  assert.notEqual(editPost.policyKey, editComment.policyKey);
  assert.notEqual(deletePost.policyKey, deleteComment.policyKey);
  assert.equal(editPost.args.kind, 't3');
  assert.equal(editComment.args.kind, 't1');
  assert.throws(() => describeOperation('edit_post', { fullname: 't1_abc', text: 'x' }), /Expected a Reddit fullname/);
  assert.throws(() => describeOperation('edit_comment', { fullname: 't3_abc', text: 'x' }), /Expected a Reddit fullname/);
  assert.throws(() => describeOperation('delete_post', { fullname: 't1_abc' }), /Expected a Reddit fullname/);
  assert.throws(() => describeOperation('delete_comment', { fullname: 't3_abc' }), /Expected a Reddit fullname/);
});

test('save/unsave and subscribe/unsubscribe are distinct policy keys with distinct outcomes', () => {
  const save = describeOperation('save_content', { fullname: 't3_abc' });
  const unsave = describeOperation('unsave_content', { fullname: 't3_abc' });
  const subscribe = describeOperation('subscribe_to_subreddit', { subreddit: 'node' });
  const unsubscribe = describeOperation('unsubscribe_from_subreddit', { subreddit: 'node' });
  assert.notEqual(save.policyKey, unsave.policyKey);
  assert.notEqual(subscribe.policyKey, unsubscribe.policyKey);
  assert.equal(save.args.undo, false);
  assert.equal(unsave.args.undo, true);
  assert.equal(subscribe.args.subscribe, true);
  assert.equal(unsubscribe.args.subscribe, false);
  assert.notEqual(save.contentHash, unsave.contentHash);
  assert.notEqual(subscribe.contentHash, unsubscribe.contentHash);
});

test('write targets and content hashes are canonical and deterministic', () => {
  const first = describeOperation('create_post', { subreddit: 'Node', title: 'Hi', text: 'Body' });
  const second = describeOperation('create_post', { subreddit: 'Node', title: 'Hi', text: 'Body' });
  assert.equal(first.target, 'r/node');
  assert.match(first.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.target, second.target);

  const withFooter = describeOperation('create_post', { subreddit: 'Node', title: 'Hi', text: 'Body' }, { botFooter: '\n-- bot' });
  assert.notEqual(withFooter.contentHash, first.contentHash);

  const reply = describeOperation('reply_to_post', { parent: 't1_ABC', text: 'Hi' });
  assert.equal(reply.target, 't1_abc');
  assert.match(reply.contentHash, /^[0-9a-f]{64}$/);

  const vote = describeOperation('vote_on_thing', { fullname: 'T3_ABC', direction: 'up' });
  assert.equal(vote.target, 't3_abc');
  assert.match(vote.contentHash, /^[0-9a-f]{64}$/);
  assert.notEqual(vote.contentHash, describeOperation('vote_on_thing', { fullname: 't3_abc', direction: 'down' }).contentHash);

  const remove = describeOperation('delete_post', { fullname: 't3_ABC' });
  assert.equal(remove.target, 't3_abc');
  assert.equal(remove.contentHash, null);
});

test('post references accept fullnames, bare ids, and Reddit links and reduce to one canonical target', () => {
  for (const post_id of ['abc123', 't3_abc123', 'https://www.reddit.com/r/node/comments/abc123/x/']) {
    const operation = describeOperation('get_reddit_post', { post_id });
    assert.equal(operation.target, 't3_abc123');
    assert.equal(operation.args.id, 'abc123');
    assert.equal(operation.args.limit, 1);
  }
  const linked = describeOperation('get_post_comments', { post_id: 'https://old.reddit.com/r/node/comments/abc123/x/' });
  assert.equal(linked.args.subreddit, 'node');
});

test('tool arguments are converted to action-native names', () => {
  assert.deepEqual(
    describeOperation('get_more_comments', { post_id: 't3_abc', comment_ids: ['t1_x', 'y'] }).args,
    { postFullname: 't3_abc', childIds: ['t1_x', 'y'] },
  );
  assert.deepEqual(
    describeOperation('browse_subreddit', { subreddit: 'node', include_info: true }).args,
    { subreddit: 'node', includeInfo: true },
  );
  assert.deepEqual(describeOperation('get_reddit_post', { post_id: 'abc' }).args, { id: 'abc', limit: 1 });
  assert.deepEqual(describeOperation('get_post_comments', { post_id: 'abc', sort: 'top' }).args, {
    id: 'abc',
    sort: 'top',
  });
  assert.deepEqual(describeOperation('get_user_posts', { username: 'bob', limit: 2 }).args, {
    username: 'bob',
    options: { limit: 2 },
  });
  assert.deepEqual(describeOperation('get_my_saved', { limit: 2, after: 'c1' }).args, { limit: 2, after: 'c1' });
});

test('validated arguments are deep-frozen and never alias caller input', () => {
  const ids = ['t1_ok'];
  const more = describeOperation('get_more_comments', { post_id: 't3_abc', comment_ids: ids });
  assert.deepEqual(more.args.childIds, ['t1_ok']);
  assert.ok(Object.isFrozen(more.args.childIds));
  assert.throws(() => {
    more.args.childIds.push('../../etc');
  }, TypeError);
  ids.push('../../etc');
  assert.deepEqual(more.args.childIds, ['t1_ok'], 'mutating the input array must not change the operation');

  for (const tool of ['get_user_posts', 'get_user_comments']) {
    const operation = describeOperation(tool, { username: 'bob', limit: 2 });
    assert.ok(Object.isFrozen(operation.args.options), `${tool} options should be frozen`);
    assert.throws(() => {
      operation.args.options.limit = 99;
    }, TypeError);
    assert.equal(operation.args.options.limit, 2);
  }
});

test('the shared vote direction table is frozen so validation and the wire value cannot diverge', () => {
  assert.ok(Object.isFrozen(VOTE_DIRECTIONS));
  assert.deepEqual(VOTE_DIRECTIONS, { up: 1, down: -1, clear: 0 });
  assert.throws(() => {
    VOTE_DIRECTIONS.up = -1;
  }, TypeError);
  assert.equal(VOTE_DIRECTIONS.up, 1);
});

test('identity requirements cover account reads, self lists, and every write', () => {
  for (const tool of ALL_WRITES) {
    const args = tool === 'create_post'
      ? { subreddit: 'node', title: 'x', text: 'y' }
      : tool === 'reply_to_post'
        ? { parent: 't3_abc', text: 'y' }
        : tool === 'subscribe_to_subreddit' || tool === 'unsubscribe_from_subreddit'
          ? { subreddit: 'node' }
          : tool === 'vote_on_thing'
            ? { fullname: 't3_abc', direction: 'up' }
            : { fullname: tool.startsWith('edit') || tool.startsWith('delete') ? `t${tool.endsWith('comment') ? 1 : 3}_abc` : 't3_abc', text: 'y' };
    assert.equal(describeOperation(tool, args).requiresIdentity, true, tool);
  }
  for (const tool of ['get_me', 'get_my_overview', 'get_my_saved', 'list_my_subreddits']) {
    assert.equal(describeOperation(tool, {}).requiresIdentity, true, tool);
  }
  for (const tool of ['browse_subreddit', 'search_reddit', 'get_reddit_post', 'browse_subreddit_rss', 'reddit_explain']) {
    const args = tool === 'browse_subreddit' ? { subreddit: 'node' }
      : tool === 'search_reddit' ? { query: 'x' }
        : tool === 'get_reddit_post' ? { post_id: 'abc' }
          : tool === 'browse_subreddit_rss' ? { subreddit: 'node' }
            : { term: 'karma' };
    assert.equal(describeOperation(tool, args).requiresIdentity, false, tool);
  }
});

test('an unknown tool is a classified UNSUPPORTED_OPERATION error', () => {
  assert.throws(
    () => describeOperation('api', {}),
    (error) => error instanceof OperationError
      && error.code === 'UNSUPPORTED_OPERATION'
      && error.outcome === null
      && /api/.test(error.message),
  );
  assert.throws(() => describeOperation('create_post', null), TypeError);
  assert.throws(() => describeOperation('create_post', [], {}), TypeError);
  assert.throws(() => describeOperation('create_post', {}, null), TypeError);
});

test('the error contract exposes the canonical codes, outcomes, and optional failure metadata', () => {
  assert.deepEqual(OPERATION_ERROR_CODES, [
    'PROFILE_REQUIRED',
    'PROFILE_NOT_FOUND',
    'PROFILE_IN_USE',
    'IDENTITY_MISMATCH',
    'IDENTITY_UNVERIFIED',
    'BACKEND_UNAVAILABLE',
    'UNSUPPORTED_OPERATION',
    'PARAMETER_UNSUPPORTED',
    'APP_ONLY_READ_ONLY',
    'APPROVAL_REQUIRED',
    'POLICY_CHANGED',
    'LOGIN_REQUIRED',
    'USER_HANDOFF_REQUIRED',
    'THROTTLED',
    'CONTINUATION_INVALID',
    'CONTINUATION_EXPIRED',
    'CURSOR_CONFLICT',
    'STEP_STALE',
    'BROWSER_DEPENDENCY_MISSING',
    'BROWSER_BINARY_MISSING',
    'OUTCOME_UNKNOWN',
  ]);
  assert.ok(Object.isFrozen(OPERATION_ERROR_CODES));
  assert.deepEqual(OUTCOMES, {
    PREPARED: 'PREPARED',
    WAITING_FOR_USER: 'WAITING_FOR_USER',
    DISPATCHED: 'DISPATCHED',
    SUCCEEDED: 'SUCCEEDED',
    FAILED_KNOWN: 'FAILED_KNOWN',
    OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  });
  assert.ok(Object.isFrozen(OUTCOMES));
  assert.ok(isOperationErrorCode('THROTTLED'));
  assert.ok(!isOperationErrorCode('MADE_UP'));

  const error = new OperationError('THROTTLED', 'Slow down', {
    outcome: OUTCOMES.FAILED_KNOWN,
    retryAfterMs: 2_000,
    safeDetails: { status: 429 },
  });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'OperationError');
  assert.equal(error.code, 'THROTTLED');
  assert.equal(error.outcome, 'FAILED_KNOWN');
  assert.equal(error.retryAfterMs, 2_000);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), {
    name: 'OperationError',
    code: 'THROTTLED',
    message: 'Slow down',
    outcome: 'FAILED_KNOWN',
    retryAfterMs: 2_000,
    safeDetails: { status: 429 },
  });
  assert.throws(() => new OperationError('NOT_A_CODE', 'x'), TypeError);
  assert.throws(() => new OperationError('THROTTLED', 'x', { outcome: 'NOT_AN_OUTCOME' }), TypeError);
});
