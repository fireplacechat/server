// The spam filter's hook (decision 0018), with stand-in policies: the deployed
// policy is private and tested in spam-policy.private.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleReport } from '../lib/spam-filter.js';
import { POLICY as EXAMPLE } from '../lib/spam-policy.example.js';

const DAY = 86400e3;
const NOW = Date.UTC(2026, 10, 12, 12);

function fixture({ reporters = 1, createdMs = NOW - 365 * DAY, restriction = null, challengeResult = 'sent', decide } = {}) {
  const state = { restricted: null, queued: [], since: null, asked: null, challenge: null };
  const store = {
    reportersSince: async (uid, sinceMs) => { state.since = sinceMs; return reporters; },
    accountCreatedMs: async () => createdMs,
    restriction: async () => restriction,
    restrict: async (uid, until) => { state.restricted = { uid, until }; },
    challenge: async (uid, until) => { state.challenge = { uid, until }; return challengeResult; },
    queue: async (uid, entry) => { state.queued.push({ uid, ...entry }); },
  };
  const policy = {
    reportWindowMs: 7 * DAY,
    assess: (input) => { state.asked = input; return decide(input); },
  };
  return { state, deps: { store, policy } };
}
const report = { reporter: 'bob', reported: 'mallory', reason: 'spam' };
const review = () => ({ action: 'review', reasons: ['looked at'] });
const restrictFor = (ms) => ({ now }) => ({ action: 'restrict', reasons: ['too many'], until: now + ms });

test('the policy is asked with the reporters in its window and the account age', async () => {
  const { state, deps } = fixture({ reporters: 4, createdMs: NOW - 10 * DAY, decide: review });
  assert.equal(await handleReport({ data: report, now: NOW }, deps), 'queued');
  assert.equal(state.since, NOW - 7 * DAY);
  assert.deepEqual(state.asked, { reporters: 4, accountAgeMs: 10 * DAY, now: NOW });
  assert.deepEqual(state.queued[0], {
    uid: 'mallory', action: 'review', reasons: ['looked at'], untilMs: null,
  });
  assert.equal(state.restricted, null);
});

test('a restriction from the policy is applied and queued', async () => {
  const { state, deps } = fixture({ decide: restrictFor(2 * DAY) });
  assert.equal(await handleReport({ data: report, now: NOW }, deps), 'restricted');
  assert.deepEqual(state.restricted, { uid: 'mallory', until: NOW + 2 * DAY });
  assert.equal(state.queued[0].action, 'restrict');
  assert.equal(state.queued[0].untilMs, NOW + 2 * DAY);
});

test('a longer restriction someone already set is kept', async () => {
  const { state, deps } = fixture({ restriction: NOW + 365 * DAY, decide: restrictFor(DAY) });
  await handleReport({ data: report, now: NOW }, deps);
  assert.equal(state.restricted, null);
});

test('the hook never bans or restricts on a malformed decision', async () => {
  for (const decision of [
    { action: 'ban', reasons: ['x'] },
    { action: 'restrict', reasons: ['x'] }, // no end
    { action: 'restrict', reasons: ['x'], until: NOW - 1 }, // already over
  ]) {
    const { state, deps } = fixture({ decide: () => decision });
    assert.equal(await handleReport({ data: report, now: NOW }, deps), 'queued');
    assert.equal(state.restricted, null);
    assert.equal(state.queued[0].action, 'review');
  }
});

test('a challenge is issued and queued, and the account is not restricted', async () => {
  const { state, deps } = fixture({
    decide: ({ now }) => ({ action: 'challenge', reasons: ['suspicious'], until: now + DAY }),
  });
  assert.equal(await handleReport({ data: report, now: NOW }, deps), 'challenged');
  assert.deepEqual(state.challenge, { uid: 'mallory', until: NOW + DAY });
  assert.equal(state.restricted, null);
  assert.equal(state.queued[0].action, 'challenge');
  assert.equal(state.queued[0].untilMs, NOW + DAY);
});

test('a challenge that cannot be delivered is a review, not a pause', async () => {
  const { state, deps } = fixture({
    challengeResult: 'no-push',
    decide: ({ now }) => ({ action: 'challenge', reasons: ['suspicious'], until: now + DAY }),
  });
  assert.equal(await handleReport({ data: report, now: NOW }, deps), 'queued');
  assert.deepEqual(state.challenge, { uid: 'mallory', until: NOW + DAY });
  assert.equal(state.restricted, null);
  assert.equal(state.queued[0].action, 'review');
  assert.equal(state.queued[0].untilMs, null);
});

test('a report about a deleted account, or a malformed one, changes nothing', async () => {
  const gone = fixture({ createdMs: null, decide: review });
  assert.equal(await handleReport({ data: report, now: NOW }, gone.deps), 'account-gone');
  assert.equal(gone.state.queued.length, 0);
  const bad = fixture({ decide: review });
  assert.equal(await handleReport({ data: { reported: 5 }, now: NOW }, bad.deps), 'malformed');
});

test('the stand-in policy has the shape the hook needs and no cutoff', () => {
  assert.equal(EXAMPLE.reportWindowMs, 0);
  for (const reporters of [1, 100]) {
    const d = EXAMPLE.assess({ reporters, accountAgeMs: DAY, now: NOW });
    assert.equal(d.action, 'review');
    assert.equal(d.until, undefined);
    assert.ok(Array.isArray(d.reasons));
  }
});
