<script>
  import { stateToSrc, replyToState, reduceMessages, nextBackoff } from './avatar.js';

  // Agent avatar state — driven by WebSocket push from openabc /native/ws.
  let agentState = $state('idle');
  // Chat transcript: {from: 'you' | 'agent' | 'system', text}.
  let messages = $state([]);
  // Current input draft.
  let draft = $state('');
  // Connection status: 'connecting' | 'open' | 'reconnecting'.
  let connStatus = $state('connecting');

  const states = ['idle', 'speaking', 'listening', 'thinking'];
  const CONN_LABEL = { connecting: '連線中…', open: '已連線', reconnecting: '重連中…' };

  // WebSocket connection: relative to actual host so the embedded binary serves correctly.
  const WS_URL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/native/ws';
  let ws = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  function connectWS() {
    connStatus = reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { connStatus = 'open'; reconnectAttempt = 0; };
    ws.onmessage = (event) => {
      let obj = null;
      try { obj = JSON.parse(event.data); } catch { return; }
      // reaction pushes drive avatar state only; they do NOT enter the message stream.
      agentState = replyToState(obj);
      messages = reduceMessages(messages, obj);
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
    {#each messages as m}
      <li class={m.from}><strong>{m.from}:</strong> {m.text}</li>
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
