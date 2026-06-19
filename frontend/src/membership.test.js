import { test, expect } from 'bun:test';
import {
  addAgent,
  removeAgent,
  agentsOf,
  routingTargetFor,
  routingAmbiguous,
  OPENAB_LIMITS,
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
