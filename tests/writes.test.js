import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActions } from '../src/actions.js';
import { fakeClient, guardWith } from './fake-client.js';

const OK = { json: { errors: [], data: {} } };

test('editText posts thing_id and text, and appends the footer when one is configured', async () => {
  const { client, requests } = fakeClient(OK);
  const actions = createActions({ client, guard: guardWith(), footer: '\n\n---\nI am a bot.' });
  await actions.editText({ fullname: 't1_abc', text: 'Fixed', kind: 't1' });
  assert.equal(requests[0].path, '/api/editusertext/');
  assert.deepEqual(requests[0].form, { api_type: 'json', thing_id: 't1_abc', text: 'Fixed\n\n---\nI am a bot.' });
});

test('editText keeps posts and comments apart by kind, and needs text', async () => {
  const actions = createActions({ client: fakeClient(OK).client, guard: guardWith() });
  await assert.rejects(actions.editText({ fullname: 't1_abc', text: 'x', kind: 't3' }), /Expected a Reddit fullname/);
  await assert.rejects(actions.editText({ fullname: 't3_abc', text: '  ' }), /New text is required/);
});

test('deleteThing posts the id to /api/del and checks the kind', async () => {
  const { client, requests } = fakeClient(OK);
  const actions = createActions({ client, guard: guardWith() });
  await actions.deleteThing({ fullname: 't3_abc', kind: 't3' });
  assert.equal(requests[0].path, '/api/del/');
  assert.deepEqual(requests[0].form, { id: 't3_abc' });
  await assert.rejects(actions.deleteThing({ fullname: 't1_abc', kind: 't3' }), /Expected a Reddit fullname/);
});

test('the footer goes on comments and text posts, never on link posts', async () => {
  const { client, requests } = fakeClient(OK);
  const actions = createActions({ client, guard: guardWith(), footer: ' [bot]' });
  await actions.comment({ parent: 't3_abc', text: 'Hi' });
  await actions.submitPost({ subreddit: 'node', title: 'Self', text: 'Body' });
  await actions.submitPost({ subreddit: 'node', title: 'Link', url: 'https://example.com' });
  assert.equal(requests[0].form.text, 'Hi [bot]');
  assert.equal(requests[1].form.text, 'Body [bot]');
  assert.equal(requests[2].form.text, undefined);
  assert.equal(requests[2].form.url, 'https://example.com');
});
