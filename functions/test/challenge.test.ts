// Push challenge (decision 0020). No emulator and no Firebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { challengeMessage, clearAnsweredChallenge, issueChallenge } from '../lib/challenge.ts';
import type { ChallengeMessage } from '../lib/challenge.ts';

const until = Date.UTC(2026, 10, 19);
const fixed = () => Buffer.from('ab'.repeat(32), 'hex');

test('the push carries only the challenge, with no visible text', () => {
  const message = challengeMessage('fcm-token', 'abc');
  assert.equal(message.notification, undefined);
  assert.deepEqual(message.data, { type: 'rateLimitChallenge', challenge: 'abc' });
  assert.equal(JSON.stringify(message).includes('New Message'), false);
});

test('no registered device means no challenge is stored', async () => {
  let saved = false;
  const result = await issueChallenge(
    { uid: 'mallory', untilMs: until, tokens: [] },
    { save: async () => { saved = true; }, push: async () => {}, clear: async () => {} },
  );
  assert.equal(result, 'no-push');
  assert.equal(saved, false);
});

test('a challenge is stored and pushed to each live device', async () => {
  const pushes: ChallengeMessage[] = [];
  let saved: any = null;
  const result = await issueChallenge(
    { uid: 'mallory', untilMs: until, tokens: ['a', 'b'], random: fixed },
    {
      save: async (uid, token, untilMs) => { saved = { uid, token, untilMs }; },
      push: async (message) => { pushes.push(message); },
      clear: async () => { throw new Error('should keep the challenge'); },
    },
  );
  assert.equal(result, 'sent');
  assert.equal(saved.token, 'ab'.repeat(32));
  assert.equal(saved.untilMs, until);
  assert.deepEqual(pushes.map((m) => m.token), ['a', 'b']);
  assert.equal(pushes[0].data.challenge, saved.token);
});

test('a dead token is skipped, and a challenge nobody received is removed', async () => {
  let cleared = false;
  const result = await issueChallenge(
    { uid: 'mallory', untilMs: until, tokens: ['dead'], random: fixed },
    {
      save: async () => {},
      push: async () => { throw new Error('messaging/registration-token-not-registered'); },
      clear: async () => { cleared = true; },
    },
  );
  assert.equal(result, 'no-push');
  assert.equal(cleared, true);
});

test('the right token clears the challenge and a wrong one does not', async () => {
  const hold = { token: 'ab'.repeat(32) };
  let cleared = 0;
  const deps = { read: async () => hold, clear: async () => { cleared += 1; } };
  assert.equal(await clearAnsweredChallenge({ uid: 'mallory', token: 'nope' }, deps), 'wrong');
  assert.equal(cleared, 0);
  assert.equal(await clearAnsweredChallenge({ uid: 'mallory', token: hold.token }, deps), 'cleared');
  assert.equal(cleared, 1);
  assert.equal(await clearAnsweredChallenge({ uid: 'mallory', token: hold.token }, { read: async () => null, clear: async () => {} }), 'none');
});
