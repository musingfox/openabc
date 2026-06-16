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
