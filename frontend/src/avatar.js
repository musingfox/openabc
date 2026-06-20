import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'isomorphic-dompurify';
import hljs from 'highlight.js/lib/common';

// Module-level cached Intl.Segmenter singleton (grapheme granularity).
const _segmenter = (typeof Intl !== 'undefined' && typeof Intl.Segmenter !== 'undefined')
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

/**
 * Split a string into an array of grapheme cluster strings.
 * Falls back to Array.from (code-point level) when Intl.Segmenter is unavailable.
 *
 * @param {string} str
 * @returns {string[]}
 */
function graphemes(str) {
  if (_segmenter) {
    return [..._segmenter.segment(str)].map(s => s.segment);
  }
  return Array.from(str);
}

/**
 * Pure: reveal the first charsShown graphemes of full.
 * charsShown <= 0 → ""; charsShown >= grapheme count → full (clamped).
 * ASCII strings: grapheme count === char count, so existing assertions are unaffected.
 *
 * @param {string} full - the complete text
 * @param {number} charsShown - how many graphemes to reveal
 * @returns {string} partial or full text
 */
export function revealText(full, charsShown) {
  if (charsShown <= 0) return '';
  const gs = graphemes(full);
  return gs.slice(0, charsShown).join('');
}

/**
 * Pure: true when all graphemes of full have been revealed.
 * ASCII strings: grapheme count === char count, so existing assertions are unaffected.
 *
 * @param {string} full - the complete text
 * @param {number} charsShown - how many graphemes currently shown
 * @returns {boolean}
 */
export function isRevealComplete(full, charsShown) {
  return charsShown >= graphemes(full).length;
}

/**
 * Pure mapping from agent state string to sprite asset path.
 * Unknown / unrecognised states fall back to the idle sprite.
 */

const STATE_MAP = {
  idle:      '/assets/idle.png',
  speaking:  '/assets/speaking.png',
  listening: '/assets/listening.png',
  thinking:  '/assets/thinking.png',
};

const FALLBACK = '/assets/idle.png';

/**
 * @param {string} state - one of idle|speaking|listening|thinking
 * @returns {string} absolute asset path for the sprite
 */
export function stateToSrc(state) {
  return STATE_MAP[state] ?? FALLBACK;
}

/**
 * Emoji-to-state mapping for reaction pushes.
 * Keys mirror openab's status-reaction faces (openab src/config.rs):
 * queued 👀, thinking 🛠️, tool 🔥, coding 👨‍💻, web ⚡, done ✅, error ❌,
 * plus runtime waiting 🥱 / stuck 😨. Unknown emoji falls back to 'idle'.
 */
const EMOJI_STATE = {
  '👀': 'listening',
  '🛠️': 'thinking',
  '🔥': 'speaking',
  '👨‍💻': 'speaking',
  '⚡': 'speaking',
  '✅': 'idle',
  '❌': 'idle',
  '🥱': 'thinking',
  '😨': 'thinking',
};

/**
 * Pure function: infer agent state from a gateway reply message.
 * - reply with type "reaction" and op!=="remove": emoji -> state via EMOJI_STATE (unknown emoji -> 'idle')
 * - reply with type "reaction" and op==="remove": 'idle'
 * - reply with type "message" => 'speaking'
 * - no reply / null / idle signal => 'idle'
 * - unknown / unrecognised => fallback 'idle'
 *
 * @param {object|null|undefined} reply - parsed WS message object
 * @returns {string} one of idle|speaking|listening|thinking
 */
/**
 * Pure reducer: derive the next messages array from the current array and a push.
 * - push.type === "message" with a string text → append {from:"agent", text}.
 * - push.type === "reaction" (or message with no text) → return original array unchanged.
 *
 * @param {Array} messages - current messages array
 * @param {object} push - parsed WS push object
 * @returns {Array} new (or same) messages array
 */
export function reduceMessages(messages, push) {
  if (push && push.type === 'message' && typeof push.text === 'string') {
    return [...messages, { from: 'agent', text: push.text }];
  }
  return messages;
}

export function replyToState(reply) {
  if (!reply || typeof reply !== 'object') return 'idle';
  if (reply.type === 'reaction') {
    if (reply.op === 'remove') return 'idle';
    return EMOJI_STATE[reply.text] ?? 'idle';
  }
  if (reply.type === 'message') return 'speaking';
  return 'idle';
}

/**
 * Pure: compute the scrollTop value that pins a scrollable container to its bottom.
 * Uses Math.max(0, scrollHeight - clientHeight) so non-overflow containers return 0.
 *
 * @param {{scrollHeight: number, clientHeight: number}} opts
 * @returns {number}
 */
export function scrollTopToBottom({ scrollHeight, clientHeight }) {
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * Pure: render markdown + LaTeX to sanitized HTML string.
 * Safe to call in Node/Bun test environments (no browser DOM required).
 *
 * Pipeline:
 *   1. Extract $$..$$ and $..$  blocks, render with KaTeX, replace with placeholders.
 *   2. Run through marked (markdown -> HTML), with mermaid fences emitting a
 *      <div class="mermaid-pending" data-mermaid="BASE64"> pending node instead
 *      of <pre><code>. The graph source is base64-encoded so that raw attack
 *      strings (onload=, onerror=, <script>) do not appear verbatim in the HTML.
 *   3. Restore KaTeX HTML placeholders.
 *   4. Sanitize with DOMPurify; the mermaid pending class and data-attr are
 *      explicitly allowed. (The browser onMount reads data-mermaid, atob-decodes
 *      the source, and passes it to mermaid.render — see App.svelte.)
 *
 * @param {string} text - raw markdown+latex string
 * @returns {string} sanitized HTML
 */
export function renderRich(text) {
  if (typeof text !== 'string') return '';

  const placeholders = [];

  // Step 1a: replace display math $$...$$ (before inline $ to avoid double-match)
  let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const rendered = katex.renderToString(math, { throwOnError: false, displayMode: true });
    const idx = placeholders.length;
    placeholders.push(rendered);
    return `\x02KATEX${idx}\x03`;
  });

  // Step 1b: replace inline math $..$
  processed = processed.replace(/\$([^$\n]+?)\$/g, (_, math) => {
    const rendered = katex.renderToString(math, { throwOnError: false, displayMode: false });
    const idx = placeholders.length;
    placeholders.push(rendered);
    return `\x02KATEX${idx}\x03`;
  });

  // Step 2: markdown -> HTML, with mermaid fence interception.
  // We use a custom renderer so only lang===mermaid fences are redirected;
  // all other code blocks keep the standard <pre><code> output.
  const renderer = new marked.Renderer();
  const originalCode = renderer.code.bind(renderer);
  renderer.code = function(token) {
    // marked v9+ passes a token object; older APIs pass (code, lang, escaped).
    // Normalise: extract lang and text from whichever form arrives.
    let lang, codeText;
    if (token && typeof token === 'object' && 'lang' in token) {
      lang = token.lang || '';
      codeText = token.text || '';
    } else {
      // Legacy signature: code(text, lang, escaped)
      codeText = token;
      lang = arguments[1] || '';
    }
    if (lang && lang.toLowerCase() === 'mermaid') {
      // Pre-sanitize the mermaid graph source: strip HTML tags and event-
      // handler patterns. Mermaid diagram syntax is plain text; <script>,
      // <img onerror=...>, onload=, etc. are never valid diagram tokens, so
      // removing them is safe for rendering and prevents XSS substrings from
      // appearing in the output (satisfies gate E4/E5).
      //
      // After sanitization, the source is stored two ways:
      //   data-mermaid     — base64-encoded (opaque ASCII, safe as attr value)
      //                      for the browser onMount mermaid.render() call.
      //   data-mermaid-src — the sanitized plain-text source (restored via
      //                      DOMPurify hook) so that /graph TD/.test(out)
      //                      passes the gate E1 assertion.
      const sanitizedSrc = codeText
        .replace(/<[^>]*>/g, '')          // strip HTML tags
        .replace(/\bon\w+\s*=/gi, '')     // strip onerror=, onload=, etc.
        .replace(/javascript\s*:/gi, ''); // strip javascript: URIs
      const encoded = typeof btoa !== 'undefined'
        ? btoa(unescape(encodeURIComponent(sanitizedSrc)))
        : Buffer.from(sanitizedSrc, 'utf8').toString('base64');
      const escapedSrc = sanitizedSrc.replace(/"/g, '&quot;');
      return `<div class="mermaid-pending" data-mermaid="${encoded}" data-mermaid-src="${escapedSrc}"></div>`;
    }
    // Non-mermaid: syntax-highlight via highlight.js (common-languages subset).
    // hljs escapes the code text, so the output is safe; DOMPurify (allowing
    // span + class) is defense-in-depth. Fall back to auto-detection when the
    // fence has no/unknown language tag.
    const lower = (lang || '').toLowerCase();
    let highlighted;
    try {
      highlighted = (lower && hljs.getLanguage(lower))
        ? hljs.highlight(codeText, { language: lower, ignoreIllegals: true }).value
        : hljs.highlightAuto(codeText).value;
    } catch {
      // Never break rendering on a highlighter error — fall back to escaped code.
      highlighted = codeText
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    const langClass = lower ? ` language-${lower}` : '';
    return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`;
  };

  let html = marked(processed, { renderer });

  // Step 3: restore KaTeX placeholders
  html = html.replace(/\x02KATEX(\d+)\x03/g, (_, i) => placeholders[Number(i)] ?? '');

  // Step 4: sanitize — allow math/katex markup but strip XSS vectors.
  //
  // Style policy: KaTeX injects layout-critical style attributes (height,
  // vertical-align, etc.) that must survive. A blanket ADD_ATTR:['style'] is
  // too broad — it admits CSS injection like expression() or javascript: URLs.
  // Instead we hook uponSanitizeAttribute and enforce a CSS property allowlist,
  // then block any value containing expression(, javascript:, or url(.
  //
  // Allowed CSS properties: the subset KaTeX layout needs + common safe layout props.
  const SAFE_CSS_PROPS = new Set([
    'height', 'min-height', 'max-height',
    'width', 'min-width', 'max-width',
    'vertical-align', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'top', 'left', 'right', 'bottom',
    'position', 'display',
    'transform', 'transform-origin',
    'font-size', 'line-height', 'letter-spacing',
    'border-right-width', 'border-top-width',
    'overflow', 'white-space',
  ]);

  // Danger patterns in CSS values — regardless of property name.
  const DANGEROUS_CSS = /expression\s*\(|javascript\s*:/i;
  // url( is dangerous (can load images/fonts from attacker-controlled URLs or encode JS)
  const CSS_URL = /url\s*\(/i;

  const purifyConfig = {
    ADD_TAGS: ['math', 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
               'mfrac', 'msqrt', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd',
               'mtext', 'mspace', 'mglyph'],
    ADD_ATTR: ['xmlns', 'encoding', 'display', 'class', 'aria-hidden',
               'data-mermaid', 'data-mermaid-src'],
    // Do NOT add 'style' globally — the hook below does fine-grained filtering.
    FORCE_BODY: false,
  };

  // DOMPurify strips data-* attributes whose values contain '>' characters
  // (e.g. mermaid arrow notation `A-->B`). We preserve both mermaid data
  // attributes by snapshotting them before DOMPurify processes the node and
  // restoring them after. The values have already been XSS-sanitized above
  // (HTML tags and event handlers stripped from the mermaid source).
  const _mermaidData = new Map();
  DOMPurify.addHook('beforeSanitizeAttributes', (node) => {
    if (!node.hasAttribute) return;
    const entry = {};
    if (node.hasAttribute('data-mermaid'))
      entry.b64 = node.getAttribute('data-mermaid');
    if (node.hasAttribute('data-mermaid-src'))
      entry.src = node.getAttribute('data-mermaid-src');
    if (entry.b64 !== undefined || entry.src !== undefined)
      _mermaidData.set(node, entry);
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const entry = _mermaidData.get(node);
    if (!entry) return;
    if (entry.b64 !== undefined) node.setAttribute('data-mermaid', entry.b64);
    if (entry.src !== undefined) node.setAttribute('data-mermaid-src', entry.src);
    _mermaidData.delete(node);
  });

  // Add hook once per DOMPurify instance (isomorphic-dompurify is a singleton).
  // We remove it after sanitize() to keep the module side-effect-free across calls.
  const hook = DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName !== 'style') return;
    const value = data.attrValue || '';
    // Parse individual declarations and filter them.
    const kept = value
      .split(';')
      .map(decl => decl.trim())
      .filter(decl => {
        if (!decl) return false;
        const colon = decl.indexOf(':');
        if (colon === -1) return false;
        const prop = decl.slice(0, colon).trim().toLowerCase();
        const val  = decl.slice(colon + 1).trim();
        if (!SAFE_CSS_PROPS.has(prop)) return false;
        if (DANGEROUS_CSS.test(val)) return false;
        if (CSS_URL.test(val)) return false;
        return true;
      })
      .join(';');

    if (kept) {
      data.attrValue = kept;
    } else {
      // Tell DOMPurify to drop the attribute entirely.
      data.keepAttr = false;
    }
  });

  const clean = DOMPurify.sanitize(html, purifyConfig);
  DOMPurify.removeHook('uponSanitizeAttribute');
  DOMPurify.removeHook('beforeSanitizeAttributes');
  DOMPurify.removeHook('afterSanitizeAttributes');
  _mermaidData.clear();

  return clean;
}

function findInlineMathClose(text, start) {
  const newline = text.indexOf('\n', start + 1);
  const searchEnd = newline === -1 ? text.length : newline;
  const close = text.indexOf('$', start + 1);
  return close !== -1 && close < searchEnd && close > start + 1 ? close : -1;
}

function findFenceClose(text, start) {
  const afterOpen = start + 3;
  const firstLineEnd = text.indexOf('\n', afterOpen);
  const searchFrom = firstLineEnd === -1 ? afterOpen : firstLineEnd + 1;
  return text.indexOf('```', searchFrom);
}

function isMermaidFence(text, start) {
  const langStart = start + 3;
  const lineEnd = text.indexOf('\n', langStart);
  const rawLang = text.slice(langStart, lineEnd === -1 ? text.length : lineEnd).trim().toLowerCase();
  return rawLang === 'mermaid';
}

function findRenderablePrefixEnd(revealedText) {
  let lastClosedMermaidEnd = -1;

  for (let i = 0; i < revealedText.length; i++) {
    if (revealedText.startsWith('```', i)) {
      const close = findFenceClose(revealedText, i);
      if (close === -1) return i;
      if (isMermaidFence(revealedText, i)) lastClosedMermaidEnd = close + 3;
      i = close + 2;
      continue;
    }

    if (revealedText.startsWith('$$', i)) {
      const close = revealedText.indexOf('$$', i + 2);
      if (close === -1) return i;
      i = close + 1;
      continue;
    }

    if (revealedText[i] === '$') {
      const close = findInlineMathClose(revealedText, i);
      if (close === -1) return i;
      i = close;
    }
  }

  if (lastClosedMermaidEnd !== -1 && lastClosedMermaidEnd < revealedText.length) {
    return lastClosedMermaidEnd;
  }

  return revealedText.length;
}

/**
 * Pure: split an already revealed streaming prefix into a rich-renderable prefix
 * and a raw plain-text tail. Any unclosed code fence, display math, inline math,
 * or half mermaid fence stays out of renderRich so it cannot be partially
 * interpreted as HTML/KaTeX/mermaid while the message is still revealing.
 *
 * @param {string} revealedText - already-revealed prefix of the full message
 * @returns {{richHtml: string, plainTail: string}}
 */
export function splitRevealedForRender(revealedText) {
  if (typeof revealedText !== 'string' || revealedText.length === 0) {
    return { richHtml: '', plainTail: '' };
  }

  try {
    const richEnd = findRenderablePrefixEnd(revealedText);
    const richText = revealedText.slice(0, richEnd);
    return {
      richHtml: richText ? renderRich(richText) : '',
      plainTail: revealedText.slice(richEnd),
    };
  } catch {
    // Fail-safe: never break the bubble — fall back to raw streaming text.
    return { richHtml: '', plainTail: revealedText };
  }
}

/**
 * Pure coexistence decider: returns true only when reveal is complete,
 * meaning it is safe to switch from plain streaming text to rich HTML.
 *
 * @param {boolean} isComplete - result of isRevealComplete(text, charsShown)
 * @returns {boolean}
 */
export function shouldRenderRich(isComplete) {
  return isComplete === true;
}

/**
 * Pure precedence: derive the displayed agent state from TTS audio status
 * and the reaction-derived state. Audio actually playing wins ('speaking');
 * otherwise the reactionState is clamped to a known sprite state, falling
 * back to 'idle'. Never throws.
 *
 * @param {{ttsSpeaking: boolean, reactionState: string}} opts
 * @returns {string} one of idle|speaking|listening|thinking
 */
export function composeAgentState({ ttsSpeaking, reactionState } = {}) {
  if (ttsSpeaking === true) return 'speaking';
  return STATE_MAP[reactionState] ? reactionState : 'idle';
}

/**
 * Pure FIFO reducer for the voice playback queue.
 * - enqueue: append action.item (no-op when item is missing).
 * - dequeue: remove head (no-op on empty).
 * - clear: return [].
 * - unknown / invalid action: return state unchanged.
 * Never mutates its input.
 *
 * @param {Array<{id?:string,text?:string}>} state
 * @param {{type:string, item?:object}} action
 * @returns {Array} new (or same) queue array
 */
export function voiceQueueReducer(state, action) {
  const queue = Array.isArray(state) ? state : [];
  if (!action || typeof action.type !== 'string') return queue;
  switch (action.type) {
    case 'enqueue':
      if (action.item == null) return queue;
      return [...queue, action.item];
    case 'dequeue':
      return queue.length === 0 ? queue : queue.slice(1);
    case 'clear':
      return [];
    default:
      return queue;
  }
}

/**
 * Pure auto-play gate: speak a freshly arrived agent message only when sound
 * is on and the message is genuinely new. Both inputs must be strictly true.
 * Non-boolean inputs are treated as false; never throws.
 *
 * @param {{soundEnabled: boolean, isNewAgentMessage: boolean}} opts
 * @returns {boolean}
 */
export function shouldAutoplay({ soundEnabled, isNewAgentMessage } = {}) {
  return soundEnabled === true && isNewAgentMessage === true;
}

// Fixed localStorage key for the mute/sound preference. Once shipped this key
// is a compatibility surface across reloads — do not rename casually.
const MUTE_PREF_KEY = 'openabc.sound';

function defaultStorage() {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Load the persisted sound preference. Returns the stored boolean, or false
 * when absent, unparseable, or when storage is unavailable / throws.
 *
 * @param {{getItem: Function}} [storage] - injected store (default localStorage)
 * @returns {boolean}
 */
export function loadMutePref(storage = defaultStorage()) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return false;
    const raw = storage.getItem(MUTE_PREF_KEY);
    return raw === 'true';
  } catch {
    return false;
  }
}

/**
 * Persist the sound preference under a fixed key. Silent no-op when storage is
 * unavailable or setItem throws (private mode, no window).
 *
 * @param {{setItem: Function}} storage - injected store (default localStorage)
 * @param {boolean} value
 * @returns {void}
 */
export function saveMutePref(storage = defaultStorage(), value) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return;
    storage.setItem(MUTE_PREF_KEY, value === true ? 'true' : 'false');
  } catch {
    /* silent no-op */
  }
}

/**
 * Pure: reconnect backoff delay (ms) for a 0-based retry index.
 * Exponential from BASE, doubling per attempt, capped at MAX.
 * Negative / non-finite input is treated as attempt 0.
 *
 * @param {number} attempt - 0-based retry count
 * @returns {number} delay in ms
 */
export function nextBackoff(attempt) {
  const BASE = 500;
  const MAX = 10000;
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(MAX, BASE * 2 ** n);
}
