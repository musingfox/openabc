<script>
  import { stateToSrc, replyToState, reduceMessages } from './avatar.js';

  // Agent avatar state — driven by WebSocket push from openabc /native/ws.
  let agentState = $state('idle');
  // Chat transcript: {from: 'you' | 'agent', text}.
  let messages = $state([]);
  // Current input draft.
  let draft = $state('');

  const states = ['idle', 'speaking', 'listening', 'thinking'];

  // WebSocket connection: relative to actual host so the embedded binary serves correctly.
  const WS_URL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/native/ws';
  let ws = null;

  function connectWS() {
    ws = new WebSocket(WS_URL);
    ws.onmessage = (event) => {
      let obj = null;
      try { obj = JSON.parse(event.data); } catch { return; }
      // reaction pushes drive avatar state only; they do NOT enter the message stream.
      agentState = replyToState(obj);
      messages = reduceMessages(messages, obj);
    };
    ws.onerror = () => { /* ignore */ };
    ws.onclose = () => { ws = null; };
  }

  connectWS();

  // Send the draft to the agent as an inbound {"text": ...} message.
  function send() {
    const text = draft.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
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
