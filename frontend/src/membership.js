/**
 * membership.js — N:M channel-to-agent membership model for openabc frontend.
 *
 * Public API (frozen handle, load-bearing behaviors):
 *   addAgent(channelId, agentId)           — add agentId to channelId; idempotent
 *   removeAgent(channelId, agentId)        — remove agentId from channelId; no-op if absent
 *   agentsOf(channelId) -> string[]        — ordered list of agent ids in the channel
 *   routingTargetFor(channelId) -> string|null  — null if 0 or >=2 agents, else the agent id
 *   routingAmbiguous(channelId) -> bool    — true iff >=2 agents in channel
 *   OPENAB_LIMITS                          — machine-readable openab protocol limit flags
 */

/** @type {Map<string, string[]>} module-level store; channelId -> insertion-ordered agent ids */
const _membership = new Map();

/**
 * Add agentId to channelId membership. Idempotent: duplicate adds are no-ops.
 * @param {string} channelId
 * @param {string} agentId
 */
export function addAgent(channelId, agentId) {
  const agents = _membership.get(channelId);
  if (agents === undefined) {
    _membership.set(channelId, [agentId]);
  } else if (!agents.includes(agentId)) {
    agents.push(agentId);
  }
}

/**
 * Remove agentId from channelId membership. No-op if agent is not a member.
 * @param {string} channelId
 * @param {string} agentId
 */
export function removeAgent(channelId, agentId) {
  const agents = _membership.get(channelId);
  if (agents === undefined) return;
  const idx = agents.indexOf(agentId);
  if (idx !== -1) {
    agents.splice(idx, 1);
  }
}

/**
 * Return the ordered list of agent ids for the given channel.
 * Insertion order is preserved. Returns empty array for unknown channels.
 * @param {string} channelId
 * @returns {string[]}
 */
export function agentsOf(channelId) {
  return _membership.get(channelId) ?? [];
}

/**
 * Derive a single routing target for the channel:
 *   - exactly 1 agent -> that agent's id (string)
 *   - 0 agents        -> null  (broadcast; aligns with stub_core None => all bots)
 *   - >=2 agents      -> null  (ambiguous; caller should inspect routingAmbiguous)
 * Shape is channelArgs-compatible: string feeds channelArgs(name, target) as [name, id];
 * null feeds channelArgs(name, null) as [name].
 * @param {string} channelId
 * @returns {string|null}
 */
export function routingTargetFor(channelId) {
  const agents = agentsOf(channelId);
  if (agents.length === 1) return agents[0];
  return null;
}

/**
 * Return true iff the channel has 2 or more agents (ambiguous routing).
 * @param {string} channelId
 * @returns {boolean}
 */
export function routingAmbiguous(channelId) {
  return agentsOf(channelId).length >= 2;
}

/**
 * Machine-readable record of openab protocol limits that constrain this membership model.
 *
 * replyHasSource:          false — GatewayReply carries no source/sender field; we cannot
 *                                  attribute inbound messages to specific agents.
 * eventHasMembership:      false — GatewayEvent has no membership list; membership is a
 *                                  frontend-only concept not propagated to the core.
 * targetAgentIsSingleValue: true — target_agent in GatewayEvent is a single optional string;
 *                                  multi-agent fan-out requires multiple events, not one field.
 */
export const OPENAB_LIMITS = {
  replyHasSource: false,
  eventHasMembership: false,
  targetAgentIsSingleValue: true,
};
