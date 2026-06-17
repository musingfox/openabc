<script>
  import { onMount } from 'svelte';
  import mermaid from 'mermaid';
  import { stateToSrc, replyToState, nextBackoff, revealText, isRevealComplete, scrollTopToBottom, renderRich, shouldRenderRich, splitRevealedForRender } from './avatar.js';
  import { createChannelStore, ingestSocketMessage } from './channels.js';

  // ── Channel store ──────────────────────────────────────────────────────────
  // Each channel holds its own independent /native/ws connection.
  const store = createChannelStore();

  // Reactive channel list and active selection.
  let channelList = $state([]);
  let activeChannelId = $state(null);

  // New channel name input.
  let newChannelName = $state('');

  // Per-channel state: agentState, connStatus, revealState, reconnect trackers.
  // Keyed by channelId.
  let channelMeta = $state({});

  const CONN_LABEL = { connecting: '連線中…', open: '已連線', reconnecting: '重連中…' };
  const REVEAL_INTERVAL_MS = 30;

  // Active reveal timers: map from `${channelId}-${msgId}` to timer id.
  let revealTimers = {};

  // Initialise mermaid once at startup.
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

  function scrollMessagesToEnd() {
    const el = document.getElementById('messages');
    if (el) el.scrollTop = scrollTopToBottom({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
  }

  function startReveal(channelId, msgId, text) {
    const key = `${channelId}-${msgId}`;
    if (revealTimers[key]) return;
    channelMeta = {
      ...channelMeta,
      [channelId]: {
        ...channelMeta[channelId],
        revealState: { ...(channelMeta[channelId]?.revealState ?? {}), [msgId]: 0 },
      },
    };
    revealTimers[key] = setInterval(() => {
      const current = channelMeta[channelId]?.revealState?.[msgId] ?? 0;
      const next = current + 1;
      channelMeta = {
        ...channelMeta,
        [channelId]: {
          ...channelMeta[channelId],
          revealState: { ...(channelMeta[channelId]?.revealState ?? {}), [msgId]: next },
        },
      };
      scrollMessagesToEnd();
      if (isRevealComplete(text, next)) {
        clearInterval(revealTimers[key]);
        delete revealTimers[key];
      }
    }, REVEAL_INTERVAL_MS);
  }

  function openChannel(name) {
    const id = store.addChannel(name);
    const ch = store.channel(id);

    // Per-channel meta defaults.
    channelMeta = {
      ...channelMeta,
      [id]: {
        agentState: 'idle',
        connStatus: 'connecting',
        revealState: {},
        reconnectAttempt: 0,
        reconnectTimer: null,
      },
    };

    // Wire real WS events to channel state.
    const ws = ch.socket;

    ws.onopen = () => {
      channelMeta = {
        ...channelMeta,
        [id]: { ...channelMeta[id], connStatus: 'open', reconnectAttempt: 0 },
      };
    };

    ws.onmessage = (event) => {
      let obj = null;
      try { obj = JSON.parse(event.data); } catch { return; }

      // Drive avatar state machine (side-effect only; does not affect messages).
      const agentState = replyToState(obj);
      const prevMessages = store.channel(id).messages;

      // Route the raw frame through the shared ingest fn (production path, tested by probe).
      ingestSocketMessage(store, id, event.data);

      const next = store.channel(id).messages;
      channelList = store.channels(); // trigger reactivity

      // Start streaming reveal for newly appended agent messages.
      if (next.length > prevMessages.length) {
        const newMsg = next[next.length - 1];
        if (newMsg.from === 'agent') {
          startReveal(id, newMsg.id, newMsg.text);
        }
      }

      channelMeta = {
        ...channelMeta,
        [id]: { ...channelMeta[id], agentState },
      };
    };

    ws.onerror = () => { /* onclose follows */ };

    ws.onclose = () => {
      const meta = channelMeta[id] ?? {};
      const attempt = meta.reconnectAttempt ?? 0;
      const delay = nextBackoff(attempt);
      clearTimeout(meta.reconnectTimer);
      channelMeta = {
        ...channelMeta,
        [id]: {
          ...meta,
          connStatus: 'reconnecting',
          reconnectAttempt: attempt + 1,
          reconnectTimer: setTimeout(() => reconnectChannel(id, name), delay),
        },
      };
    };

    channelList = store.channels();
    activeChannelId = id;
    store.setActive(id);
  }

  function reconnectChannel(id, name) {
    const ch = store.channel(id);
    if (!ch) return;

    // B1: store.reconnect closes old socket and opens a new one via wsFactory,
    // wiring onmessage on the new socket to the shared ingest fn.
    store.reconnect(id);
    const newWs = ch.socket; // ch.socket is now the new socket

    channelMeta = {
      ...channelMeta,
      [id]: { ...channelMeta[id], connStatus: 'reconnecting' },
    };

    newWs.onopen = () => {
      channelMeta = {
        ...channelMeta,
        [id]: { ...channelMeta[id], connStatus: 'open', reconnectAttempt: 0 },
      };
    };

    // onmessage is already wired by store.reconnect; add the avatar side-effect overlay.
    newWs.onmessage = (event) => {
      let obj = null;
      try { obj = JSON.parse(event.data); } catch { /* ingest handles malformed */ }
      const agentState = obj ? replyToState(obj) : (channelMeta[id]?.agentState ?? 'idle');
      const prevMessages = store.channel(id).messages;

      // Route through shared ingest (already wired, call again is idempotent for
      // the onmessage that store.reconnect set; we override here to add avatar effect).
      ingestSocketMessage(store, id, event.data);

      const next = store.channel(id).messages;
      channelList = store.channels();
      if (next.length > prevMessages.length) {
        const newMsg = next[next.length - 1];
        if (newMsg.from === 'agent') startReveal(id, newMsg.id, newMsg.text);
      }
      channelMeta = { ...channelMeta, [id]: { ...channelMeta[id], agentState } };
    };

    newWs.onerror = () => {};
    newWs.onclose = () => {
      const meta = channelMeta[id] ?? {};
      const attempt = meta.reconnectAttempt ?? 0;
      const delay = nextBackoff(attempt);
      clearTimeout(meta.reconnectTimer);
      channelMeta = {
        ...channelMeta,
        [id]: {
          ...meta,
          connStatus: 'reconnecting',
          reconnectAttempt: attempt + 1,
          reconnectTimer: setTimeout(() => reconnectChannel(id, name), delay),
        },
      };
    };
  }

  // Add the default channel on mount.
  onMount(() => {
    openChannel('預設頻道');
    renderMermaidPending();
  });

  function addChannel() {
    const name = newChannelName.trim();
    if (!name) return;
    openChannel(name);
    newChannelName = '';
  }

  function switchChannel(id) {
    activeChannelId = id;
    store.setActive(id);
  }

  // Current active channel derived values.
  let activeChannel = $derived(activeChannelId ? store.channel(activeChannelId) : null);
  // Use store.activeMessages() so the display layer uses the same data path the tests probe.
  let activeMessages = $derived(store.activeMessages());
  let activeMeta = $derived(activeChannelId ? (channelMeta[activeChannelId] ?? {}) : {});
  let agentState = $derived(activeMeta.agentState ?? 'idle');
  let connStatus = $derived(activeMeta.connStatus ?? 'connecting');
  let revealState = $derived(activeMeta.revealState ?? {});

  // Current input draft.
  let draft = $state('');

  /**
   * Find all .mermaid-pending nodes and render them to SVG.
   */
  async function renderMermaidPending() {
    const nodes = document.querySelectorAll('.mermaid-pending[data-mermaid]');
    for (const node of nodes) {
      const encoded = node.getAttribute('data-mermaid');
      if (!encoded) continue;
      let source;
      try {
        source = decodeURIComponent(escape(atob(encoded)));
      } catch {
        continue;
      }
      node.removeAttribute('data-mermaid');
      node.classList.remove('mermaid-pending');
      try {
        const id = 'mermaid-' + Math.random().toString(36).slice(2);
        const { svg } = await mermaid.render(id, source);
        node.innerHTML = svg;
      } catch {
        node.textContent = source;
      }
    }
  }

  // Re-run after every reactive update.
  $effect(() => {
    const _ = activeMessages;
    const __ = revealState;
    Promise.resolve().then(renderMermaidPending);
  });

  // Send the draft via the active channel.
  function send() {
    const text = draft.trim();
    if (!text || !activeChannelId) return;
    const ch = store.channel(activeChannelId);
    if (!ch || !ch.socket || ch.socket.readyState !== WebSocket.OPEN) {
      store.appendLocal(activeChannelId, { from: 'system', text: '⚠ 尚未連線,訊息未送出,正在重連…' });
      channelList = store.channels();
      return;
    }
    store.send(activeChannelId, text);
    channelList = store.channels();
    draft = '';
  }

  function onKey(e) {
    if (e.key === 'Enter') send();
  }

  function addChannelOnKey(e) {
    if (e.key === 'Enter') addChannel();
  }

  const states = ['idle', 'speaking', 'listening', 'thinking'];

  function nextState() {
    const idx = states.indexOf(agentState);
    if (activeChannelId) {
      channelMeta = {
        ...channelMeta,
        [activeChannelId]: { ...channelMeta[activeChannelId], agentState: states[(idx + 1) % states.length] },
      };
    }
  }
</script>

<main>
  <h1>openabc agent avatar</h1>

  <div class="layout">
    <!-- ── Channel sidebar ── -->
    <aside class="channels-panel">
      <div class="channels-header">頻道</div>
      <ul class="channel-list">
        {#each channelList as ch (ch.id)}
          <li
            class="channel-item{ch.id === activeChannelId ? ' active' : ''}"
            onclick={() => switchChannel(ch.id)}
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && switchChannel(ch.id)}
          >
            <span class="ch-dot {channelMeta[ch.id]?.connStatus ?? 'connecting'}">●</span>
            <span class="ch-name">{ch.name}</span>
          </li>
        {/each}
      </ul>
      <div class="new-channel">
        <input
          type="text"
          placeholder="新頻道名稱…"
          bind:value={newChannelName}
          onkeydown={addChannelOnKey}
        />
        <button onclick={addChannel}>+</button>
      </div>
    </aside>

    <!-- ── Main chat area ── -->
    <section class="chat-area">
      <div class="avatar">
        <img src={stateToSrc(agentState)} alt={agentState} width="64" height="64" />
        <p>State: <strong>{agentState}</strong></p>
        <p class="conn {connStatus}">● {CONN_LABEL[connStatus] ?? connStatus}</p>
      </div>

      <ul id="messages" style="max-height:40vh;overflow-y:auto">
        {#each activeMessages as m (m.id)}
          <li class={m.from}>
            <span class="label">{m.from}</span>
            <div class="bubble{m.from === 'agent' && !isRevealComplete(m.text, revealState[m.id] ?? 0) ? ' revealing' : ''}">
              {#if m.from === 'agent'}
                {#if shouldRenderRich(isRevealComplete(m.text, revealState[m.id] ?? 0))}
                  {@html renderRich(m.text)}
                {:else}
                  {@const revealed = splitRevealedForRender(revealText(m.text, revealState[m.id] ?? 0))}
                  {@html revealed.richHtml}{revealed.plainTail}
                {/if}
              {:else}
                {m.text}
              {/if}
            </div>
          </li>
        {/each}
      </ul>

      <div class="composer">
        <input
          id="input"
          type="text"
          placeholder="輸入訊息…"
          bind:value={draft}
          onkeydown={onKey}
        />
        <button onclick={send}>送出</button>
      </div>

      <button class="fallback" onclick={nextState}>next state (fallback)</button>
    </section>
  </div>
</main>

<style>
  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 0 24px 48px;
    box-sizing: border-box;
    text-align: left;
  }

  h1 { text-align: center; }

  .layout {
    display: flex;
    gap: 16px;
    align-items: flex-start;
  }

  /* ── Channel sidebar ── */
  .channels-panel {
    width: 180px;
    flex-shrink: 0;
    border: 1px solid var(--border, #2e303a);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .channels-header {
    padding: 10px 12px 8px;
    font-size: 0.78em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
    border-bottom: 1px solid var(--border, #2e303a);
  }

  .channel-list {
    list-style: none;
    padding: 4px 0;
    margin: 0;
    flex: 1;
  }

  .channel-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    cursor: pointer;
    border-radius: 6px;
    margin: 2px 4px;
    font-size: 0.92em;
  }

  .channel-item:hover {
    background: var(--accent-bg, rgba(170, 59, 255, 0.08));
  }

  .channel-item.active {
    background: var(--accent-bg, rgba(170, 59, 255, 0.15));
    font-weight: 600;
  }

  .ch-dot {
    font-size: 0.7em;
    opacity: 0.5;
  }
  .ch-dot.open { color: #4caf50; opacity: 1; }
  .ch-dot.connecting { color: #ff9800; opacity: 1; }
  .ch-dot.reconnecting { color: #f44336; opacity: 1; }

  .ch-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .new-channel {
    display: flex;
    border-top: 1px solid var(--border, #2e303a);
    padding: 6px;
    gap: 4px;
  }

  .new-channel input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--border, #2e303a);
    background: var(--bg, #16171d);
    color: inherit;
    font: inherit;
    font-size: 0.88em;
  }

  .new-channel button {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--accent-border, rgba(170, 59, 255, 0.5));
    background: var(--accent-bg, rgba(170, 59, 255, 0.12));
    color: inherit;
    cursor: pointer;
    font-size: 1em;
    line-height: 1;
  }

  /* ── Chat area ── */
  .chat-area {
    flex: 1;
    min-width: 0;
  }

  .avatar {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .avatar img {
    border-radius: 12px;
    image-rendering: pixelated;
  }

  #messages {
    list-style: none;
    padding: 4px;
    margin: 20px 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 40vh;
    overflow-y: auto;
    text-align: left;
  }

  #messages li {
    display: flex;
    flex-direction: column;
    max-width: 92%;
  }

  #messages li.agent {
    align-self: flex-start;
    align-items: stretch;
    width: 100%;
  }

  #messages li.you {
    align-self: flex-end;
    align-items: flex-end;
  }

  #messages li.me {
    align-self: flex-end;
    align-items: flex-end;
  }

  #messages li.system {
    align-self: center;
    align-items: center;
    max-width: 100%;
  }

  .label {
    font-size: 0.72em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.5;
    margin-bottom: 4px;
  }

  .bubble {
    padding: 12px 16px;
    border-radius: 14px;
    background: var(--accent-bg, rgba(170, 59, 255, 0.1));
    border: 1px solid var(--accent-border, rgba(170, 59, 255, 0.3));
    line-height: 1.55;
    overflow-x: auto;
    overflow-wrap: anywhere;
  }

  #messages li.you .bubble,
  #messages li.me .bubble {
    background: var(--code-bg, #f4f3ec);
    border-color: var(--border, #e5e4e7);
  }

  #messages li.system .bubble {
    background: transparent;
    border: none;
    font-size: 0.85em;
    opacity: 0.7;
  }

  .bubble.revealing::after {
    content: '▋';
    display: inline-block;
    animation: blink 0.7s step-end infinite;
    margin-left: 1px;
    opacity: 1;
    color: var(--accent, #aa3bff);
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .bubble :global(h1),
  .bubble :global(h2),
  .bubble :global(h3) {
    margin: 0.4em 0 0.3em;
    line-height: 1.25;
  }
  .bubble :global(h1) { font-size: 1.4em; }
  .bubble :global(h2) { font-size: 1.2em; }
  .bubble :global(h3) { font-size: 1.05em; }
  .bubble :global(p) { margin: 0.4em 0; }
  .bubble :global(p:first-child) { margin-top: 0; }
  .bubble :global(p:last-child) { margin-bottom: 0; }
  .bubble :global(ul),
  .bubble :global(ol) { margin: 0.4em 0; padding-left: 1.4em; }
  .bubble :global(li) { margin: 0.2em 0; }
  .bubble :global(a) { color: var(--accent, #aa3bff); }
  .bubble :global(pre) {
    background: #1f2028;
    padding: 10px 14px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 0.5em 0;
  }
  .bubble :global(pre code) {
    display: block;
    background: none;
    padding: 0;
    color: #abb2bf;
    font-family: var(--mono, monospace);
    font-size: 0.9em;
    line-height: 1.5;
  }
  .bubble :global(table) {
    border-collapse: collapse;
    margin: 0.5em 0;
    font-size: 0.95em;
    display: block;
    overflow-x: auto;
    max-width: 100%;
  }
  .bubble :global(th),
  .bubble :global(td) {
    border: 1px solid var(--border, #2e303a);
    padding: 6px 10px;
    text-align: left;
  }
  .bubble :global(th) {
    background: var(--accent-bg, rgba(170, 59, 255, 0.12));
    font-weight: 600;
  }
  .bubble :global(tr:nth-child(even) td) {
    background: rgba(127, 127, 127, 0.06);
  }
  .bubble :global(blockquote) {
    margin: 0.5em 0;
    padding-left: 12px;
    border-left: 3px solid var(--accent-border, rgba(170, 59, 255, 0.4));
    opacity: 0.85;
  }
  .bubble :global(.katex-display) {
    margin: 0.5em 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 2px 0;
  }
  .bubble :global(svg) {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0.5em auto;
  }
  .bubble :global(.mermaid-pending) {
    font-family: var(--mono, monospace);
    font-size: 0.85em;
    opacity: 0.6;
    white-space: pre-wrap;
  }

  .composer {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin: 8px 0;
  }
  .composer input {
    flex: 1;
    max-width: 520px;
    padding: 10px 14px;
    border-radius: 10px;
    border: 1px solid var(--border, #2e303a);
    background: var(--bg, #16171d);
    color: inherit;
    font: inherit;
  }
  .composer button {
    padding: 10px 18px;
    border-radius: 10px;
    border: 1px solid var(--accent-border, rgba(170, 59, 255, 0.5));
    background: var(--accent-bg, rgba(170, 59, 255, 0.12));
    color: inherit;
    cursor: pointer;
  }
  .fallback {
    display: block;
    margin: 4px auto 0;
    padding: 6px 12px;
    font-size: 0.8em;
    opacity: 0.6;
    background: none;
    border: 1px solid var(--border, #2e303a);
    border-radius: 8px;
    color: inherit;
    cursor: pointer;
  }

  .conn { margin: 0; font-size: 0.85em; }
  .conn.open { color: #4caf50; }
  .conn.connecting { color: #ff9800; }
  .conn.reconnecting { color: #f44336; }
</style>
