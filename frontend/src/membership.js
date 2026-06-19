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

// ─── E1: openab identity model facts ─────────────────────────────────────────

/**
 * Frozen record of how openab identifies its bots/agents.
 * identityKey: the config field that names the bot.
 * identitySource: where the identity is configured.
 * runtimeAddressingField: no runtime field carries bot identity in GatewayEvent/Reply.
 * isolationModel: one bot process per pod.
 * handoffMechanism: bots are addressed via @mention in group chats.
 */
export const OPENAB_IDENTITY = {
  identityKey: 'bot_username',
  identitySource: 'config',
  runtimeAddressingField: null,
  isolationModel: 'per-pod',
  handoffMechanism: 'mention',
};

// ─── E2: mention gating facts + pure function ─────────────────────────────────

/**
 * Frozen record of openab's mention-gating rules (gateway.rs:656-665).
 */
export const OPENAB_MENTION_GATING = {
  requiresGroup: true,
  groupTypes: ['group', 'supergroup'],
  skippedWhenInThread: true,
  requiresBotUsername: true,
  matchOn: 'mentions',
  matchSemantics: 'exact-equality',
};

/**
 * Pure function: does this message pass mention gating and get processed by the bot?
 * true = processed/passed, false = skipped.
 * Mirrors openab gateway.rs:656-665 truth table.
 *
 * @param {{ channelType: string, inThread: boolean, botUsername: string|null|undefined, mentions: string[]|undefined }} param
 * @returns {boolean}
 */
export function mentionGatePasses({ channelType, inThread, botUsername, mentions }) {
  const isGroup = channelType === 'group' || channelType === 'supergroup';
  // Non-group channels: no gating, always pass
  if (!isGroup) return true;
  // Group but in thread: no gating, always pass
  if (inThread) return true;
  // Group, not in thread, but no botUsername configured: no gating, always pass
  if (!botUsername) return true;
  // Group, not in thread, botUsername present: gating by mention
  const safeM = mentions ?? [];
  return safeM.includes(botUsername);
}

// ─── E3: agent descriptor ─────────────────────────────────────────────────────

/**
 * Build a typed agent descriptor. Throws if localId is falsy.
 * Defaults: openabBotUsername -> null, label -> localId.
 *
 * @param {{ localId: string, label?: string, openabBotUsername?: string|null }} param
 * @returns {{ localId: string, label: string, openabBotUsername: string|null }}
 */
export function agentDescriptor({ localId, label, openabBotUsername } = {}) {
  if (!localId) throw new Error('agentDescriptor: localId is required');
  return {
    localId,
    label: label !== undefined ? label : localId,
    openabBotUsername: openabBotUsername !== undefined ? openabBotUsername : null,
  };
}

// ─── E4: openab alignment blockers ───────────────────────────────────────────

/**
 * One-way-door blockers that prevent full openab alignment today.
 * Each entry: { id: string, need: string, door: 'one-way' }.
 */
export const OPENAB_ALIGNMENT_BLOCKERS = [
  {
    id: 'no-target_agent-in-openab',
    need: 'GatewayEvent target_agent has no openab counterpart field; openab core cannot route by it without a protocol extension',
    door: 'one-way',
  },
  {
    id: 'no-source-in-reply',
    need: 'GatewayReply carries no source field identifying which agent produced the reply; UI cannot attribute messages to specific bots',
    door: 'one-way',
  },
  {
    id: 'native-channel-type-bypasses-gating',
    need: 'native channel_type is hardcoded in openabc and never triggers mention gating; openab mention-gate logic is unreachable from this gateway',
    door: 'one-way',
  },
  {
    id: 'is_bot-drop',
    need: 'openab gateway.rs:638 unconditionally drops events whose sender.is_bot is true; bot-to-bot handoff requires allow_bot_messages / trusted_bot_ids group-level config semantics that do not exist in the current protocol',
    door: 'one-way',
  },
  {
    id: 'allowed_channels-isolation',
    need: 'gateway.rs:643-646 filters by channel allowlist before the mention gate; per-channel agent binding requires each channel to be in the allowlist, meaning true isolation is enforced before mention gating can be reached',
    door: 'one-way',
  },
  {
    id: 'message_id-requirement',
    need: 'gateway.rs:698 requires a non-empty message_id for streaming replies and edit operations; openabc native channels do not generate or track message_id, blocking streaming and edit flows',
    door: 'one-way',
  },
];
