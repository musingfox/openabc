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
