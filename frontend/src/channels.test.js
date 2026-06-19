// channels.test.js — unit tests for the channels store (BUILD-authored).
// These supplement the EXAMINE-forged probe (.spiral/channels32-probe.test.js);
// gate passage is decided by the probe, not by this file.

import { test, expect } from 'bun:test';
import { createChannelStore, ingestSocketMessage, channelArgs, reduceReaction, lastAgentIndex } from './channels.js';

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

// ── E-FE-FRAME-AGENT — send carries agent key when agentId is set ────────────

test('E-FE-FRAME-AGENT: addChannel(name,agentId)+send produces {text,agent:agentId} on wire', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A', 'agentA');
  const ch = store.channel(id);
  expect(ch.agentId).toBe('agentA');
  store.send(id, 'hello');
  const sock = created[0];
  expect(sock.sent.length).toBe(1);
  const frame = JSON.parse(sock.sent[0]);
  expect(frame).toEqual({ text: 'hello', agent: 'agentA' });
});

// ── E-FE-NO-AGENT — send omits agent key when agentId is absent ──────────────

test('E-FE-NO-AGENT: addChannel(name) without agentId → send produces {text} only, no agent key', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('Legacy');
  store.send(id, 'hi');
  const sock = created[0];
  expect(sock.sent.length).toBe(1);
  const frame = JSON.parse(sock.sent[0]);
  expect(frame).toEqual({ text: 'hi' });
  expect('agent' in frame).toBe(false);
});

// ── E1 — channelArgs pure fn ──────────────────────────────────────────────────

test('E1: channelArgs(name,agentId) returns [name,agentId] when agentId is non-empty', () => {
  expect(channelArgs('x', 'A')).toEqual(['x', 'A']);
  expect(channelArgs('ch', 'bot-42')).toEqual(['ch', 'bot-42']);
});

test('E1: channelArgs returns [name] when agentId is empty string', () => {
  expect(channelArgs('x', '')).toEqual(['x']);
});

test('E1: channelArgs returns [name] when agentId is blank/whitespace', () => {
  expect(channelArgs('x', '   ')).toEqual(['x']);
  expect(channelArgs('x', '\t')).toEqual(['x']);
});

test('E1: channelArgs returns [name] when agentId is undefined / not provided', () => {
  expect(channelArgs('x', undefined)).toEqual(['x']);
  expect(channelArgs('x')).toEqual(['x']);
});

// ── E2 — channelArgs -> addChannel(...args) -> send -> frame carries agent ────

test('E2: channelArgs->addChannel(...args)->send produces {text,agent:id} on wire', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel(...channelArgs('chan', 'agentA'));
  store.send(id, 'hi');
  const sock = created[0];
  expect(sock.sent.length).toBe(1);
  const frame = JSON.parse(sock.sent[0]);
  expect(frame).toEqual({ text: 'hi', agent: 'agentA' });
});

// ── E3 — channelArgs(blank) -> addChannel(...args) -> frame omits agent key ───

test('E3: channelArgs(blank/empty agent)->addChannel(...args)->send produces {text} only', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel(...channelArgs('chan', ''));
  store.send(id, 'hi');
  const sock = created[0];
  expect(sock.sent.length).toBe(1);
  const frame = JSON.parse(sock.sent[0]);
  expect('agent' in frame).toBe(false);
  expect(frame.text).toBe('hi');
});

// ── E-R3: reduceReaction pure fn ─────────────────────────────────────────────

test('E-R3 reduceReaction add/increment/remove-to-zero-deletes-key/multi-emoji', () => {
  expect(reduceReaction({}, 'add', '👀')).toEqual({ '👀': 1 });
  expect(reduceReaction({ '👀': 1 }, 'add', '👀')).toEqual({ '👀': 2 });
  expect(reduceReaction({ '👀': 1 }, 'remove', '👀')).toEqual({});
  const two = reduceReaction({ '👀': 1 }, 'add', '🔥');
  expect(two).toEqual({ '👀': 1, '🔥': 1 });
});

// ── E-R4 (pure half): unknown op is safe ────────────────────────────────────

test('E-R4 reduceReaction unknown op returns input unchanged, no throw', () => {
  const r = { '👀': 1 };
  let out;
  expect(() => { out = reduceReaction(r, 'weird', 'x'); }).not.toThrow();
  expect(out).toEqual({ '👀': 1 });
});

// ── E-R6: lastAgentIndex pure fn ─────────────────────────────────────────────

test('E-R6 lastAgentIndex finds last agent / -1 when none / -1 on empty', () => {
  expect(lastAgentIndex([{ from: 'me' }, { from: 'agent' }, { from: 'me' }])).toBe(1);
  expect(lastAgentIndex([{ from: 'me' }, { from: 'you' }])).toBe(-1);
  expect(lastAgentIndex([])).toBe(-1);
});

// ── E-R1: add reaction via production ingest ─────────────────────────────────

test('E-R1 add reaction attaches to last agent message via real socket.onmessage', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  created[0].__emit({ type: 'message', text: 'hi' });
  created[0].__emit({ type: 'reaction', op: 'add', text: '👀' });
  const msgs = store.channel(id).messages;
  const last = msgs[msgs.length - 1];
  expect(last.reactions).toEqual({ '👀': 1 });
});

// ── E-R2: remove reaction via production ingest ──────────────────────────────

test('E-R2 remove reaction clears emoji via real socket.onmessage', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  created[0].__emit({ type: 'message', text: 'hi' });
  created[0].__emit({ type: 'reaction', op: 'add', text: '👀' });
  created[0].__emit({ type: 'reaction', op: 'remove', text: '👀' });
  const msgs = store.channel(id).messages;
  const last = msgs[msgs.length - 1];
  expect(last.reactions == null || !('👀' in last.reactions)).toBe(true);
});

// ── E-R4 (ingest half): malformed reaction frame is a no-op ─────────────────

test('E-R4 reaction frame missing text/op is no-op through production ingest', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  created[0].__emit({ type: 'message', text: 'hi' });
  const before = store.channel(id).messages;
  const beforeLastReactions = JSON.stringify(before[before.length - 1].reactions ?? null);
  created[0].__emit({ type: 'reaction', op: 'add' });
  created[0].__emit({ type: 'reaction', text: '👀' });
  const after = store.channel(id).messages;
  expect(after.length).toBe(before.length);
  expect(JSON.stringify(after[after.length - 1].reactions ?? null)).toBe(beforeLastReactions);
});

// ── E-R5: reaction on channel with no agent message is safe no-op ────────────

test('E-R5 reaction on channel with no agent message is a safe no-op via ingest', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const id = store.addChannel('A');
  let threw = false;
  try {
    created[0].__emit({ type: 'reaction', op: 'add', text: '👀' });
  } catch { threw = true; }
  expect(threw).toBe(false);
  expect(store.channel(id).messages.length).toBe(0);
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

// ── E-R8: isolation — reaction on channel a does not touch channel b ──────────

test('E-R8 reaction on channel a does not affect channel b', () => {
  const { factory, created } = makeFakeWsFactory();
  const store = createChannelStore(factory);
  const a = store.addChannel('A');
  const b = store.addChannel('B');
  created[0].__emit({ type: 'message', text: 'a-msg' });
  created[1].__emit({ type: 'message', text: 'b-msg' });
  created[0].__emit({ type: 'reaction', op: 'add', text: '👀' });
  const bMsgs = store.channel(b).messages;
  const bLast = bMsgs[bMsgs.length - 1];
  expect(bLast.reactions == null || !('👀' in bLast.reactions)).toBe(true);
  const aMsgs = store.channel(a).messages;
  expect(aMsgs[aMsgs.length - 1].reactions).toEqual({ '👀': 1 });
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
