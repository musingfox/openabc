<script>
  // Agent avatar state machine
  // States: idle | speaking | listening | thinking
  let agentState = $state('idle');

  const states = ['idle', 'speaking', 'listening', 'thinking'];

  const stateImages = {
    idle:      '/assets/idle.png',
    speaking:  '/assets/speaking.png',
    listening: '/assets/listening.png',
    thinking:  '/assets/thinking.png',
  };

  function nextState() {
    const idx = states.indexOf(agentState);
    agentState = states[(idx + 1) % states.length];
  }
</script>

<main>
  <h1>openabc agent avatar</h1>
  <p>State: <strong>{agentState}</strong></p>
  <img src={stateImages[agentState]} alt={agentState} width="64" height="64" />
  <br />
  <button onclick={nextState}>next state</button>
</main>
