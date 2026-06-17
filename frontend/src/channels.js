/**
 * channels.js — multi-channel store for openabc frontend.
 *
 * Each channel = one independent /native/ws WebSocket connection (one conn_id).
 * Zero backend changes; the isolation is entirely a frontend concept.
 *
 * Public API (frozen handle, load-bearing behaviors):
 *   createChannelStore(wsFactory) -> store
 *   store.addChannel(name)        -> channelId
 *   store.channel(id)             -> { id, name, socket, messages:[{id,from,text}] }
 *   store.setActive(id)
 *   store.activeMessages()        -> messages of active channel only
 *   store.send(id, text)          -> calls channel's socket.send once; appends {id,from:'me',text}
 *   store.receive(id, payload)    -> appends {id,from:'agent',text} to that channel only
 *   store.ingest(id, rawData)     -> parse raw WS frame string; route to channel (shared ingest)
 *   store.reconnect(id)           -> close old socket, open new one via wsFactory
 *
 *   ingestSocketMessage(store, id, rawData) — module-level shared ingest; same contract
 *   as store.ingest but callable without the store as `this`.
 */

/**
 * Generate a simple unique id.
 * @returns {string}
 */
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Parse a raw WebSocket event.data frame and, if it is a type==='message' frame,
 * append a message with a stable id to the target channel.
 *
 * D1 seam: `from` is hardcoded 'agent' for all inbound frames.
 * No multi-agent branching on any source/sender field in the payload.
 *
 * @param {Map} _channels   — the internal channels Map (passed by reference from store)
 * @param {string} id       — target channelId
 * @param {string} rawData  — the raw string from socket event.data
 */
function _ingestRaw(_channels, id, rawData) {
  const ch = _channels.get(id);
  if (!ch) return;
  let payload;
  try {
    payload = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  } catch {
    return; // malformed JSON → silent no-op
  }
  if (payload && payload.type === 'message' && typeof payload.text === 'string') {
    ch.messages = [
      ...ch.messages,
      { id: uid(), from: 'agent', text: payload.text },
    ];
  }
  // reaction / other types → silent no-op
}

/**
 * Create a channel store.
 *
 * @param {(url: string) => WebSocket} wsFactory — injectable WS factory;
 *   defaults to (url) => new WebSocket(url).
 * @returns store object
 */
export function createChannelStore(wsFactory = (url) => new WebSocket(url)) {
  /** @type {Map<string, {id:string, name:string, socket:WebSocket, messages:{id:string,from:string,text:string}[]}>} */
  const _channels = new Map();
  let _activeId = null;

  /**
   * Add a new channel, opening exactly one /native/ws connection for it.
   * The socket.onmessage is wired to the shared ingest fn — this is the SINGLE
   * onmessage registration point. App.svelte MUST NOT set its own onmessage.
   * @param {string} name
   * @returns {string} channelId
   */
  function addChannel(name) {
    const id = uid();
    const socket = wsFactory('/native/ws');

    const channel = {
      id,
      name,
      socket,
      messages: [],
    };

    _channels.set(id, channel);

    // Wire inbound messages from this socket to this channel ONLY via shared ingest.
    socket.onmessage = (event) => _ingestRaw(_channels, id, event.data);

    // Default active channel = first one added.
    if (_activeId === null) {
      _activeId = id;
    }

    return id;
  }

  /**
   * Get channel by id.
   * @param {string} id
   */
  function channel(id) {
    return _channels.get(id) ?? null;
  }

  /**
   * List all channels.
   * @returns {Array}
   */
  function channels() {
    return Array.from(_channels.values());
  }

  /**
   * Set the active channel.
   * @param {string} id
   */
  function setActive(id) {
    if (_channels.has(id)) {
      _activeId = id;
    }
  }

  /**
   * Return messages of the active channel only.
   * @returns {{id:string,from:string,text:string}[]}
   */
  function activeMessages() {
    if (_activeId === null) return [];
    const ch = _channels.get(_activeId);
    return ch ? ch.messages : [];
  }

  /**
   * Send text via the specified channel's socket.
   * Appends {id,from:'me',text} to that channel's messages.
   * Only that channel's socket.send is called.
   *
   * @param {string} id — channel id
   * @param {string} text
   */
  function send(id, text) {
    const ch = _channels.get(id);
    if (!ch) return;
    ch.socket.send(JSON.stringify({ text }));
    ch.messages = [...ch.messages, { id: uid(), from: 'me', text }];
  }

  /**
   * Ingest a raw WebSocket frame string onto a specific channel.
   * This is the shared ingest entry point — the same logic addChannel.socket.onmessage
   * uses, exposed for external callers (App.svelte, tests).
   *
   * @param {string} id      — channel id
   * @param {string} rawData — raw event.data string from the WebSocket
   */
  function ingest(id, rawData) {
    _ingestRaw(_channels, id, rawData);
  }

  /**
   * Ingest an inbound payload onto a specific channel (by id).
   * Accepts a raw string (socket onmessage event.data) OR a pre-parsed payload object.
   * When given a raw string, it is parsed first (same as ingest).
   * Used for testing and explicit routing.
   *
   * @param {string} id — channel id
   * @param {string|{type:string, text:string}} payloadOrRaw
   */
  function receive(id, payloadOrRaw) {
    if (typeof payloadOrRaw === 'string') {
      _ingestRaw(_channels, id, payloadOrRaw);
      return;
    }
    const ch = _channels.get(id);
    if (!ch) return;
    const payload = payloadOrRaw;
    if (payload && payload.type === 'message' && typeof payload.text === 'string') {
      ch.messages = [
        ...ch.messages,
        { id: uid(), from: 'agent', text: payload.text },
      ];
    }
  }

  /**
   * Reconnect a channel: close the old socket, open a new one via wsFactory,
   * and wire the new socket's onmessage to the shared ingest fn.
   * The caller (App.svelte) is responsible for re-wiring onopen/onclose/onerror
   * on ch.socket after this returns.
   *
   * @param {string} id — channel id
   */
  function reconnect(id) {
    const ch = _channels.get(id);
    if (!ch) return;
    // B1: close the OLD socket before replacing it.
    ch.socket.close();
    // Open a fresh socket via the injected factory.
    const newSocket = wsFactory('/native/ws');
    ch.socket = newSocket;
    // Wire inbound messages on the new socket through the shared ingest fn.
    newSocket.onmessage = (event) => _ingestRaw(_channels, id, event.data);
  }

  return {
    addChannel,
    channel,
    channels,
    setActive,
    activeMessages,
    send,
    receive,
    ingest,
    reconnect,
    /** @returns {string|null} */
    get activeId() { return _activeId; },
  };
}

/**
 * Module-level shared ingest function (canonical frozen handle).
 * Wraps store.ingest so external callers can use the named-export form.
 * Probe discovery order: channels.ingestSocketMessage → store.ingest → store.receive.
 *
 * @param {ReturnType<typeof createChannelStore>} store
 * @param {string} channelId
 * @param {string} rawData — raw event.data string
 */
export function ingestSocketMessage(store, channelId, rawData) {
  store.ingest(channelId, rawData);
}
