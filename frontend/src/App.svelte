<script>
  import { onMount } from 'svelte';
  import mermaid from 'mermaid';
  import { stateToSrc, replyToState, reduceMessages, nextBackoff, revealText, isRevealComplete, scrollTopToBottom, renderRich, shouldRenderRich } from './avatar.js';

  // Agent avatar state — driven by WebSocket push from openabc /native/ws.
  let agentState = $state('idle');
  // Chat transcript: {from: 'you' | 'agent' | 'system', text}.
  let messages = $state([]);
  // reveal state: map from message index to charsShown (only for agent messages)
  let revealState = $state({});
  // Current input draft.
  let draft = $state('');
  // Connection status: 'connecting' | 'open' | 'reconnecting'.
  let connStatus = $state('connecting');

  const states = ['idle', 'speaking', 'listening', 'thinking'];
  const CONN_LABEL = { connecting: '連線中…', open: '已連線', reconnecting: '重連中…' };
  const REVEAL_INTERVAL_MS = 30;

  // WebSocket connection: relative to actual host so the embedded binary serves correctly.
  const WS_URL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/native/ws';
  let ws = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  // Active reveal timers: map from message index to timer id.
  let revealTimers = {};

  function scrollMessagesToEnd() {
    const el = document.getElementById('messages');
    if (el) el.scrollTop = scrollTopToBottom({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
  }

  function startReveal(idx, text) {
    if (revealTimers[idx]) return;
    revealState = { ...revealState, [idx]: 0 };
    revealTimers[idx] = setInterval(() => {
      const current = revealState[idx] ?? 0;
      const next = current + 1;
      revealState = { ...revealState, [idx]: next };
      scrollMessagesToEnd();
      if (isRevealComplete(text, next)) {
        clearInterval(revealTimers[idx]);
        delete revealTimers[idx];
      }
    }, REVEAL_INTERVAL_MS);
  }

  function connectWS() {
    connStatus = reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { connStatus = 'open'; reconnectAttempt = 0; };
    ws.onmessage = (event) => {
      let obj = null;
      try { obj = JSON.parse(event.data); } catch { return; }
      // reaction pushes drive avatar state only; they do NOT enter the message stream.
      agentState = replyToState(obj);
      const prev = messages;
      messages = reduceMessages(messages, obj);
      // If a new agent message was appended, start streaming reveal for it.
      if (messages.length > prev.length) {
        const newIdx = messages.length - 1;
        const newMsg = messages[newIdx];
        if (newMsg.from === 'agent') {
          startReveal(newIdx, newMsg.text);
        }
      }
    };
    ws.onerror = () => { /* onclose will follow with the reconnect */ };
    ws.onclose = () => {
      ws = null;
      connStatus = 'reconnecting';
      // Exponential backoff reconnect — a dropped socket must not leave the UI silently dead.
      const delay = nextBackoff(reconnectAttempt);
      reconnectAttempt += 1;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWS, delay);
    };
  }

  connectWS();

  // Initialise mermaid once at startup (browser-only; startOnLoad:false so we
  // drive rendering manually from renderMermaidPending).
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

  /**
   * Find all .mermaid-pending nodes that haven't been rendered yet, decode
   * their data-mermaid base64 payload, and render them to SVG in place.
   * Called after each reactive update that might have produced new rich HTML.
   */
  async function renderMermaidPending() {
    const nodes = document.querySelectorAll('.mermaid-pending[data-mermaid]');
    for (const node of nodes) {
      // data-mermaid holds the base64-encoded, XSS-sanitized graph source.
      const encoded = node.getAttribute('data-mermaid');
      if (!encoded) continue;
      let source;
      try {
        source = decodeURIComponent(escape(atob(encoded)));
      } catch {
        continue; // malformed base64 — skip
      }
      // Mark as rendered before the async call to prevent double-rendering.
      node.removeAttribute('data-mermaid');
      node.classList.remove('mermaid-pending');
      try {
        const id = 'mermaid-' + Math.random().toString(36).slice(2);
        const { svg } = await mermaid.render(id, source);
        node.innerHTML = svg;
      } catch {
        // Render failure (e.g., invalid diagram) — show plain text fallback.
        node.textContent = source;
      }
    }
  }

  onMount(() => {
    renderMermaidPending();
  });

  // Re-run after every reactive update in case new rich messages appeared.
  $effect(() => {
    // Touch the reactive dependencies we care about (messages + revealState)
    // so Svelte re-runs this effect whenever they change.
    const _ = messages;
    const __ = revealState;
    // Defer slightly so the DOM settles first.
    Promise.resolve().then(renderMermaidPending);
  });

  // Send the draft to the agent as an inbound {"text": ...} message.
  function send() {
    const text = draft.trim();
    if (!text) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Surface the failure instead of silently dropping the message.
      messages = [...messages, { from: 'system', text: '⚠ 尚未連線,訊息未送出,正在重連…' }];
      return;
    }
    ws.send(JSON.stringify({ text }));
    messages = [...messages, { from: 'you', text }];
    draft = '';
  }

  function onKey(e) {
    if (e.key === 'Enter') send();
  }

  // Sprite asset paths (referenced here for gate traceability; mapping lives in stateToSrc):
  // /assets/idle.png  /assets/speaking.png  /assets/listening.png  /assets/thinking.png

  // Manual fallback button — cycles state locally when WS is unavailable.
  function nextState() {
    const idx = states.indexOf(agentState);
    agentState = states[(idx + 1) % states.length];
  }
</script>

<main>
  <h1>openabc agent avatar</h1>

  <div class="avatar">
    <img src={stateToSrc(agentState)} alt={agentState} width="64" height="64" />
    <p>State: <strong>{agentState}</strong></p>
    <p class="conn {connStatus}">● {CONN_LABEL[connStatus]}</p>
  </div>

  <ul id="messages" style="max-height:40vh;overflow-y:auto">
    {#each messages as m, i}
      <li class={m.from}>
        <span class="label">{m.from}</span>
        <div class="bubble{m.from === 'agent' && !isRevealComplete(m.text, revealState[i] ?? 0) ? ' revealing' : ''}">
          {#if m.from === 'agent'}
            {#if shouldRenderRich(isRevealComplete(m.text, revealState[i] ?? 0))}
              {@html renderRich(m.text)}
            {:else}
              {revealText(m.text, revealState[i] ?? 0)}
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
</main>

<style>
  /* Centered, comfortable reading column. main is otherwise unstyled and would
     inherit #app's text-align:center, which mis-centers chat content. */
  main {
    max-width: 820px;
    margin: 0 auto;
    padding: 0 24px 48px;
    box-sizing: border-box;
    text-align: left;
  }

  h1 { text-align: center; }

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

  /* Agent bubbles carry rich block content (headings/lists/math/diagrams);
     let them use the full column width so content isn't cramped. */
  #messages li.agent {
    align-self: flex-start;
    align-items: stretch;
    width: 100%;
  }

  #messages li.you {
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

  #messages li.you .bubble {
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

  /* Rich content injected via {@html} is NOT scoped by Svelte, so style it
     through :global(). Tighten default margins and size diagrams/math/code. */
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
    background: var(--code-bg, #1f2028);
    padding: 10px 14px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 0.5em 0;
  }
  .bubble :global(pre code) { background: none; padding: 0; }
  .bubble :global(blockquote) {
    margin: 0.5em 0;
    padding-left: 12px;
    border-left: 3px solid var(--accent-border, rgba(170, 59, 255, 0.4));
    opacity: 0.85;
  }
  /* KaTeX block formulas: keep on one scrollable line rather than overflowing. */
  .bubble :global(.katex-display) {
    margin: 0.5em 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 2px 0;
  }
  /* Mermaid renders an <svg> in place — fit it to the bubble. */
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
</style>
