<script>
  import { onDestroy, onMount } from 'svelte';
  import mermaid from 'mermaid';
  import { stateToSrc, replyToState, nextBackoff, revealText, isRevealComplete, scrollTopToBottom, renderRich, shouldRenderRich, splitRevealedForRender, composeAgentState, voiceQueueReducer, shouldAutoplay, loadMutePref, saveMutePref } from './avatar.js';
  import { createChannelStore, ingestSocketMessage } from './channels.js';

  // ── Channel store ──────────────────────────────────────────────────────────
  // Each channel holds its own independent /native/ws connection.
  const store = createChannelStore();

  // Reactive conversation list and active selection.
  let channelList = $state([]);
  let activeChannelId = $state(null);

  // Monotonic counter for auto-naming new conversations ("對話 N").
  let convoCounter = 0;

  // Per-channel state: agentState, connStatus, revealState, reconnect trackers.
  // Keyed by channelId.
  let channelMeta = $state({});

  const CONN_LABEL = { connecting: '連線中…', open: '已連線', reconnecting: '重連中…' };
  const REVEAL_INTERVAL_MS = 30;

  // Friendly persistent labels for the agent presence state (single status output;
  // replaces the old ephemeral reaction-chip burst rail).
  const STATE_LABEL = { idle: '待命', listening: '已收到', thinking: '思考中', speaking: '回覆中' };

  // Active reveal timers: map from `${channelId}-${msgId}` to timer id.
  let revealTimers = {};
  // Sound preference initialises from persisted mute pref (survives reload).
  let soundEnabled = $state(loadMutePref());
  let activeVoiceId = $state(null);
  let voiceError = $state('');

  // ── Voice playback queue ──────────────────────────────────────────────────
  // Agent messages awaiting TTS playback, in FIFO order. Mutated only via the
  // pure voiceQueueReducer. ttsSpeaking follows real audio start/stop and is the
  // authority for the "speaking" sprite (composeAgentState), not the reply type.
  let voiceQueue = $state([]);
  let ttsSpeaking = $state(false);

  // Injectable synth seam (default = window.speechSynthesis) so the playback
  // wiring stays exercisable; pure decision logic lives in avatar.js.
  function getSynth() {
    if (typeof window === 'undefined' || !window.speechSynthesis) return null;
    if (typeof window.SpeechSynthesisUtterance === 'undefined') return null;
    return window.speechSynthesis;
  }

  // Persistence helper that always targets the default (localStorage) store.
  function persistSound(value) {
    if (typeof window === 'undefined') return;
    try { saveMutePref(window.localStorage, value); } catch { /* no-op */ }
  }

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

  // ── Voice playback engine ─────────────────────────────────────────────────
  // We self-manage the queue (head = currently playing / next to play) and do
  // NOT rely on cancel-triggered onend to advance (browser semantics vary).

  function enqueueVoice(message) {
    if (!message || typeof message.text !== 'string' || message.text.length === 0) return;
    voiceQueue = voiceQueueReducer(voiceQueue, {
      type: 'enqueue',
      item: { id: message.id, text: message.text },
    });
    startPlaybackIfIdle();
  }

  // Advance to the next queued item and play it. Plays only when nothing is
  // currently speaking; the head of the queue is the item to play.
  function startPlaybackIfIdle() {
    if (ttsSpeaking) return;
    speakHead();
  }

  function speakHead() {
    const item = voiceQueue[0];
    if (!item) { activeVoiceId = null; return; }

    const synth = getSynth();
    if (!synth) {
      voiceError = '此瀏覽器不支援語音播放';
      voiceQueue = voiceQueueReducer(voiceQueue, { type: 'clear' });
      activeVoiceId = null;
      return;
    }

    const utterance = new window.SpeechSynthesisUtterance(item.text);
    utterance.lang = 'zh-TW';
    activeVoiceId = item.id;
    voiceError = '';

    utterance.onstart = () => { ttsSpeaking = true; };
    utterance.onend = () => {
      ttsSpeaking = false;
      // Dequeue the finished head and advance to the next item.
      voiceQueue = voiceQueueReducer(voiceQueue, { type: 'dequeue' });
      activeVoiceId = null;
      speakHead();
    };
    utterance.onerror = () => {
      ttsSpeaking = false;
      voiceError = '語音播放失敗';
      // One bad item must not wedge the rest of the queue.
      voiceQueue = voiceQueueReducer(voiceQueue, { type: 'dequeue' });
      activeVoiceId = null;
      speakHead();
    };

    synth.speak(utterance);
  }

  function defaultChannelMeta() {
    return {
      agentState: 'idle',
      connStatus: 'connecting',
      revealState: {},
      reconnectAttempt: 0,
      reconnectTimer: null,
    };
  }

  function openChannel(name) {
    const id = store.addChannel(name);
    const ch = store.channel(id);

    // Per-channel meta defaults.
    channelMeta = {
      ...channelMeta,
      [id]: {
        ...defaultChannelMeta(),
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

      // Reaction-derived state (no longer the speaking authority; speaking now
      // follows real TTS audio via composeAgentState at render time).
      const reactionState = replyToState(obj);
      const prevMessages = store.channel(id).messages;

      // Route the raw frame through the shared ingest fn (production path, tested by probe).
      ingestSocketMessage(store, id, event.data);

      const next = store.channel(id).messages;
      channelList = store.channels(); // trigger reactivity

      // Start streaming reveal for newly appended agent messages, and auto-play
      // them when sound is on.
      if (next.length > prevMessages.length) {
        const newMsg = next[next.length - 1];
        if (newMsg.from === 'agent') {
          startReveal(id, newMsg.id, newMsg.text);
          if (shouldAutoplay({ soundEnabled, isNewAgentMessage: true })) {
            enqueueVoice(newMsg);
          }
        }
      }

      channelMeta = {
        ...channelMeta,
        [id]: { ...channelMeta[id], agentState: reactionState },
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
      const reactionState = obj ? replyToState(obj) : (channelMeta[id]?.agentState ?? 'idle');
      const prevMessages = store.channel(id).messages;

      // Route through shared ingest (already wired, call again is idempotent for
      // the onmessage that store.reconnect set; we override here to add avatar effect).
      ingestSocketMessage(store, id, event.data);

      const next = store.channel(id).messages;
      channelList = store.channels();
      if (next.length > prevMessages.length) {
        const newMsg = next[next.length - 1];
        if (newMsg.from === 'agent') {
          startReveal(id, newMsg.id, newMsg.text);
          if (shouldAutoplay({ soundEnabled, isNewAgentMessage: true })) {
            enqueueVoice(newMsg);
          }
        }
      }
      channelMeta = { ...channelMeta, [id]: { ...channelMeta[id], agentState: reactionState } };
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

  // Open the first conversation on mount.
  onMount(() => {
    newConversation();
    renderMermaidPending();
  });

  onDestroy(() => {
    Object.values(revealTimers).forEach(clearInterval);
    voiceQueue = voiceQueueReducer(voiceQueue, { type: 'clear' });
    ttsSpeaking = false;
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  });

  // One-click new conversation: auto-named "對話 N", opened and activated.
  function newConversation() {
    openChannel(`對話 ${++convoCounter}`);
  }

  function switchChannel(id) {
    activeChannelId = id;
    store.setActive(id);
  }

  // Current active channel derived values.
  let activeChannel = $derived(activeChannelId ? store.channel(activeChannelId) : null);
  // Use store.activeMessages() so the display layer uses the same data path the tests probe.
  // The store is plain JS (not $state), so this derived must read a reactive source to recompute:
  // App reassigns `channelList` at every store mutation site (send/onmessage/appendLocal/openChannel),
  // so depending on it (+ activeChannelId for switching) re-runs this when messages change.
  let activeMessages = $derived.by(() => {
    void channelList; void activeChannelId;
    return store.activeMessages();
  });
  let activeMeta = $derived(activeChannelId ? (channelMeta[activeChannelId] ?? {}) : {});
  // Speaking follows real TTS audio (ttsSpeaking) and otherwise the reaction-
  // derived state stored in channelMeta.agentState.
  let agentState = $derived(composeAgentState({ ttsSpeaking, reactionState: activeMeta.agentState ?? 'idle' }));
  let connStatus = $derived(activeMeta.connStatus ?? 'connecting');
  let revealState = $derived(activeMeta.revealState ?? {});
  let activeAgentMessage = $derived([...activeMessages].reverse().find((m) => m.from === 'agent'));

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

  function toggleSound() {
    soundEnabled = !soundEnabled;
    persistSound(soundEnabled);
    if (!soundEnabled) stopVoice();
  }

  function stopVoice() {
    // Clear the whole queue and stop the synth; speaking ends immediately.
    voiceQueue = voiceQueueReducer(voiceQueue, { type: 'clear' });
    const synth = getSynth();
    if (synth) synth.cancel();
    ttsSpeaking = false;
    activeVoiceId = null;
    voiceError = '';
  }

  // Manual replay of a single message: enqueue onto the shared queue so it plays
  // in order (and starts immediately when idle). Preserves the replay-one UX.
  function replayVoice(message) {
    if (!message || !soundEnabled) return;
    if (!getSynth()) {
      voiceError = '此瀏覽器不支援語音播放';
      return;
    }
    enqueueVoice(message);
  }

  function onKey(e) {
    if (e.key === 'Enter') send();
  }
</script>

<main>
  <div class="layout">
    <!-- ── Channel sidebar ── -->
    <aside class="channels-panel">
      <div class="channels-header">對話</div>
      <button class="new-convo" onclick={newConversation}>＋ 新對話</button>
      <ul class="channel-list">
        {#each channelList as ch (ch.id)}
          <li class="channel-row">
            <button
              class="channel-item{ch.id === activeChannelId ? ' active' : ''}"
              onclick={() => switchChannel(ch.id)}
            >
              <span class="ch-dot {channelMeta[ch.id]?.connStatus ?? 'connecting'}">●</span>
              <span class="ch-name">{ch.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    </aside>

    <!-- ── Main chat area ── -->
    <section class="chat-area">
      <div class="agent-rail" aria-label="agent presence">
        <div class="avatar-shell {agentState}">
          <img src={stateToSrc(agentState)} alt={`agent ${agentState}`} width="104" height="104" />
        </div>
        <div class="agent-copy">
          <p class="agent-name">openabc</p>
          <p class="agent-state">{STATE_LABEL[agentState] ?? agentState}</p>
          <p class="conn {connStatus}">● {CONN_LABEL[connStatus] ?? connStatus}</p>
        </div>
        <div class="voice-panel" aria-label="語音控制">
          <button
            class:enabled={soundEnabled}
            aria-pressed={soundEnabled}
            onclick={toggleSound}
            title={soundEnabled ? '關閉語音' : '開啟語音'}
          >
            {soundEnabled ? '聲音開' : '靜音'}
          </button>
          <button
            disabled={!soundEnabled || !activeAgentMessage}
            onclick={() => replayVoice(activeAgentMessage)}
            title="重播最近一則 agent 回覆"
          >
            重播
          </button>
          {#if activeVoiceId}
            <button onclick={stopVoice} title="停止播放">停止</button>
          {/if}
        </div>
        {#if voiceError}
          <p class="voice-error">{voiceError}</p>
        {/if}
      </div>

      <ul id="messages">
        {#each activeMessages as m (m.id)}
          <li class="{m.from}{m.id === activeVoiceId ? ' voice-playing' : ''}">
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
            {#if m.from === 'agent'}
              <div class="message-tools">
                <button
                  disabled={!soundEnabled}
                  onclick={() => replayVoice(m)}
                  title={soundEnabled ? '播放此回覆' : '先開啟聲音'}
                >
                  {m.id === activeVoiceId ? '播放中' : '聽'}
                </button>
              </div>
            {/if}
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
    width: calc(100% - 8px);
    padding: 7px 12px;
    cursor: pointer;
    border-radius: 6px;
    margin: 2px 4px;
    font-size: 0.92em;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  .channel-item:hover {
    background: var(--accent-bg, rgba(170, 59, 255, 0.08));
  }

  .channel-item.active {
    background: var(--accent-bg, rgba(170, 59, 255, 0.18));
    font-weight: 600;
    box-shadow: inset 3px 0 0 var(--accent-border, rgba(170, 59, 255, 0.8));
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

  .new-convo {
    margin: 8px;
    padding: 9px 12px;
    border-radius: 8px;
    border: 1px solid var(--accent-border, rgba(170, 59, 255, 0.5));
    background: var(--accent-bg, rgba(170, 59, 255, 0.12));
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: 0.9em;
    font-weight: 600;
    text-align: center;
  }

  .new-convo:hover {
    background: var(--accent-bg, rgba(170, 59, 255, 0.22));
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

  .conn { margin: 0; font-size: 0.85em; }
  .conn.open { color: #4caf50; }
  .conn.connecting { color: #ff9800; }
  .conn.reconnecting { color: #f44336; }

  main {
    max-width: 1180px;
    min-height: 100svh;
    padding: 24px;
  }

  .layout {
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
    gap: 18px;
    align-items: stretch;
  }

  .channels-panel {
    width: auto;
    min-height: calc(100svh - 48px);
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg) 94%, var(--border));
  }

  .chat-area {
    display: grid;
    grid-template-columns: 168px minmax(0, 1fr);
    grid-template-rows: 1fr auto auto auto;
    gap: 14px 18px;
    min-height: calc(100svh - 48px);
  }

  .agent-rail {
    grid-row: 1 / 5;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 14px;
    padding: 16px 14px;
    border-right: 1px solid var(--border, #e5e4e7);
  }

  .avatar-shell {
    width: 128px;
    height: 128px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border, #e5e4e7);
    border-radius: 8px;
    background: #f4f3ec;
    overflow: hidden;
  }

  .avatar-shell img {
    width: 104px;
    height: 104px;
    image-rendering: pixelated;
  }

  .avatar-shell.speaking img {
    animation: speak-bob 680ms ease-in-out infinite;
  }

  .avatar-shell.listening {
    box-shadow: inset 0 0 0 2px rgba(42, 157, 143, 0.35);
  }

  .avatar-shell.thinking {
    box-shadow: inset 0 0 0 2px rgba(233, 196, 106, 0.55);
  }

  .agent-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .agent-name {
    color: var(--text-h);
    font-weight: 700;
    line-height: 1.2;
  }

  .agent-state {
    font-family: var(--mono, monospace);
    font-size: 0.78em;
    color: var(--accent);
  }

  .voice-panel {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .voice-panel button,
  .message-tools button {
    min-height: 36px;
    border-radius: 8px;
    border: 1px solid var(--border, #e5e4e7);
    background: var(--bg);
    color: inherit;
    font: inherit;
    font-size: 0.82em;
    cursor: pointer;
  }

  .voice-panel button.enabled {
    border-color: rgba(42, 157, 143, 0.7);
    background: rgba(42, 157, 143, 0.12);
    color: var(--text-h);
  }

  .voice-panel button:disabled,
  .message-tools button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .voice-error {
    font-size: 0.78em;
    color: #c2410c;
    line-height: 1.35;
  }

  #messages {
    min-height: 0;
    max-height: none;
    height: calc(100svh - 170px);
    margin: 0;
    padding: 6px 4px 12px;
    gap: 14px;
  }

  #messages li {
    position: relative;
    max-width: min(760px, 92%);
  }

  #messages li.agent {
    width: auto;
  }

  #messages li.voice-playing .bubble {
    border-color: rgba(42, 157, 143, 0.7);
    box-shadow: 0 0 0 2px rgba(42, 157, 143, 0.1);
  }

  .bubble {
    border-radius: 8px;
  }

  .message-tools {
    display: flex;
    justify-content: flex-start;
    margin-top: 5px;
  }

  .message-tools button {
    min-width: 48px;
    min-height: 32px;
  }

  .composer {
    grid-column: 2;
    margin: 0;
    justify-content: stretch;
  }

  .composer input {
    max-width: none;
    min-height: 44px;
    border-radius: 8px;
  }

  .composer button {
    min-width: 72px;
    min-height: 44px;
    border-radius: 8px;
  }

  @keyframes speak-bob {
    0%, 100% { transform: translateY(0) scale(1); }
    50% { transform: translateY(-2px) scale(1.02); }
  }

  @media (prefers-color-scheme: dark) {
    .avatar-shell {
      background: #1f2028;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .avatar-shell.speaking img,
    .bubble.revealing::after {
      animation: none;
    }
  }

  @media (max-width: 760px) {
    main {
      padding: 0;
    }

    .layout {
      grid-template-columns: 1fr;
      gap: 0;
    }

    .channels-panel {
      min-height: 0;
      border-radius: 0;
      border-inline: 0;
      border-top: 0;
    }

    .channel-list {
      display: flex;
      overflow-x: auto;
      padding: 6px;
    }

    .channel-item {
      min-width: 112px;
      min-height: 36px;
      width: auto;
    }

    .chat-area {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr auto auto auto;
      min-height: calc(100svh - 116px);
      padding: 12px;
    }

    .agent-rail {
      grid-row: auto;
      flex-direction: row;
      align-items: center;
      padding: 10px 0 12px;
      border-right: 0;
      border-bottom: 1px solid var(--border, #e5e4e7);
    }

    .avatar-shell {
      width: 72px;
      height: 72px;
      flex: 0 0 auto;
    }

    .avatar-shell img {
      width: 58px;
      height: 58px;
    }

    .agent-copy {
      min-width: 82px;
      flex: 1;
    }

    .voice-panel {
      width: 132px;
      flex: 0 0 auto;
    }

    #messages {
      height: 42svh;
      min-height: 220px;
      grid-column: 1;
    }

    .composer {
      grid-column: 1;
    }

    #messages li {
      max-width: 96%;
    }
  }
</style>
