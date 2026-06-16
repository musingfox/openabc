<script>
  import { stateToSrc, replyToState } from './avatar.js';

  // Agent avatar state — driven by WebSocket push from openabc /native/ws.
  let agentState = $state('idle');

  const states = ['idle', 'speaking', 'listening', 'thinking'];

  // WebSocket connection: relative to actual host so the embedded binary serves correctly.
  const WS_URL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/native/ws';
  let ws = null;

  function connectWS() {
    ws = new WebSocket(WS_URL);
    ws.onmessage = (event) => {
      let obj = null;
      try { obj = JSON.parse(event.data); } catch { return; }
      agentState = replyToState(obj);
    };
    ws.onerror = () => { /* ignore */ };
    ws.onclose = () => { ws = null; };
  }

  connectWS();

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
  <p>State: <strong>{agentState}</strong></p>
  <img src={stateToSrc(agentState)} alt={agentState} width="64" height="64" />
  <br />
  <button onclick={nextState}>next state (fallback)</button>
</main>
