// channels.test.js — unit tests for the channels store (BUILD-authored).
// These supplement the EXAMINE-forged probe (.spiral/channels32-probe.test.js);
// gate passage is decided by the probe, not by this file.

import { test, expect } from 'bun:test';
import { createChannelStore, ingestSocketMessage } from './channels.js';

function makeFakeWsFactory() {
  const created = [];
  const factory = (url) => {
    const sock = {
      url,
      sent: [],
      closed: 0,
      _onmessage: null,
      send(d) { sock.sent.push(d); },
      close() { sock.closed += 1; },
      set onmessage(fn) { sock._onmessage = fn; },
      get onmessage() { return sock._onmessage; },
      __emit(payload) {
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (sock._onmessage) sock._onmessage({ data });
      },
    };
    created.push(sock);
    return sock;
  };
  return { factory, created };
}

// ── Basic store API ───────────────────────────────────────────────────────────

test('addChannel returns a unique channelId', () => {
  const { factory } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const a = store.addChannel('A');
  const b = store.addChannel('B');
  expect(typeof a).toBe('string');
  expect(typeof b).toBe('string');
  expect(a).not.toBe(b);
});

test('channel() returns the channel object or null for unknown id', () => {
  const { factory } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('X');
  expect(store.channel(id)).not.toBeNull();
  expect(store.channel('nonexistent')).toBeNull();
});

test('setActive / activeMessages route to the correct channel', () => {
  const { factory } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const a = store.addChannel('A');
  const b = store.addChannel('B');
  store.send(a, 'hello-A');
  store.setActive(b);
  expect(store.activeMessages().length).toBe(0); // B has nothing
  store.setActive(a);
  expect(store.activeMessages().map((m) => m.text)).toContain('hello-A');
});

// ── ingestSocketMessage (module-level export) ─────────────────────────────────

test('ingestSocketMessage appends message to correct channel', () => {
  const { factory } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  ingestSocketMessage(store, id, JSON.stringify({ type: 'message', text: 'hi' }));
  const msgs = store.channel(id).messages;
  expect(msgs.length).toBe(1);
  expect(msgs[0].from).toBe('agent');
  expect(msgs[0].text).toBe('hi');
});

test('ingestSocketMessage ignores malformed JSON', () => {
  const { factory } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  ingestSocketMessage(store, id, 'not-json{');
  expect(store.channel(id).messages.length).toBe(0);
});

test('ingestSocketMessage ignores non-message type frames', () => {
  const { factory } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  ingestSocketMessage(store, id, JSON.stringify({ type: 'reaction', text: '👍' }));
  expect(store.channel(id).messages.length).toBe(0);
});

// ── Message id stability (B2) ─────────────────────────────────────────────────

test('every message (send + receive) carries a stable unique id', () => {
  const { factory } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  store.send(id, 'my text');
  ingestSocketMessage(store, id, JSON.stringify({ type: 'message', text: 'agent reply' }));
  const msgs = store.channel(id).messages;
  expect(msgs.length).toBe(2);
  for (const m of msgs) {
    expect(m.id !== undefined && m.id !== null && m.id !== '').toBe(true);
  }
  expect(msgs[0].id).not.toBe(msgs[1].id);
  // read-stability
  expect(msgs[0].id).toBe(msgs[0].id);
});

// ── store.reconnect (B1) ──────────────────────────────────────────────────────

test('store.reconnect closes old socket and opens a new one', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  const oldSock = store.channel(id).socket;
  expect(created.length).toBe(1);

  store.reconnect(id);

  expect(oldSock.closed).toBe(1);
  expect(created.length).toBe(2);
  expect(store.channel(id).socket).not.toBe(oldSock);
  expect(store.channel(id).socket).toBe(created[1]);
});

// ── D1 from seam ──────────────────────────────────────────────────────────────

test('inbound messages are always from:agent regardless of payload.from field', () => {
  const { factory } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  ingestSocketMessage(store, id, JSON.stringify({ type: 'message', text: 'hi', from: 'bot-42', source: 'bot-42' }));
  const m = store.channel(id).messages[0];
  expect(m.from).toBe('agent');
});

// ── Multi-channel isolation ───────────────────────────────────────────────────

test('send only affects the target channel', () => {
  const { factory } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const a = store.addChannel('A');
  const b = store.addChannel('B');
  store.send(a, 'for-A');
  expect(store.channel(a).messages.length).toBe(1);
  expect(store.channel(b).messages.length).toBe(0);
});

// ── E-FE-FRAME — single-agent send produces {text} only, never a target_agent ─

test('E-FE-FRAME: send produces {text} only on wire (single-agent, no target_agent)', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  store.send(id, 'hi');
  const sock = created[0];
  expect(sock.sent.length).toBe(1);
  const frame = JSON.parse(sock.sent[0]);
  expect(frame).toEqual({ text: 'hi' });
  expect('agent' in frame).toBe(false);
});

// ── E-R7: existing message ingest regression ─────────────────────────────────

test('E-R7 type:message still appends from:agent; malformed JSON no-op', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  created[0].__emit({ type: 'message', text: 'hello' });
  const msgs = store.channel(id).messages;
  expect(msgs.length).toBe(1);
  expect(msgs[0].from).toBe('agent');
  expect(msgs[0].text).toBe('hello');
  created[0].__emit('not-json{');
  expect(store.channel(id).messages.length).toBe(1);
});

// ── E-R9: reaction does not spawn a new message; id stays ───────────────────

test('E-R9 reaction attaches in place: id unchanged & non-empty, no new message', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  created[0].__emit({ type: 'message', text: 'hi' });
  const before = store.channel(id).messages;
  expect(before.length).toBe(1);
  const idBefore = before[0].id;
  created[0].__emit({ type: 'reaction', op: 'add', text: '👀' });
  const after = store.channel(id).messages;
  expect(after.length).toBe(1);
  expect(after[0].id).toBe(idBefore);
  expect(typeof after[0].id === 'string' && after[0].id !== '').toBe(true);
});
