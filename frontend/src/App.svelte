<script>
  import { stateToSrc, replyToState, reduceMessages, nextBackoff, revealText, isRevealComplete } from './avatar.js';

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
    if (el) el.scrollTop = el.scrollHeight;
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

  <ul id="messages">
    {#each messages as m, i}
      <li class={m.from}>
        <span class="label">{m.from}</span>
        <div class="bubble{m.from === 'agent' && !isRevealComplete(m.text, revealState[i] ?? 0) ? ' revealing' : ''}">
          {#if m.from === 'agent'}
            {revealText(m.text, revealState[i] ?? 0)}
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
  #messages {
    list-style: none;
    padding: 0;
    margin: 16px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  #messages li {
    display: flex;
    flex-direction: column;
    max-width: 70%;
  }

  #messages li.agent {
    align-self: flex-start;
    align-items: flex-start;
  }

  #messages li.you {
    align-self: flex-end;
    align-items: flex-end;
  }

  #messages li.system {
    align-self: center;
    align-items: center;
  }

  .label {
    font-size: 0.75em;
    opacity: 0.6;
    margin-bottom: 2px;
  }

  .bubble {
    padding: 8px 12px;
    border-radius: 12px;
    background: var(--accent-bg, rgba(170, 59, 255, 0.1));
    border: 1px solid var(--accent-border, rgba(170, 59, 255, 0.3));
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
</style>
