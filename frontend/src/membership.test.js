import { test, expect } from 'bun:test';
import {
  addAgent,
  removeAgent,
  agentsOf,
  routingTargetFor,
  routingAmbiguous,
  OPENAB_LIMITS,
  OPENAB_IDENTITY,
  OPENAB_MENTION_GATING,
  mentionGatePasses,
  agentDescriptor,
  OPENAB_ALIGNMENT_BLOCKERS,
} from './membership.js';
import { channelArgs } from './channels.js';

// All tests use random channel ids to avoid cross-test contamination on the shared module store.

// ─── N:M model behavior ──────────────────────────────────────────────────────

test('add two agents to a channel -> agentsOf returns both', () => {
  const c = 'mt-two-' + Math.random().toString(36).slice(2);
  addAgent(c, 'A');
  addAgent(c, 'B');
  expect([...agentsOf(c)].sort()).toEqual(['A', 'B']);
});

test('removeAgent leaves the other agent', () => {
  const c = 'mt-rm-' + Math.random().toString(36).slice(2);
  addAgent(c, 'A');
  addAgent(c, 'B');
  removeAgent(c, 'A');
  expect([...agentsOf(c)].sort()).toEqual(['B']);
});

test('duplicate addAgent is idempotent (no dupes)', () => {
  const c = 'mt-dup-' + Math.random().toString(36).slice(2);
  addAgent(c, 'B');
  addAgent(c, 'B');
  expect([...agentsOf(c)].sort()).toEqual(['B']);
});

test('cross-channel N:M isolation', () => {
  const c1 = 'mt-iso1-' + Math.random().toString(36).slice(2);
  const c2 = 'mt-iso2-' + Math.random().toString(36).slice(2);
  addAgent(c1, 'X');
  addAgent(c2, 'A');
  expect(agentsOf(c1)).not.toContain('A');
  expect([...agentsOf(c2)]).toContain('A');
});

test('agentsOf of an untouched channel is empty', () => {
  const c = 'mt-empty-' + Math.random().toString(36).slice(2);
  expect([...agentsOf(c)]).toEqual([]);
});

test('removeAgent on unknown channel is a no-op', () => {
  const c = 'mt-rm-unknown-' + Math.random().toString(36).slice(2);
  expect(() => removeAgent(c, 'ghost')).not.toThrow();
  expect([...agentsOf(c)]).toEqual([]);
});

// ─── routingTargetFor / routingAmbiguous ─────────────────────────────────────

test('exactly 1 agent -> routingTargetFor returns that id', () => {
  const c = 'mt-one-' + Math.random().toString(36).slice(2);
  addAgent(c, 'solo');
  expect(routingTargetFor(c)).toBe('solo');
  expect(routingAmbiguous(c)).toBe(false);
});

test('0 agents -> routingTargetFor returns null (broadcast)', () => {
  const c = 'mt-zero-' + Math.random().toString(36).slice(2);
  expect(routingTargetFor(c)).toBeNull();
  expect(routingAmbiguous(c)).toBe(false);
});

test('>=2 agents -> routingTargetFor returns null AND routingAmbiguous is true', () => {
  const c = 'mt-many-' + Math.random().toString(36).slice(2);
  addAgent(c, 'A');
  addAgent(c, 'B');
  expect(routingTargetFor(c)).toBeNull();
  expect(routingAmbiguous(c)).toBe(true);
});

test('derived target is channelArgs-compatible (1 agent -> [name, id])', () => {
  const c = 'mt-shape1-' + Math.random().toString(36).slice(2);
  addAgent(c, 'agentA');
  const t = routingTargetFor(c);
  expect(typeof t).toBe('string');
  expect(channelArgs('chan', t)).toEqual(['chan', 'agentA']);
});

test('derived target is channelArgs-compatible (0 agents -> [name])', () => {
  const c = 'mt-shape0-' + Math.random().toString(36).slice(2);
  const t = routingTargetFor(c);
  expect(t === null || t === undefined).toBe(true);
  expect(channelArgs('chan', t)).toEqual(['chan']);
});

// ─── OPENAB_LIMITS ───────────────────────────────────────────────────────────

test('OPENAB_LIMITS records the three blocking flags', () => {
  expect(OPENAB_LIMITS).toBeDefined();
  expect(OPENAB_LIMITS.replyHasSource).toBe(false);
  expect(OPENAB_LIMITS.eventHasMembership).toBe(false);
  expect(OPENAB_LIMITS.targetAgentIsSingleValue).toBe(true);
});

// ─── E1: OPENAB_IDENTITY ──────────────────────────────────────────────────────

test('OPENAB_IDENTITY has correct frozen value', () => {
  expect(OPENAB_IDENTITY).toEqual({
    identityKey: 'bot_username',
    identitySource: 'config',
    runtimeAddressingField: null,
    isolationModel: 'per-pod',
    handoffMechanism: 'mention',
  });
});

// ─── E2: OPENAB_MENTION_GATING + mentionGatePasses ───────────────────────────

test('OPENAB_MENTION_GATING has correct frozen value', () => {
  expect(OPENAB_MENTION_GATING).toEqual({
    requiresGroup: true,
    groupTypes: ['group', 'supergroup'],
    skippedWhenInThread: true,
    requiresBotUsername: true,
    matchOn: 'mentions',
    matchSemantics: 'exact-equality',
  });
});

test('mentionGatePasses: group not in thread, mention hit -> true', () => {
  expect(mentionGatePasses({ channelType: 'group', inThread: false, botUsername: 'mybot', mentions: ['mybot'] })).toBe(true);
});

test('mentionGatePasses: group not in thread, mention miss -> false', () => {
  expect(mentionGatePasses({ channelType: 'group', inThread: false, botUsername: 'mybot', mentions: ['other'] })).toBe(false);
});

test('mentionGatePasses: private channel -> true (no gating)', () => {
  expect(mentionGatePasses({ channelType: 'private', inThread: false, botUsername: 'mybot', mentions: [] })).toBe(true);
});

test('mentionGatePasses: group in thread -> true (thread not gated)', () => {
  expect(mentionGatePasses({ channelType: 'group', inThread: true, botUsername: 'mybot', mentions: [] })).toBe(true);
});

test('mentionGatePasses: group !thread null botUsername -> true', () => {
  expect(mentionGatePasses({ channelType: 'group', inThread: false, botUsername: null, mentions: ['x'] })).toBe(true);
});

test('mentionGatePasses: group !thread undefined botUsername -> true', () => {
  expect(mentionGatePasses({ channelType: 'group', inThread: false, botUsername: undefined, mentions: ['x'] })).toBe(true);
});

test('mentionGatePasses: supergroup mention hit -> true', () => {
  expect(mentionGatePasses({ channelType: 'supergroup', inThread: false, botUsername: 'mybot', mentions: ['mybot', 'other'] })).toBe(true);
});

test('mentionGatePasses: mentions undefined is safe (group, miss) -> false', () => {
  expect(mentionGatePasses({ channelType: 'group', inThread: false, botUsername: 'mybot', mentions: undefined })).toBe(false);
});

// ─── E3: agentDescriptor ─────────────────────────────────────────────────────

test('agentDescriptor full fields', () => {
  expect(agentDescriptor({ localId: 'ch1', label: 'Alice', openabBotUsername: 'alice_bot' }))
    .toEqual({ localId: 'ch1', label: 'Alice', openabBotUsername: 'alice_bot' });
});

test('agentDescriptor defaults: label -> localId, openabBotUsername -> null', () => {
  expect(agentDescriptor({ localId: 'ch1' }))
    .toEqual({ localId: 'ch1', label: 'ch1', openabBotUsername: null });
});

test('agentDescriptor missing localId throws', () => {
  expect(() => agentDescriptor({ label: 'x' })).toThrow();
  expect(() => agentDescriptor({})).toThrow();
  expect(() => agentDescriptor({ localId: '' })).toThrow();
});

// ─── E4: OPENAB_ALIGNMENT_BLOCKERS ───────────────────────────────────────────

test('OPENAB_ALIGNMENT_BLOCKERS is an array of at least 3 items', () => {
  expect(Array.isArray(OPENAB_ALIGNMENT_BLOCKERS)).toBe(true);
  expect(OPENAB_ALIGNMENT_BLOCKERS.length).toBeGreaterThanOrEqual(3);
});

test('OPENAB_ALIGNMENT_BLOCKERS all items have id, need, door=one-way', () => {
  for (const b of OPENAB_ALIGNMENT_BLOCKERS) {
    expect(typeof b.id).toBe('string');
    expect(typeof b.need).toBe('string');
    expect(b.door).toBe('one-way');
  }
});

test('OPENAB_ALIGNMENT_BLOCKERS covers target_agent, source, and gating topics', () => {
  const blob = JSON.stringify(OPENAB_ALIGNMENT_BLOCKERS).toLowerCase();
  expect(blob).toContain('target_agent');
  expect(blob).toContain('source');
  expect(blob).toContain('gating');
});

// ─── E5: OPENAB_ALIGNMENT_BLOCKERS extended to 6+ items ─────────────────────

test('E5 OPENAB_ALIGNMENT_BLOCKERS has the three new ids', () => {
  const ids = OPENAB_ALIGNMENT_BLOCKERS.map((b) => b.id);
  expect(ids).toContain('is_bot-drop');
  expect(ids).toContain('allowed_channels-isolation');
  expect(ids).toContain('message_id-requirement');
});

test('E5 OPENAB_ALIGNMENT_BLOCKERS length>=6 and every entry is a one-way door', () => {
  expect(Array.isArray(OPENAB_ALIGNMENT_BLOCKERS)).toBe(true);
  expect(OPENAB_ALIGNMENT_BLOCKERS.length).toBeGreaterThanOrEqual(6);
  for (const b of OPENAB_ALIGNMENT_BLOCKERS) {
    expect(typeof b.id).toBe('string');
    expect(typeof b.need).toBe('string');
    expect(b.door).toBe('one-way');
  }
});

test('E5 the three new blockers carry the required need keywords', () => {
  const byId = Object.fromEntries(
    OPENAB_ALIGNMENT_BLOCKERS.map((b) => [b.id, b.need.toLowerCase()])
  );
  const isBot = byId['is_bot-drop'] ?? '';
  expect(/allow_bot_messages|trusted_bot_ids/.test(isBot)).toBe(true);
  const allowed = byId['allowed_channels-isolation'] ?? '';
  expect(allowed).toContain('allowlist');
  expect(/before/.test(allowed)).toBe(true);
  const msgId = byId['message_id-requirement'] ?? '';
  expect(msgId).toContain('message_id');
  expect(/streaming|edit/.test(msgId)).toBe(true);
});

// ─── E6: OPENAB_MENTION_GATING.matchSemantics ────────────────────────────────

test('E6 OPENAB_MENTION_GATING.matchSemantics === exact-equality', () => {
  expect(OPENAB_MENTION_GATING.matchSemantics).toBe('exact-equality');
});

// ─── E7: mentionGatePasses exact-equality behavior ───────────────────────────

test("E7 mention '@mybot' does NOT match botUsername 'mybot' -> false (exact-equality)", () => {
  expect(mentionGatePasses({
    channelType: 'group', inThread: false,
    botUsername: 'mybot', mentions: ['@mybot'],
  })).toBe(false);
});

test("E7 mention 'mybot' matches botUsername 'mybot' -> true (control)", () => {
  expect(mentionGatePasses({
    channelType: 'group', inThread: false,
    botUsername: 'mybot', mentions: ['mybot'],
  })).toBe(true);
});
