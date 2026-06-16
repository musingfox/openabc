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
 * Pure function: infer agent state from a gateway reply message.
 * - reply with type "message" => 'speaking'
 * - no reply / null / idle signal => 'idle'
 * - unknown / unrecognised => fallback 'idle'
 *
 * @param {object|null|undefined} reply - parsed WS message object
 * @returns {string} one of idle|speaking|listening|thinking
 */
export function replyToState(reply) {
  if (!reply || typeof reply !== 'object') return 'idle';
  if (reply.type === 'message') return 'speaking';
  return 'idle';
}
