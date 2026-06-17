/**
 * channels.js — multi-channel store for openabc frontend.
 *
 * Each channel = one independent /native/ws WebSocket connection (one conn_id).
 * Zero backend changes; the isolation is entirely a frontend concept.
 *
 * Public API (frozen handle, load-bearing behaviors):
 *   createChannelStore(wsFactory) -> store
 *   store.addChannel(name)        -> channelId
 *   store.channel(id)             -> { id, name, socket, messages:[{from,text}] }
 *   store.setActive(id)
 *   store.activeMessages()        -> messages of active channel only
 *   store.send(id, text)          -> calls channel's socket.send once; appends {from:'me',text}
 *   store.receive(id, payload)    -> appends {from:'agent',text} to that channel only
 */

/**
 * Generate a simple unique id.
 * @returns {string}
 */
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Create a channel store.
 *
 * @param {(url: string) => WebSocket} wsFactory — injectable WS factory;
 *   defaults to (url) => new WebSocket(url).
 * @returns store object
 */
export function createChannelStore(wsFactory = (url) => new WebSocket(url)) {
  /** @type {Map<string, {id:string, name:string, socket:WebSocket, messages:{from:string,text:string}[]}>} */
  const _channels = new Map();
  let _activeId = null;

  /**
   * Add a new channel, opening exactly one /native/ws connection for it.
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

    // Wire inbound messages from this socket to this channel only.
    socket.onmessage = (event) => {
      let payload;
      try {
        payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (payload && payload.type === 'message' && typeof payload.text === 'string') {
        channel.messages = [
          ...channel.messages,
          { from: payload.from || 'agent', text: payload.text },
        ];
      }
    };

    _channels.set(id, channel);

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
   * @returns {{from:string,text:string}[]}
   */
  function activeMessages() {
    if (_activeId === null) return [];
    const ch = _channels.get(_activeId);
    return ch ? ch.messages : [];
  }

  /**
   * Send text via the specified channel's socket.
   * Appends {from:'me', text} to that channel's messages.
   * Only that channel's socket.send is called.
   *
   * @param {string} id — channel id
   * @param {string} text
   */
  function send(id, text) {
    const ch = _channels.get(id);
    if (!ch) return;
    ch.socket.send(JSON.stringify({ text }));
    ch.messages = [...ch.messages, { from: 'me', text }];
  }

  /**
   * Ingest an inbound payload onto a specific channel (by id).
   * Used for testing and explicit routing; normally the socket.onmessage
   * handler does this automatically.
   *
   * @param {string} id — channel id
   * @param {{type:string, text:string, from?:string}} payload
   */
  function receive(id, payload) {
    const ch = _channels.get(id);
    if (!ch) return;
    if (payload && payload.type === 'message' && typeof payload.text === 'string') {
      ch.messages = [
        ...ch.messages,
        { from: payload.from || 'agent', text: payload.text },
      ];
    }
  }

  return {
    addChannel,
    channel,
    channels,
    setActive,
    activeMessages,
    send,
    receive,
    /** @returns {string|null} */
    get activeId() { return _activeId; },
  };
}
