import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'isomorphic-dompurify';

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
 */
const EMOJI_STATE = {
  '👀': 'listening',
  '🤔': 'thinking',
  '🔥': 'speaking',
  '👨‍💻': 'speaking',
  '⚡': 'speaking',
  '🆗': 'speaking',
  '😱': 'thinking',
  '🥱': 'thinking',
  '😨': 'thinking',
  '💪': 'speaking',
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
 *   2. Run through marked (markdown -> HTML).
 *   3. Restore KaTeX HTML placeholders.
 *   4. Sanitize with DOMPurify (strips onerror, javascript: hrefs, <script>, etc.).
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

  // Step 2: markdown -> HTML
  let html = marked(processed);

  // Step 3: restore KaTeX placeholders
  html = html.replace(/\x02KATEX(\d+)\x03/g, (_, i) => placeholders[Number(i)] ?? '');

  // Step 4: sanitize — allow math/katex markup but strip XSS vectors
  const clean = DOMPurify.sanitize(html, {
    ADD_TAGS: ['math', 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
               'mfrac', 'msqrt', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd',
               'mtext', 'mspace', 'mglyph'],
    ADD_ATTR: ['xmlns', 'encoding', 'display', 'class', 'style', 'aria-hidden'],
  });

  return clean;
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
