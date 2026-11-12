import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleMessage,
  buildMessage,
  conversationKey,
  recipientOf,
  PUSH_BODY,
  HIDDEN_TITLE,
  IOS_SOUND,
  ANDROID_CHANNEL,
  ANDROID_SILENT_CHANNEL,
  THROTTLE,
  DATA_MARKER,
} from '../lib/push-core.js';

const CHAT = 'alice_bob';
const ALICE_DEV = 'alice-device-1';
const BOB_PHONE = 'bob-phone-0001';
const BOB_TABLET = 'bob-tablet-001';
const TOKEN = (n) => `fcm-token-${n}-0123456789abcdef`;

function fixture(over = {}) {
  const state = {
    chats: { [CHAT]: { accepted: true, initiator: 'alice' } },
    blocks: new Set(),
    profiles: {
      alice: { username: 'alice' },
      bob: { username: 'bob' },
    },
    tokens: {
      bob: [
        { deviceId: BOB_PHONE, token: TOKEN(1) },
        { deviceId: BOB_TABLET, token: TOKEN(2) },
      ],
      alice: [{ deviceId: ALICE_DEV, token: TOKEN(3) }],
    },
    throttle: {},
    deleted: [],
    sent: [],
    failures: {},
    ...over,
  };
  const store = {
    getChat: async (id) => state.chats[id] ?? null,
    isBlocked: async (owner, blocked) => state.blocks.has(`${owner}>${blocked}`),
    getProfile: async (uid) => state.profiles[uid] ?? null,
    listTokens: async (uid) => state.tokens[uid] ?? [],
    claimThrottle: async (chatId, uid, now, window) => {
      const key = `${chatId}/${uid}`;
      const last = state.throttle[key];
      if (last !== undefined && now - last < window) return false;
      state.throttle[key] = now;
      return true;
    },
    deleteToken: async (uid, deviceId) => state.deleted.push(`${uid}/${deviceId}`),
  };
  const messaging = {
    send: async (m) => {
      const code = state.failures[m.token];
      if (code) throw Object.assign(new Error('fcm'), { code });
      state.sent.push(m);
      return 'id';
    },
  };
  return { state, deps: { store, messaging } };
}

const message = (envelopes = [BOB_PHONE, BOB_TABLET, ALICE_DEV], senderUid = 'alice') => ({
  senderUid,
  envelopes: Object.fromEntries(envelopes.map((d) => [d, { ct: 'x' }])),
});

test('sends the sender username as title and a fixed body to each reached recipient device', async () => {
  const { state, deps } = fixture();
  assert.equal(await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps), 'sent');
  assert.deepEqual(state.sent.map((m) => m.token).sort(), [TOKEN(1), TOKEN(2)]);
  for (const m of state.sent) {
    assert.deepEqual(m.notification, { title: 'alice', body: PUSH_BODY });
  }
  assert.equal(PUSH_BODY, 'New Message');
});

test('never alerts the sender, including their own linked devices', async () => {
  const { state, deps } = fixture();
  await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps);
  assert.ok(!state.sent.some((m) => m.token === TOKEN(3)));
});

test('only devices that received an envelope are alerted', async () => {
  const { state, deps } = fixture();
  await handleMessage({ chatId: CHAT, data: message([BOB_PHONE]), now: 1e6 }, deps);
  assert.deepEqual(state.sent.map((m) => m.token), [TOKEN(1)]);
});

test('the payload carries no message content, chat id, account id or badge', () => {
  const m = buildMessage({ token: TOKEN(1), username: 'alice', chatId: CHAT });
  const text = JSON.stringify(m);
  assert.ok(!text.includes(CHAT));
  assert.ok(!text.includes('envelope'));
  assert.ok(!('data' in m));
  assert.ok(!('badge' in m.apns.payload.aps));
  // Hidden from Apple and Google: an opaque per-conversation key instead of the chat id.
  assert.equal(m.apns.headers['apns-collapse-id'], conversationKey(CHAT));
  assert.equal(m.apns.payload.aps['thread-id'], conversationKey(CHAT));
  assert.equal(m.android.notification.tag, conversationKey(CHAT));
  assert.equal(m.android.collapseKey, conversationKey(CHAT));
  assert.ok(Buffer.byteLength(m.apns.headers['apns-collapse-id']) <= 64);
});

test('conversation keys are stable and differ between chats', () => {
  assert.equal(conversationKey(CHAT), conversationKey(CHAT));
  assert.notEqual(conversationKey(CHAT), conversationKey('alice_carol'));
});

test('one alert per conversation per throttle window', async () => {
  const { state, deps } = fixture();
  assert.equal(await handleMessage({ chatId: CHAT, data: message([BOB_PHONE]), now: 1e6 }, deps), 'sent');
  assert.equal(
    await handleMessage({ chatId: CHAT, data: message([BOB_PHONE]), now: 1e6 + THROTTLE - 1 }, deps),
    'throttled',
  );
  assert.equal(
    await handleMessage({ chatId: CHAT, data: message([BOB_PHONE]), now: 1e6 + THROTTLE }, deps),
    'sent',
  );
  assert.equal(state.sent.length, 2);
});

test('the throttle is per recipient: a reply is not held back by the message before it', async () => {
  const { state, deps } = fixture();
  await handleMessage({ chatId: CHAT, data: message([BOB_PHONE]), now: 1e6 }, deps);
  assert.equal(
    await handleMessage({ chatId: CHAT, data: message([ALICE_DEV], 'bob'), now: 1e6 + 1 }, deps),
    'sent',
  );
  assert.deepEqual(state.sent.at(-1).notification.title, 'bob');
});

test('unaccepted message requests stay silent; legacy chats without the field are accepted', async () => {
  const silent = fixture({ chats: { [CHAT]: { accepted: false, initiator: 'alice' } } });
  assert.equal(await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, silent.deps), 'request');
  assert.equal(silent.state.sent.length, 0);

  const legacy = fixture({ chats: { [CHAT]: {} } });
  assert.equal(await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, legacy.deps), 'sent');
});

test('a recipient who blocked the sender is not alerted', async () => {
  const { state, deps } = fixture({ blocks: new Set(['bob>alice']) });
  assert.equal(await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps), 'blocked');
  assert.equal(state.sent.length, 0);
});

test('deleted or deleting accounts are skipped', async () => {
  for (const profiles of [
    { alice: { username: 'alice' } },
    { alice: { username: 'alice' }, bob: { username: 'bob', deleting: true } },
    { bob: { username: 'bob' } },
    { alice: { username: 'alice', deleting: true }, bob: { username: 'bob' } },
    { alice: { username: 'Not Valid!' }, bob: { username: 'bob' } },
  ]) {
    const { state, deps } = fixture({ profiles });
    const result = await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps);
    assert.match(result, /gone/);
    assert.equal(state.sent.length, 0);
  }
});

test('malformed input sends nothing', async () => {
  const { state, deps } = fixture();
  const cases = [
    { chatId: CHAT, data: null },
    { chatId: CHAT, data: { envelopes: {} } },
    { chatId: CHAT, data: message([], 'alice') },
    { chatId: CHAT, data: message([BOB_PHONE], 'mallory') }, // not a participant
    { chatId: 'alice', data: message() },
    { chatId: 'alice_alice', data: message() },
    { chatId: CHAT, data: { senderUid: 'alice', envelopes: { 'bad/id': {} } } },
    { chatId: 'missing_chat', data: { ...message(), senderUid: 'missing' } },
  ];
  for (const c of cases) {
    assert.notEqual(await handleMessage({ ...c, now: 1e6 }, deps), 'sent');
  }
  assert.equal(state.sent.length, 0);
});

test('no throttle is spent when nobody can be alerted', async () => {
  const { state, deps } = fixture({ tokens: {} });
  assert.equal(await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps), 'no-tokens');
  assert.deepEqual(state.throttle, {});
});

test('tokens FCM reports as dead are removed; other failures keep the token', async () => {
  const { state, deps } = fixture({
    failures: {
      [TOKEN(1)]: 'messaging/registration-token-not-registered',
      [TOKEN(2)]: 'messaging/internal-error',
    },
  });
  assert.equal(await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps), 'failed');
  assert.deepEqual(state.deleted, [`bob/${BOB_PHONE}`]);
});

test('one failing device does not stop the others', async () => {
  const { state, deps } = fixture({ failures: { [TOKEN(1)]: 'messaging/internal-error' } });
  assert.equal(await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps), 'sent');
  assert.deepEqual(state.sent.map((m) => m.token), [TOKEN(2)]);
});

test('a device that hides names gets "Fireplace" as the title', async () => {
  const { state, deps } = fixture({
    tokens: {
      bob: [
        { deviceId: BOB_PHONE, token: TOKEN(1), showName: false },
        { deviceId: BOB_TABLET, token: TOKEN(2), showName: true },
      ],
    },
  });
  await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps);
  const title = (t) => state.sent.find((m) => m.token === t).notification.title;
  assert.equal(title(TOKEN(1)), HIDDEN_TITLE);
  assert.equal(title(TOKEN(2)), 'alice');
  assert.equal(HIDDEN_TITLE, 'Fireplace');
});

test('alerts play the Fireplace pop by default', () => {
  const m = buildMessage({ token: TOKEN(1), username: 'alice', chatId: CHAT });
  assert.equal(m.apns.payload.aps.sound, IOS_SOUND);
  assert.equal(IOS_SOUND, 'notification_pop.wav');
  assert.equal(m.android.notification.channelId, ANDROID_CHANNEL);
});

test('a device with the sound off gets a silent alert', async () => {
  const { state, deps } = fixture({
    tokens: {
      bob: [
        { deviceId: BOB_PHONE, token: TOKEN(1), sound: false },
        { deviceId: BOB_TABLET, token: TOKEN(2) }, // older app: no field
      ],
    },
  });
  await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps);
  const sent = (t) => state.sent.find((m) => m.token === t);
  assert.ok(!('sound' in sent(TOKEN(1)).apns.payload.aps));
  assert.equal(sent(TOKEN(1)).android.notification.channelId, ANDROID_SILENT_CHANNEL);
  assert.equal(sent(TOKEN(2)).apns.payload.aps.sound, IOS_SOUND);
  assert.equal(sent(TOKEN(2)).android.notification.channelId, ANDROID_CHANNEL);
});

test('recipientOf', () => {
  assert.equal(recipientOf('a_b', 'a'), 'b');
  assert.equal(recipientOf('a_b', 'b'), 'a');
  assert.equal(recipientOf('a_b', 'c'), null);
  assert.equal(recipientOf('a_b_c', 'a'), null);
  assert.equal(recipientOf('a', 'a'), null);
});

test('all lookups for a message run at once, not one after another', async () => {
  const { deps } = fixture();
  const { store } = deps;
  let running = 0;
  let most = 0;
  const overlapping = (fn) => async (...args) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return fn(...args);
  };
  for (const name of ['getChat', 'isBlocked', 'getProfile', 'listTokens']) {
    store[name] = overlapping(store[name]);
  }
  const result = await handleMessage(
    { chatId: CHAT, data: { senderUid: 'alice', envelopes: { [BOB_PHONE]: {} } } },
    deps,
  );
  assert.equal(result, 'sent');
  assert.equal(most, 5, 'chat, block, both profiles and tokens together');
});

// ---------- data pushes (decision 0019) ----------

const dataToken = (n, over = {}) => ({
  deviceId: n === 1 ? BOB_PHONE : BOB_TABLET,
  token: TOKEN(n),
  platform: 'android',
  dataPush: true,
  ...over,
});

test('an Android app that handles data pushes gets data only, at high priority', () => {
  const m = buildMessage({
    token: TOKEN(1),
    username: 'alice',
    chatId: CHAT,
    platform: 'android',
    dataPush: true,
  });
  assert.deepEqual(Object.keys(m).sort(), ['android', 'data', 'token']);
  assert.deepEqual(m.data, {
    [DATA_MARKER]: '1',
    k: conversationKey(CHAT),
    title: 'alice',
    ch: ANDROID_CHANNEL,
  });
  assert.equal(DATA_MARKER, 'fp');
  // No notification block anywhere: the app posts the alert itself.
  assert.deepEqual(m.android, { priority: 'high', collapseKey: conversationKey(CHAT) });
  for (const v of Object.values(m.data)) assert.equal(typeof v, 'string');
});

test('a data push carries no message content, chat id, account id or envelope', () => {
  const m = buildMessage({
    token: TOKEN(1),
    username: 'alice',
    chatId: CHAT,
    platform: 'android',
    dataPush: true,
  });
  const text = JSON.stringify(m);
  assert.ok(!text.includes(CHAT));
  assert.ok(!text.includes('bob'));
  assert.ok(!text.includes('envelope'));
  assert.ok(!text.includes('ct'));
  assert.ok(!text.includes(PUSH_BODY));
});

test('a data push keeps the name and sound choices', async () => {
  const { state, deps } = fixture({
    tokens: {
      bob: [
        dataToken(1, { showName: false, sound: false }),
        dataToken(2),
      ],
    },
  });
  assert.equal(await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps), 'sent');
  const sent = (t) => state.sent.find((m) => m.token === t);
  assert.equal(sent(TOKEN(1)).data.title, HIDDEN_TITLE);
  assert.equal(sent(TOKEN(1)).data.ch, ANDROID_SILENT_CHANNEL);
  assert.equal(sent(TOKEN(2)).data.title, 'alice');
  assert.equal(sent(TOKEN(2)).data.ch, ANDROID_CHANNEL);
});

test('older apps and iOS keep the notification payload', async () => {
  const { state, deps } = fixture({
    tokens: {
      bob: [
        { deviceId: BOB_PHONE, token: TOKEN(1), platform: 'android' }, // v0.3.5
        { deviceId: BOB_TABLET, token: TOKEN(2), platform: 'ios', dataPush: true },
      ],
    },
  });
  await handleMessage({ chatId: CHAT, data: message(), now: 1e6 }, deps);
  assert.equal(state.sent.length, 2);
  for (const m of state.sent) {
    assert.deepEqual(m.notification, { title: 'alice', body: PUSH_BODY });
    assert.ok(!('data' in m));
  }
});

test('iOS alerts may be rewritten by a notification service extension', () => {
  for (const sound of [true, false]) {
    const m = buildMessage({ token: TOKEN(1), username: 'alice', chatId: CHAT, sound, platform: 'ios' });
    assert.equal(m.apns.payload.aps['mutable-content'], 1);
    // What shows if the extension is missing or fails: today's alert.
    assert.deepEqual(m.notification, { title: 'alice', body: PUSH_BODY });
    assert.equal(m.apns.headers['apns-push-type'], 'alert');
  }
});

test('data pushes share the per-conversation throttle', async () => {
  const { state, deps } = fixture({ tokens: { bob: [dataToken(1)] } });
  const at = (now) => handleMessage({ chatId: CHAT, data: message([BOB_PHONE]), now }, deps);
  assert.equal(await at(1e6), 'sent');
  assert.equal(await at(1e6 + THROTTLE - 1), 'throttled');
  assert.equal(await at(1e6 + THROTTLE), 'sent');
  assert.equal(state.sent.length, 2);
  assert.ok(state.sent.every((m) => 'data' in m));
});
