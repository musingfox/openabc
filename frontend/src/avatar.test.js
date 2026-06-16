// Unit tests for stateToSrc and replyToState.
// Compatible with `bun test` (Bun built-in) and `node --test` (node:test).
import { stateToSrc, replyToState, reduceMessages } from './avatar.js';

// Detect runner: bun vs node:test
const isBun = typeof Bun !== 'undefined';

if (isBun) {
  const { describe, it, expect } = await import('bun:test');

  describe('stateToSrc', () => {
    it('maps idle to /assets/idle.png', () => {
      expect(stateToSrc('idle')).toBe('/assets/idle.png');
    });
    it('maps speaking to /assets/speaking.png', () => {
      expect(stateToSrc('speaking')).toBe('/assets/speaking.png');
    });
    it('maps listening to /assets/listening.png', () => {
      expect(stateToSrc('listening')).toBe('/assets/listening.png');
    });
    it('maps thinking to /assets/thinking.png', () => {
      expect(stateToSrc('thinking')).toBe('/assets/thinking.png');
    });
    it('returns fallback/idle for unknown state', () => {
      expect(stateToSrc('unknown')).toBe('/assets/idle.png');
      expect(stateToSrc('')).toBe('/assets/idle.png');
      expect(stateToSrc(undefined)).toBe('/assets/idle.png');
    });
  });

  describe('replyToState', () => {
    it('maps a message reply to speaking', () => {
      expect(replyToState({ type: 'message', text: 'hello' })).toBe('speaking');
    });
    it('returns idle for null (no reply)', () => {
      expect(replyToState(null)).toBe('idle');
    });
    it('returns idle for undefined (no reply)', () => {
      expect(replyToState(undefined)).toBe('idle');
    });
    it('returns idle fallback for unknown type', () => {
      expect(replyToState({ type: 'unknown' })).toBe('idle');
    });
    it('returns idle for empty object', () => {
      expect(replyToState({})).toBe('idle');
    });

    // J1: emoji -> state mapping
    it('J1: 👀 reaction -> listening', () => {
      expect(replyToState({ type: 'reaction', text: '👀' })).toBe('listening');
    });
    it('J1: 🤔 reaction -> thinking', () => {
      expect(replyToState({ type: 'reaction', text: '🤔' })).toBe('thinking');
    });
    it('J1: 🆗 reaction -> speaking', () => {
      expect(replyToState({ type: 'reaction', text: '🆗' })).toBe('speaking');
    });
    it('J1: 💪 reaction -> speaking', () => {
      expect(replyToState({ type: 'reaction', text: '💪' })).toBe('speaking');
    });

    // J2: full emoji set -> non-idle states (previously unknown emojis now mapped)
    it('J2: 🥱 reaction -> thinking (stall-soft)', () => {
      expect(replyToState({ type: 'reaction', text: '🥱' })).toBe('thinking');
    });
    it('J2: 😨 reaction -> thinking (stall-hard)', () => {
      expect(replyToState({ type: 'reaction', text: '😨' })).toBe('thinking');
    });
    it('J2: 🔥 reaction -> speaking (tool)', () => {
      expect(replyToState({ type: 'reaction', text: '🔥' })).toBe('speaking');
    });

    // J4: full emoji set coverage
    it('J4: 👨‍💻 reaction -> speaking (coding)', () => {
      expect(replyToState({ type: 'reaction', text: '👨‍💻' })).toBe('speaking');
    });
    it('J4: ⚡ reaction -> speaking (web)', () => {
      expect(replyToState({ type: 'reaction', text: '⚡' })).toBe('speaking');
    });
    it('J4: 😱 reaction -> thinking (error)', () => {
      expect(replyToState({ type: 'reaction', text: '😱' })).toBe('thinking');
    });

    // J5: unknown emoji -> idle fallback
    it('J5: unknown emoji 🎉 reaction -> idle (fallback)', () => {
      expect(replyToState({ type: 'reaction', text: '🎉' })).toBe('idle');
    });

    // J3: remove reaction -> idle
    it('J3: reaction with op=remove -> idle', () => {
      expect(replyToState({ type: 'reaction', op: 'remove', text: '👀' })).toBe('idle');
    });
  });

  describe('reduceMessages', () => {
    // E-RED: reaction push must NOT enter the messages array
    it('E-RED: reaction push => messages unchanged (length 0)', () => {
      const result = reduceMessages([], { type: 'reaction', op: 'add', text: '👀' });
      expect(result.length).toBe(0);
    });

    // E-MSG: message push with text => appended as {from:'agent', text}
    it('E-MSG: message push with text => length 1, from=agent, text preserved', () => {
      const result = reduceMessages([], { type: 'message', text: 'hi' });
      expect(result.length).toBe(1);
      expect(result[0].from).toBe('agent');
      expect(result[0].text).toBe('hi');
    });

    // E-MSG: message push without text => unchanged
    it('E-MSG: message push without text => unchanged', () => {
      const result = reduceMessages([], { type: 'message' });
      expect(result.length).toBe(0);
    });
  });
} else {
  // node:test path
  const { describe, it } = await import('node:test');
  const assert = await import('node:assert/strict');

  describe('stateToSrc', () => {
    it('maps idle to /assets/idle.png', () => {
      assert.default.strictEqual(stateToSrc('idle'), '/assets/idle.png');
    });
    it('maps speaking to /assets/speaking.png', () => {
      assert.default.strictEqual(stateToSrc('speaking'), '/assets/speaking.png');
    });
    it('maps listening to /assets/listening.png', () => {
      assert.default.strictEqual(stateToSrc('listening'), '/assets/listening.png');
    });
    it('maps thinking to /assets/thinking.png', () => {
      assert.default.strictEqual(stateToSrc('thinking'), '/assets/thinking.png');
    });
    it('returns fallback/idle for unknown/default/invalid state', () => {
      assert.default.strictEqual(stateToSrc('unknown'), '/assets/idle.png');
      assert.default.strictEqual(stateToSrc(''), '/assets/idle.png');
      assert.default.strictEqual(stateToSrc(undefined), '/assets/idle.png');
    });
  });

  describe('replyToState', () => {
    it('maps a message reply to speaking', () => {
      assert.default.strictEqual(replyToState({ type: 'message', text: 'hello' }), 'speaking');
    });
    it('returns idle for null (no reply)', () => {
      assert.default.strictEqual(replyToState(null), 'idle');
    });
    it('returns idle for undefined (no reply)', () => {
      assert.default.strictEqual(replyToState(undefined), 'idle');
    });
    it('returns idle fallback for unknown type', () => {
      assert.default.strictEqual(replyToState({ type: 'unknown' }), 'idle');
    });
    it('returns idle for empty object', () => {
      assert.default.strictEqual(replyToState({}), 'idle');
    });

    // J1: emoji -> state mapping
    it('J1: 👀 reaction -> listening', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '👀' }), 'listening');
    });
    it('J1: 🤔 reaction -> thinking', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '🤔' }), 'thinking');
    });
    it('J1: 🆗 reaction -> speaking', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '🆗' }), 'speaking');
    });
    it('J1: 💪 reaction -> speaking', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '💪' }), 'speaking');
    });

    // J2: full emoji set -> non-idle states (previously unknown emojis now mapped)
    it('J2: 🥱 reaction -> thinking (stall-soft)', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '🥱' }), 'thinking');
    });
    it('J2: 😨 reaction -> thinking (stall-hard)', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '😨' }), 'thinking');
    });
    it('J2: 🔥 reaction -> speaking (tool)', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '🔥' }), 'speaking');
    });

    // J4: full emoji set coverage
    it('J4: 👨‍💻 reaction -> speaking (coding)', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '👨‍💻' }), 'speaking');
    });
    it('J4: ⚡ reaction -> speaking (web)', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '⚡' }), 'speaking');
    });
    it('J4: 😱 reaction -> thinking (error)', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '😱' }), 'thinking');
    });

    // J5: unknown emoji -> idle fallback
    it('J5: unknown emoji 🎉 reaction -> idle (fallback)', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', text: '🎉' }), 'idle');
    });

    // J3: remove reaction -> idle
    it('J3: reaction with op=remove -> idle', () => {
      assert.default.strictEqual(replyToState({ type: 'reaction', op: 'remove', text: '👀' }), 'idle');
    });
  });

  describe('reduceMessages', () => {
    // E-RED: reaction push must NOT enter the messages array
    it('E-RED: reaction push => messages unchanged (length 0)', () => {
      const result = reduceMessages([], { type: 'reaction', op: 'add', text: '👀' });
      assert.default.strictEqual(result.length, 0);
    });

    // E-MSG: message push with text => appended as {from:'agent', text}
    it('E-MSG: message push with text => length 1, from=agent, text preserved', () => {
      const result = reduceMessages([], { type: 'message', text: 'hi' });
      assert.default.strictEqual(result.length, 1);
      assert.default.strictEqual(result[0].from, 'agent');
      assert.default.strictEqual(result[0].text, 'hi');
    });

    // E-MSG: message push without text => unchanged
    it('E-MSG: message push without text => unchanged', () => {
      const result = reduceMessages([], { type: 'message' });
      assert.default.strictEqual(result.length, 0);
    });
  });
}
