// Unit tests for stateToSrc, replyToState, revealText, isRevealComplete.
// Compatible with `bun test` (Bun built-in) and `node --test` (node:test).
import { stateToSrc, replyToState, reduceMessages, nextBackoff, revealText, isRevealComplete, scrollTopToBottom } from './avatar.js';

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

  describe('nextBackoff', () => {
    // B1: attempt 0 => BASE (500ms)
    it('B1: attempt 0 => 500', () => {
      expect(nextBackoff(0)).toBe(500);
    });
    // B2: doubles each attempt
    it('B2: attempt 1 => 1000, attempt 3 => 4000', () => {
      expect(nextBackoff(1)).toBe(1000);
      expect(nextBackoff(3)).toBe(4000);
    });
    // B3: capped at MAX (10000ms)
    it('B3: large attempt capped at 10000', () => {
      expect(nextBackoff(20)).toBe(10000);
    });
    // B4: invalid input treated as attempt 0
    it('B4: negative / NaN => 500', () => {
      expect(nextBackoff(-5)).toBe(500);
      expect(nextBackoff(NaN)).toBe(500);
    });
  });

  describe('revealText', () => {
    // E1: pure reveal function, ASCII regression (grapheme === char for ASCII)
    it('E1: charsShown=0 => empty string', () => {
      expect(revealText('hello', 0)).toBe('');
    });
    it('E1: charsShown=3 => first 3 chars', () => {
      expect(revealText('hello', 3)).toBe('hel');
    });
    it('E1: charsShown >= length => full text (clamped)', () => {
      expect(revealText('hello', 99)).toBe('hello');
    });
    it('E1: charsShown=length => full text', () => {
      expect(revealText('hello', 5)).toBe('hello');
    });
    it('E1: negative charsShown => empty string', () => {
      expect(revealText('hello', -1)).toBe('');
    });
    // E1 grapheme-level: combining characters
    it('E1 grapheme: "héllo",1 => "h"', () => {
      expect(revealText('héllo', 1)).toBe('h');
    });
    it('E1 grapheme: "héllo",2 => "hé" (combining é = 1 grapheme)', () => {
      expect(revealText('héllo', 2)).toBe('hé');
    });
    // E1 grapheme-level: CJK
    it('E1 grapheme: "你好世界",2 => "你好"', () => {
      expect(revealText('你好世界', 2)).toBe('你好');
    });
    // E5e: ZWJ cluster = 1 grapheme
    it('E5e: revealText("a👨‍💻b",2) => "a👨‍💻" (ZWJ cluster=1 grapheme)', () => {
      expect(revealText('a👨‍💻b', 2)).toBe('a👨‍💻');
    });
    it('E5e: no U+FFFD in any prefix of "a👨‍💻b"', () => {
      const src = 'a👨‍💻b';
      const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
      const total = [...seg.segment(src)].length;
      for (let n = 0; n <= total; n++) {
        expect(revealText(src, n).includes('�')).toBe(false);
      }
    });
  });

  describe('isRevealComplete', () => {
    // E2: done predicate — ASCII regression
    it('E2: mid-reveal => false', () => {
      expect(isRevealComplete('hello', 2)).toBe(false);
    });
    it('E2: exactly at length => true', () => {
      expect(isRevealComplete('hello', 5)).toBe(true);
    });
    it('E2: past length => true', () => {
      expect(isRevealComplete('hello', 99)).toBe(true);
    });
    it('E2: zero => false for non-empty', () => {
      expect(isRevealComplete('hello', 0)).toBe(false);
    });
    // E2 grapheme granularity: "héllo" has 5 graphemes (é = combining = 1 grapheme)
    it('E2 grapheme: isRevealComplete("héllo",2) => false', () => {
      expect(isRevealComplete('héllo', 2)).toBe(false);
    });
    it('E2 grapheme: isRevealComplete("héllo",5) => true (5 graphemes)', () => {
      expect(isRevealComplete('héllo', 5)).toBe(true);
    });
  });

  describe('Intl.Segmenter (E7)', () => {
    it('E7: Intl.Segmenter is available', () => {
      expect(typeof Intl.Segmenter).toBe('function');
    });
    it('E7: segment("👨‍💻") count===1 (ZWJ cluster)', () => {
      const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
      const count = [...seg.segment('👨‍💻')].length;
      expect(count).toBe(1);
    });
  });

  describe('scrollTopToBottom (E10)', () => {
    it('E10: overflow case: scrollHeight=1000, clientHeight=200 => 800', () => {
      expect(scrollTopToBottom({ scrollHeight: 1000, clientHeight: 200 })).toBe(800);
    });
    it('E10: non-overflow case: scrollHeight=50, clientHeight=200 => 0', () => {
      expect(scrollTopToBottom({ scrollHeight: 50, clientHeight: 200 })).toBe(0);
    });
    it('E10: never negative: scrollHeight=0, clientHeight=200 => 0', () => {
      expect(scrollTopToBottom({ scrollHeight: 0, clientHeight: 200 })).toBe(0);
    });
    it('E10: equal: scrollHeight=200, clientHeight=200 => 0', () => {
      expect(scrollTopToBottom({ scrollHeight: 200, clientHeight: 200 })).toBe(0);
    });
  });

  describe('streaming-only-agent (E3)', () => {
    // E3: you message is NOT marked for reveal — reduceMessages returns from:'you' unchanged
    it('E3: you message appended without reveal flag', () => {
      // reduceMessages only appends agent messages; you messages are added directly in App.svelte.
      // Here we verify reduceMessages does NOT produce a you entry from WS push.
      const msgs = [{ from: 'you', text: 'hello' }];
      const result = reduceMessages(msgs, { type: 'message', text: 'reply' });
      expect(result.length).toBe(2);
      expect(result[0].from).toBe('you');
      // you message has no reveal property
      expect(result[0].reveal).toBeUndefined();
    });
    it('E3: agent message from WS has from=agent (streaming target)', () => {
      const result = reduceMessages([], { type: 'message', text: 'agent text' });
      expect(result[0].from).toBe('agent');
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

  describe('nextBackoff', () => {
    it('B1: attempt 0 => 500', () => {
      assert.default.strictEqual(nextBackoff(0), 500);
    });
    it('B2: attempt 1 => 1000, attempt 3 => 4000', () => {
      assert.default.strictEqual(nextBackoff(1), 1000);
      assert.default.strictEqual(nextBackoff(3), 4000);
    });
    it('B3: large attempt capped at 10000', () => {
      assert.default.strictEqual(nextBackoff(20), 10000);
    });
    it('B4: negative / NaN => 500', () => {
      assert.default.strictEqual(nextBackoff(-5), 500);
      assert.default.strictEqual(nextBackoff(NaN), 500);
    });
  });

  describe('revealText', () => {
    it('E1: charsShown=0 => empty string', () => {
      assert.default.strictEqual(revealText('hello', 0), '');
    });
    it('E1: charsShown=3 => first 3 chars', () => {
      assert.default.strictEqual(revealText('hello', 3), 'hel');
    });
    it('E1: charsShown >= length => full text (clamped)', () => {
      assert.default.strictEqual(revealText('hello', 99), 'hello');
    });
    it('E1: charsShown=length => full text', () => {
      assert.default.strictEqual(revealText('hello', 5), 'hello');
    });
    it('E1: negative charsShown => empty string', () => {
      assert.default.strictEqual(revealText('hello', -1), '');
    });
    it('E1 grapheme: "héllo",1 => "h"', () => {
      assert.default.strictEqual(revealText('héllo', 1), 'h');
    });
    it('E1 grapheme: "héllo",2 => "hé"', () => {
      assert.default.strictEqual(revealText('héllo', 2), 'hé');
    });
    it('E1 grapheme: "你好世界",2 => "你好"', () => {
      assert.default.strictEqual(revealText('你好世界', 2), '你好');
    });
    it('E5e: revealText("a👨‍💻b",2) => "a👨‍💻"', () => {
      assert.default.strictEqual(revealText('a👨‍💻b', 2), 'a👨‍💻');
    });
    it('E5e: no U+FFFD in any prefix of "a👨‍💻b"', () => {
      const src = 'a👨‍💻b';
      const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
      const total = [...seg.segment(src)].length;
      for (let n = 0; n <= total; n++) {
        assert.default.ok(!revealText(src, n).includes('�'), `prefix ${n} must not contain U+FFFD`);
      }
    });
  });

  describe('isRevealComplete', () => {
    it('E2: mid-reveal => false', () => {
      assert.default.strictEqual(isRevealComplete('hello', 2), false);
    });
    it('E2: exactly at length => true', () => {
      assert.default.strictEqual(isRevealComplete('hello', 5), true);
    });
    it('E2: past length => true', () => {
      assert.default.strictEqual(isRevealComplete('hello', 99), true);
    });
    it('E2: zero => false for non-empty', () => {
      assert.default.strictEqual(isRevealComplete('hello', 0), false);
    });
    it('E2 grapheme: isRevealComplete("héllo",2) => false', () => {
      assert.default.strictEqual(isRevealComplete('héllo', 2), false);
    });
    it('E2 grapheme: isRevealComplete("héllo",5) => true', () => {
      assert.default.strictEqual(isRevealComplete('héllo', 5), true);
    });
  });

  describe('Intl.Segmenter (E7)', () => {
    it('E7: Intl.Segmenter is available', () => {
      assert.default.strictEqual(typeof Intl.Segmenter, 'function');
    });
    it('E7: segment("👨‍💻") count===1', () => {
      const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
      const count = [...seg.segment('👨‍💻')].length;
      assert.default.strictEqual(count, 1);
    });
  });

  describe('scrollTopToBottom (E10)', () => {
    it('E10: overflow case: scrollHeight=1000, clientHeight=200 => 800', () => {
      assert.default.strictEqual(scrollTopToBottom({ scrollHeight: 1000, clientHeight: 200 }), 800);
    });
    it('E10: non-overflow case: scrollHeight=50, clientHeight=200 => 0', () => {
      assert.default.strictEqual(scrollTopToBottom({ scrollHeight: 50, clientHeight: 200 }), 0);
    });
    it('E10: never negative: scrollHeight=0, clientHeight=200 => 0', () => {
      assert.default.strictEqual(scrollTopToBottom({ scrollHeight: 0, clientHeight: 200 }), 0);
    });
    it('E10: equal: scrollHeight=200, clientHeight=200 => 0', () => {
      assert.default.strictEqual(scrollTopToBottom({ scrollHeight: 200, clientHeight: 200 }), 0);
    });
  });

  describe('streaming-only-agent (E3)', () => {
    it('E3: you message has no reveal flag from reduceMessages', () => {
      const msgs = [{ from: 'you', text: 'hello' }];
      const result = reduceMessages(msgs, { type: 'message', text: 'reply' });
      assert.default.strictEqual(result.length, 2);
      assert.default.strictEqual(result[0].from, 'you');
      assert.default.strictEqual(result[0].reveal, undefined);
    });
    it('E3: agent message from WS has from=agent (streaming target)', () => {
      const result = reduceMessages([], { type: 'message', text: 'agent text' });
      assert.default.strictEqual(result[0].from, 'agent');
    });
  });
}
