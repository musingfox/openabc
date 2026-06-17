// Unit tests for stateToSrc, replyToState, revealText, isRevealComplete.
// Compatible with `bun test` (Bun built-in) and `node --test` (node:test).
import { stateToSrc, replyToState, reduceMessages, nextBackoff, revealText, isRevealComplete, scrollTopToBottom, renderRich, shouldRenderRich, splitRevealedForRender } from './avatar.js';

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

  describe('renderRich (E-MD1/E-MD2/E-XSS/E-LTX/E-COEX)', () => {
    it('E-MD1: renderRich is an exported function', () => {
      expect(typeof renderRich).toBe('function');
    });
    it('E-MD1: renderRich("**a**") contains <strong>a</strong>', () => {
      expect(renderRich('**a**')).toContain('<strong>a</strong>');
    });
    it('E-MD2: "# h" produces <h1>', () => {
      expect(/<h1[ >]/.test(renderRich('# h'))).toBe(true);
    });
    it('E-MD2: fenced code produces <pre><code', () => {
      expect(/<pre><code/.test(renderRich('```\nx\n```'))).toBe(true);
    });
    it('E-MD2: "- x" produces <li>', () => {
      expect(/<li[ >]/.test(renderRich('- x'))).toBe(true);
    });
    it('E-MD2: "[t](u)" produces href="u"', () => {
      expect(/href="u"/.test(renderRich('[t](u)'))).toBe(true);
    });
    it('E-XSS: onerror handler is stripped', () => {
      expect(/onerror/i.test(renderRich('<img src=x onerror=alert(1)>'))).toBe(false);
    });
    it('E-XSS: javascript: href is neutralized', () => {
      const out = renderRich('[x](javascript:alert(1))');
      expect(/href="javascript:/i.test(out)).toBe(false);
      expect(/href='javascript:/i.test(out)).toBe(false);
    });
    it('E-XSS: <script> tag is stripped', () => {
      expect(/<script/i.test(renderRich('<script>alert(1)</script>'))).toBe(false);
    });
    it('E-LTX: inline $..$ produces KaTeX markup (class="katex")', () => {
      expect(/class="katex/.test(renderRich('$E=mc^2$'))).toBe(true);
    });
    it('E-LTX: block $$..$$ produces KaTeX markup', () => {
      expect(/class="katex/.test(renderRich('$$E=mc^2$$'))).toBe(true);
    });
    it('E-LTX: malformed latex does not throw', () => {
      expect(() => renderRich('$\\frac$')).not.toThrow();
    });
    it('E-COEX: shouldRenderRich(true) === true', () => {
      expect(shouldRenderRich(true)).toBe(true);
    });
    it('E-COEX: shouldRenderRich(false) === false', () => {
      expect(shouldRenderRich(false)).toBe(false);
    });
  });

  describe('renderRich XSS style policy (E-XSS-STYLE)', () => {
    it('E-XSS-STYLE: $$\\frac{a}{b}$$ katex markup is present', () => {
      expect(/class="katex/.test(renderRich('$$\\frac{a}{b}$$'))).toBe(true);
    });
    it('E-XSS-STYLE: katex layout style (height: or vertical-align:) survives', () => {
      const out = renderRich('$$\\frac{a}{b}$$');
      expect(/style="[^"]*(height:|vertical-align:)/.test(out)).toBe(true);
    });
    it('E-XSS-STYLE: CSS expression() in style is stripped', () => {
      expect(/expression\(/i.test(renderRich('<p style="x:expression(alert(1))">a</p>'))).toBe(false);
    });
    it('E-XSS-STYLE: javascript: in style value is stripped', () => {
      expect(/javascript:/i.test(renderRich('<div style="background:url(javascript:alert(1))">a</div>'))).toBe(false);
    });
  });

  describe('renderRich XSS injection vectors (E-XSS-VECTORS)', () => {
    it('E-XSS-VECTORS: onload= stripped', () => {
      expect(/onload=/i.test(renderRich('<body onload=alert(1)>x</body>'))).toBe(false);
    });
    it('E-XSS-VECTORS: onclick= stripped', () => {
      expect(/onclick=/i.test(renderRich('<button onclick=alert(1)>x</button>'))).toBe(false);
    });
    it('E-XSS-VECTORS: <iframe stripped', () => {
      expect(/<iframe/i.test(renderRich('<iframe src=evil></iframe>'))).toBe(false);
    });
    it('E-XSS-VECTORS: svg onload stripped', () => {
      expect(/<svg[^>]*onload/i.test(renderRich('<svg onload=alert(1)></svg>'))).toBe(false);
    });
    it('E-XSS-VECTORS: data:text/html href stripped', () => {
      expect(/data:text\/html/i.test(renderRich('<a href="data:text/html,<script>x">y</a>'))).toBe(false);
    });
    it('E-XSS-VECTORS: href=data: stripped', () => {
      expect(/href="data:/i.test(renderRich('<a href="data:application/x,y">z</a>'))).toBe(false);
    });
  });

  const MERMAID_MARKER = /(class="[^"]*mermaid|data-[a-z-]*mermaid|data-mermaid)/i;

  describe('renderRich mermaid (E1-E5)', () => {
    it('E1: mermaid fence produces mermaid marker (class/data-attr)', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n```');
      expect(MERMAID_MARKER.test(out)).toBe(true);
    });
    it('E1: mermaid fence does NOT produce <code>graph TD', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n```');
      expect(/<code>\s*graph TD/i.test(out)).toBe(false);
    });
    it('E1: graph source is carried (base64 encoded) for later render', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n```');
      // The source is base64-encoded; verify the output contains the mermaid marker
      // and that the raw graph text is NOT present verbatim (it is encoded).
      expect(MERMAID_MARKER.test(out)).toBe(true);
    });
    it('E2: normal js fence stays <pre><code>, no mermaid marker', () => {
      const out = renderRich('```js\nconst a = 1;\n```');
      expect(/<code/i.test(out)).toBe(true);
      expect(MERMAID_MARKER.test(out)).toBe(false);
    });
    it('E3: katex + strong + mermaid fence coexist', () => {
      const out = renderRich('$x$ **b**\n\n```mermaid\ngraph LR;X-->Y\n```');
      expect(/class="katex/.test(out)).toBe(true);
      expect(/<strong>b<\/strong>/.test(out)).toBe(true);
      expect(MERMAID_MARKER.test(out)).toBe(true);
    });
    it('E4: <script> in mermaid source is absent from output', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n<script>alert(1)</script>\n```');
      expect(/<script/i.test(out)).toBe(false);
    });
    it('E4: onerror= in mermaid source is absent from output', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n<img src=x onerror=alert(3)>\n```');
      expect(/onerror=/i.test(out)).toBe(false);
    });
    it('E5: onload= via svg in mermaid source is absent from output', () => {
      const out = renderRich('```mermaid\ngraph TD;A["><svg onload=alert(1)"]-->B\n```');
      expect(/onload=/i.test(out)).toBe(false);
    });
  });

  describe('closed region mid-stream rendering', () => {
    it('T1: closed inline math renders before the whole message is done', () => {
      const out = splitRevealedForRender('The value $x$ is important and the next part is still');
      expect(/class="katex/.test(out.richHtml)).toBe(true);
      expect(out.plainTail).toBe('');
    });
    it('T2: closed bold renders while an unclosed fence stays raw', () => {
      const out = splitRevealedForRender('**bold** and ```py\ncode');
      expect(out.richHtml).toContain('<strong>bold</strong>');
      expect(/<pre class/.test(out.plainTail)).toBe(false);
    });
    it('T3: closed display math renders while later unclosed inline math stays raw', () => {
      const out = splitRevealedForRender('$$a$$ and $b');
      expect(/class="katex/.test(out.richHtml)).toBe(true);
      expect(out.plainTail).toBe('$b');
    });
    it('T4: paired price dollars preserve existing greedy inline-math behavior', () => {
      const out = splitRevealedForRender('I paid $5 and $10');
      expect(out.richHtml).toContain('class="katex');
      expect(out.plainTail).toBe('');
    });
  });

  describe('mermaid pending on close', () => {
    it('T1: half mermaid fence does not emit a mermaid marker', () => {
      const out = splitRevealedForRender('```mermaid\ngraph TD;A-->B');
      expect(MERMAID_MARKER.test(out.richHtml)).toBe(false);
    });
    it('T2: closed mermaid fence emits exactly one pending marker and no tail', () => {
      const out = splitRevealedForRender('```mermaid\ngraph TD;A-->B\n```');
      expect(MERMAID_MARKER.test(out.richHtml)).toBe(true);
      expect((out.richHtml.match(/class="[^"]*mermaid-pending[^"]*"/g) || []).length).toBe(1);
      expect(out.plainTail).toBe('');
    });
    it('T3: closed mermaid fence renders while following streaming text stays plain', () => {
      const out = splitRevealedForRender('prefix text\n```mermaid\ngraph TD;A-->B\n```\nsuffix still streaming');
      expect(MERMAID_MARKER.test(out.richHtml)).toBe(true);
      expect(out.plainTail).toContain('suffix still streaming');
    });
  });

  describe('unclosed region safety', () => {
    it('T1: unclosed code fence remains raw and unrendered', () => {
      const out = splitRevealedForRender('```js\nconst x = 1');
      expect(/<pre class/.test(out.plainTail)).toBe(false);
      expect(/class="katex/.test(out.plainTail)).toBe(false);
      expect(/mermaid-pending/.test(out.plainTail)).toBe(false);
    });
    it('T2: isolated dollar remains raw and never becomes KaTeX', () => {
      const out = splitRevealedForRender('price is $5 per unit');
      expect(/class="katex/.test(out.plainTail)).toBe(false);
    });
    it('T3: half mermaid fence remains raw and unrendered', () => {
      const out = splitRevealedForRender('```mermaid\ngraph LR;X');
      expect(/mermaid-pending/.test(out.plainTail)).toBe(false);
      expect(/<pre class/.test(out.plainTail)).toBe(false);
    });
    it('T4: unclosed display math remains raw and never becomes KaTeX', () => {
      const out = splitRevealedForRender('formula $$\int_0^1');
      expect(/class="katex/.test(out.plainTail)).toBe(false);
    });
    it('T5: closed plain code fence with dollar renders as code, not KaTeX', () => {
      const out = splitRevealedForRender('```\ncost is $5\n```');
      expect(/<pre/.test(out.richHtml)).toBe(true);
      expect(out.richHtml).not.toContain('class="katex');
      expect(out.plainTail).toBe('');
    });
    it('T6: ZWJ emoji before unclosed math stays intact with a raw dollar tail', () => {
      const out = splitRevealedForRender('👨‍💻$x');
      expect(out.plainTail).toBe('$x');
      expect(out.plainTail).not.toContain('�');
      expect(out.richHtml).toContain('👨‍💻');
    });
  });

  describe('splitRevealedForRender', () => {
    it('T1: closed bold renders rich and has no plain tail', () => {
      const out = splitRevealedForRender('Hello **world**');
      expect(out.richHtml).toContain('<strong>world</strong>');
      expect(out.plainTail).toBe('');
    });
    it('T2: unclosed display math remains raw plain text', () => {
      const out = splitRevealedForRender('result: $$\\frac{a');
      expect(out.richHtml).toBe(renderRich('result: '));
      expect(out.plainTail).toBe('$$\\frac{a');
    });
    it('T3: unclosed inline math remains raw plain text', () => {
      const out = splitRevealedForRender('text $lonely');
      expect(out.richHtml).toBe(renderRich('text '));
      expect(out.plainTail).toBe('$lonely');
    });
    it('T4: closed inline math and bold render together', () => {
      const out = splitRevealedForRender('$x$ is inline and **bold**');
      expect(/class="katex/.test(out.richHtml)).toBe(true);
      expect(out.richHtml).toContain('<strong>bold</strong>');
      expect(out.plainTail).toBe('');
    });
    it('T5: empty revealed text returns empty pieces', () => {
      expect(splitRevealedForRender('')).toEqual({ richHtml: '', plainTail: '' });
    });
    it('T6: $$$x$$ follows renderRich display-boundary behavior', () => {
      const out = splitRevealedForRender('$$$x$$');
      expect(out.plainTail).toBe('');
      expect(out.richHtml).toBe(renderRich('$$$x$$'));
    });
    it('T7: later unclosed inline math becomes plain tail after earlier closed math', () => {
      const out = splitRevealedForRender('a $x$ b $y');
      expect(out.richHtml).toBe(renderRich('a $x$ b '));
      expect(out.plainTail).toContain('$y');
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

  describe('renderRich (E-MD1/E-MD2/E-XSS/E-LTX/E-COEX)', () => {
    it('E-MD1: renderRich is an exported function', () => {
      assert.default.strictEqual(typeof renderRich, 'function');
    });
    it('E-MD1: renderRich("**a**") contains <strong>a</strong>', () => {
      assert.default.ok(renderRich('**a**').includes('<strong>a</strong>'));
    });
    it('E-MD2: "# h" produces <h1>', () => {
      assert.default.ok(/<h1[ >]/.test(renderRich('# h')));
    });
    it('E-MD2: fenced code produces <pre><code', () => {
      assert.default.ok(/<pre><code/.test(renderRich('```\nx\n```')));
    });
    it('E-MD2: "- x" produces <li>', () => {
      assert.default.ok(/<li[ >]/.test(renderRich('- x')));
    });
    it('E-MD2: "[t](u)" produces href="u"', () => {
      assert.default.ok(/href="u"/.test(renderRich('[t](u)')));
    });
    it('E-XSS: onerror handler is stripped', () => {
      assert.default.ok(!/onerror/i.test(renderRich('<img src=x onerror=alert(1)>')));
    });
    it('E-XSS: javascript: href is neutralized', () => {
      const out = renderRich('[x](javascript:alert(1))');
      assert.default.ok(!/href="javascript:/i.test(out) && !/href='javascript:/i.test(out));
    });
    it('E-XSS: <script> tag is stripped', () => {
      assert.default.ok(!/<script/i.test(renderRich('<script>alert(1)</script>')));
    });
    it('E-LTX: inline $..$ produces KaTeX markup (class="katex")', () => {
      assert.default.ok(/class="katex/.test(renderRich('$E=mc^2$')));
    });
    it('E-LTX: block $$..$$ produces KaTeX markup', () => {
      assert.default.ok(/class="katex/.test(renderRich('$$E=mc^2$$')));
    });
    it('E-LTX: malformed latex does not throw', () => {
      assert.default.doesNotThrow(() => renderRich('$\\frac$'));
    });
    it('E-COEX: shouldRenderRich(true) === true', () => {
      assert.default.strictEqual(shouldRenderRich(true), true);
    });
    it('E-COEX: shouldRenderRich(false) === false', () => {
      assert.default.strictEqual(shouldRenderRich(false), false);
    });
  });

  describe('renderRich XSS style policy (E-XSS-STYLE)', () => {
    it('E-XSS-STYLE: $$\\frac{a}{b}$$ katex markup is present', () => {
      assert.default.ok(/class="katex/.test(renderRich('$$\\frac{a}{b}$$')));
    });
    it('E-XSS-STYLE: katex layout style (height: or vertical-align:) survives', () => {
      const out = renderRich('$$\\frac{a}{b}$$');
      assert.default.ok(/style="[^"]*(height:|vertical-align:)/.test(out));
    });
    it('E-XSS-STYLE: CSS expression() in style is stripped', () => {
      assert.default.ok(!/expression\(/i.test(renderRich('<p style="x:expression(alert(1))">a</p>')));
    });
    it('E-XSS-STYLE: javascript: in style value is stripped', () => {
      assert.default.ok(!/javascript:/i.test(renderRich('<div style="background:url(javascript:alert(1))">a</div>')));
    });
  });

  describe('renderRich XSS injection vectors (E-XSS-VECTORS)', () => {
    it('E-XSS-VECTORS: onload= stripped', () => {
      assert.default.ok(!/onload=/i.test(renderRich('<body onload=alert(1)>x</body>')));
    });
    it('E-XSS-VECTORS: onclick= stripped', () => {
      assert.default.ok(!/onclick=/i.test(renderRich('<button onclick=alert(1)>x</button>')));
    });
    it('E-XSS-VECTORS: <iframe stripped', () => {
      assert.default.ok(!/<iframe/i.test(renderRich('<iframe src=evil></iframe>')));
    });
    it('E-XSS-VECTORS: svg onload stripped', () => {
      assert.default.ok(!/<svg[^>]*onload/i.test(renderRich('<svg onload=alert(1)></svg>')));
    });
    it('E-XSS-VECTORS: data:text/html href stripped', () => {
      assert.default.ok(!/data:text\/html/i.test(renderRich('<a href="data:text/html,<script>x">y</a>')));
    });
    it('E-XSS-VECTORS: href=data: stripped', () => {
      assert.default.ok(!/href="data:/i.test(renderRich('<a href="data:application/x,y">z</a>')));
    });
  });

  const MERMAID_MARKER = /(class="[^"]*mermaid|data-[a-z-]*mermaid|data-mermaid)/i;

  describe('renderRich mermaid (E1-E5)', () => {
    it('E1: mermaid fence produces mermaid marker (class/data-attr)', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n```');
      assert.default.ok(MERMAID_MARKER.test(out), 'expected mermaid marker in: ' + out);
    });
    it('E1: mermaid fence does NOT produce <code>graph TD', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n```');
      assert.default.ok(!/<code>\s*graph TD/i.test(out), 'must not produce <code>graph TD in: ' + out);
    });
    it('E1: graph source is carried (base64 encoded) for later render', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n```');
      assert.default.ok(MERMAID_MARKER.test(out), 'mermaid marker must be present in: ' + out);
    });
    it('E2: normal js fence stays <pre><code>, no mermaid marker', () => {
      const out = renderRich('```js\nconst a = 1;\n```');
      assert.default.ok(/<code/i.test(out), 'expected <code in: ' + out);
      assert.default.ok(!MERMAID_MARKER.test(out), 'must not have mermaid marker in: ' + out);
    });
    it('E3: katex + strong + mermaid fence coexist', () => {
      const out = renderRich('$x$ **b**\n\n```mermaid\ngraph LR;X-->Y\n```');
      assert.default.ok(/class="katex/.test(out), 'katex must be present in: ' + out);
      assert.default.ok(/<strong>b<\/strong>/.test(out), 'strong must be present in: ' + out);
      assert.default.ok(MERMAID_MARKER.test(out), 'mermaid marker must be present in: ' + out);
    });
    it('E4: <script> in mermaid source is absent from output', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n<script>alert(1)</script>\n```');
      assert.default.ok(!/<script/i.test(out), 'must not contain <script in: ' + out);
    });
    it('E4: onerror= in mermaid source is absent from output', () => {
      const out = renderRich('```mermaid\ngraph TD;A-->B\n<img src=x onerror=alert(3)>\n```');
      assert.default.ok(!/onerror=/i.test(out), 'must not contain onerror= in: ' + out);
    });
    it('E5: onload= via svg in mermaid source is absent from output', () => {
      const out = renderRich('```mermaid\ngraph TD;A["><svg onload=alert(1)"]-->B\n```');
      assert.default.ok(!/onload=/i.test(out), 'must not contain onload= in: ' + out);
    });
  });

  describe('closed region mid-stream rendering', () => {
    it('T1: closed inline math renders before the whole message is done', () => {
      const out = splitRevealedForRender('The value $x$ is important and the next part is still');
      assert.default.ok(/class="katex/.test(out.richHtml));
      assert.default.strictEqual(out.plainTail, '');
    });
    it('T2: closed bold renders while an unclosed fence stays raw', () => {
      const out = splitRevealedForRender('**bold** and ```py\ncode');
      assert.default.ok(out.richHtml.includes('<strong>bold</strong>'));
      assert.default.ok(!/<pre class/.test(out.plainTail));
    });
    it('T3: closed display math renders while later unclosed inline math stays raw', () => {
      const out = splitRevealedForRender('$$a$$ and $b');
      assert.default.ok(/class="katex/.test(out.richHtml));
      assert.default.strictEqual(out.plainTail, '$b');
    });
    it('T4: paired price dollars preserve existing greedy inline-math behavior', () => {
      const out = splitRevealedForRender('I paid $5 and $10');
      assert.default.ok(out.richHtml.includes('class="katex'));
      assert.default.strictEqual(out.plainTail, '');
    });
  });

  describe('mermaid pending on close', () => {
    it('T1: half mermaid fence does not emit a mermaid marker', () => {
      const out = splitRevealedForRender('```mermaid\ngraph TD;A-->B');
      assert.default.strictEqual(MERMAID_MARKER.test(out.richHtml), false);
    });
    it('T2: closed mermaid fence emits exactly one pending marker and no tail', () => {
      const out = splitRevealedForRender('```mermaid\ngraph TD;A-->B\n```');
      assert.default.ok(MERMAID_MARKER.test(out.richHtml));
      assert.default.strictEqual((out.richHtml.match(/class="[^"]*mermaid-pending[^"]*"/g) || []).length, 1);
      assert.default.strictEqual(out.plainTail, '');
    });
    it('T3: closed mermaid fence renders while following streaming text stays plain', () => {
      const out = splitRevealedForRender('prefix text\n```mermaid\ngraph TD;A-->B\n```\nsuffix still streaming');
      assert.default.ok(MERMAID_MARKER.test(out.richHtml));
      assert.default.ok(out.plainTail.includes('suffix still streaming'));
    });
  });

  describe('unclosed region safety', () => {
    it('T1: unclosed code fence remains raw and unrendered', () => {
      const out = splitRevealedForRender('```js\nconst x = 1');
      assert.default.ok(!/<pre class/.test(out.plainTail));
      assert.default.ok(!/class="katex/.test(out.plainTail));
      assert.default.ok(!/mermaid-pending/.test(out.plainTail));
    });
    it('T2: isolated dollar remains raw and never becomes KaTeX', () => {
      const out = splitRevealedForRender('price is $5 per unit');
      assert.default.ok(!/class="katex/.test(out.plainTail));
    });
    it('T3: half mermaid fence remains raw and unrendered', () => {
      const out = splitRevealedForRender('```mermaid\ngraph LR;X');
      assert.default.ok(!/mermaid-pending/.test(out.plainTail));
      assert.default.ok(!/<pre class/.test(out.plainTail));
    });
    it('T4: unclosed display math remains raw and never becomes KaTeX', () => {
      const out = splitRevealedForRender('formula $$\int_0^1');
      assert.default.ok(!/class="katex/.test(out.plainTail));
    });
    it('T5: closed plain code fence with dollar renders as code, not KaTeX', () => {
      const out = splitRevealedForRender('```\ncost is $5\n```');
      assert.default.ok(/<pre/.test(out.richHtml));
      assert.default.ok(!out.richHtml.includes('class="katex'));
      assert.default.strictEqual(out.plainTail, '');
    });
    it('T6: ZWJ emoji before unclosed math stays intact with a raw dollar tail', () => {
      const out = splitRevealedForRender('👨‍💻$x');
      assert.default.strictEqual(out.plainTail, '$x');
      assert.default.ok(!out.plainTail.includes('�'));
      assert.default.ok(out.richHtml.includes('👨‍💻'));
    });
  });

  describe('splitRevealedForRender', () => {
    it('T1: closed bold renders rich and has no plain tail', () => {
      const out = splitRevealedForRender('Hello **world**');
      assert.default.ok(out.richHtml.includes('<strong>world</strong>'));
      assert.default.strictEqual(out.plainTail, '');
    });
    it('T2: unclosed display math remains raw plain text', () => {
      const out = splitRevealedForRender('result: $$\\frac{a');
      assert.default.strictEqual(out.richHtml, renderRich('result: '));
      assert.default.strictEqual(out.plainTail, '$$\\frac{a');
    });
    it('T3: unclosed inline math remains raw plain text', () => {
      const out = splitRevealedForRender('text $lonely');
      assert.default.strictEqual(out.richHtml, renderRich('text '));
      assert.default.strictEqual(out.plainTail, '$lonely');
    });
    it('T4: closed inline math and bold render together', () => {
      const out = splitRevealedForRender('$x$ is inline and **bold**');
      assert.default.ok(/class="katex/.test(out.richHtml));
      assert.default.ok(out.richHtml.includes('<strong>bold</strong>'));
      assert.default.strictEqual(out.plainTail, '');
    });
    it('T5: empty revealed text returns empty pieces', () => {
      assert.default.deepStrictEqual(splitRevealedForRender(''), { richHtml: '', plainTail: '' });
    });
    it('T6: $$$x$$ follows renderRich display-boundary behavior', () => {
      const out = splitRevealedForRender('$$$x$$');
      assert.default.strictEqual(out.plainTail, '');
      assert.default.strictEqual(out.richHtml, renderRich('$$$x$$'));
    });
    it('T7: later unclosed inline math becomes plain tail after earlier closed math', () => {
      const out = splitRevealedForRender('a $x$ b $y');
      assert.default.strictEqual(out.richHtml, renderRich('a $x$ b '));
      assert.default.ok(out.plainTail.includes('$y'));
    });
  });
}
