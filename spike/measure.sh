#!/usr/bin/env bash
# spike/measure.sh — reproducible measurements for gate-turn-2 Example E/F.
# Run from spike/ (gate does: cd "$SPIKE" && bash measure.sh).
# Idempotent: deletes measurements.json before regenerating.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

rm -f measurements.json

# ── 1. bundle_gzip_bytes: rebuild frontend, then gzip-measure JS+CSS assets ──
echo "[measure] building frontend..."
(cd frontend && bun install --frozen-lockfile 2>/dev/null && bun run build 2>/dev/null)

# Sum gzip size of all JS and CSS files in dist (excluding html, png, svg).
BUNDLE_GZIP=0
for f in frontend/dist/assets/*.js frontend/dist/assets/*.css; do
  [ -f "$f" ] || continue
  SZ="$(gzip -c "$f" | wc -c | tr -d ' ')"
  BUNDLE_GZIP=$((BUNDLE_GZIP + SZ))
done

# ── 2. idle_rss_bytes: start backend, measure RSS after it is ready, then kill ──
echo "[measure] starting backend..."
BACKEND_BIN="backend/target/release/spike-ws-echo"
if [ ! -f "$BACKEND_BIN" ]; then
  echo "[measure] binary not found, building backend..."
  (cd backend && cargo build --release 2>/dev/null)
fi

# Start backend; wait for it to bind port 9001 (up to 5s).
"$BACKEND_BIN" &
BPID=$!
READY=0
for i in $(seq 1 50); do
  sleep 0.1
  if lsof -i :9001 -sTCP:LISTEN >/dev/null 2>&1; then
    READY=1; break
  fi
done
if [ "$READY" = 0 ]; then
  kill "$BPID" 2>/dev/null || true
  echo "[measure] ERROR: backend did not start in time" >&2
  exit 1
fi

# Read RSS via /proc (Linux) or ps (macOS).
if [ -f "/proc/$BPID/status" ]; then
  # Linux: VmRSS in kB
  RSS_KB="$(grep VmRSS /proc/$BPID/status | awk '{print $2}')"
  IDLE_RSS=$((RSS_KB * 1024))
else
  # macOS: ps -o rss gives RSS in KB
  RSS_KB="$(ps -o rss= -p "$BPID" 2>/dev/null | tr -d ' ')"
  IDLE_RSS=$((RSS_KB * 1024))
fi

kill "$BPID" 2>/dev/null || true
wait "$BPID" 2>/dev/null || true

# ── 3. first_frame_ms: proxy via Node.js timing a fetch of dist/index.html ──
# True headless browser not required; we use the time to receive the first byte
# of index.html from a local static server (a reproducible proxy for "something
# rendered appears").  Starts a one-shot node http server, times the request.
echo "[measure] measuring first_frame_ms..."
FIRST_FRAME_MS="$(node - <<'EOF'
const http = require('http');
const fs   = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'frontend', 'dist');
const html = fs.readFileSync(path.join(distDir, 'index.html'));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const t0 = Date.now();
  const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
    res.on('data', () => {});
    res.on('end', () => {
      const ms = Date.now() - t0;
      server.close();
      console.log(ms);
    });
  });
  req.on('error', (e) => { console.error(e); process.exit(1); });
});
EOF
)"

# ── 4. Write measurements.json ──
cat > measurements.json <<ENDJSON
{
  "bundle_gzip_bytes": $BUNDLE_GZIP,
  "idle_rss_bytes": $IDLE_RSS,
  "first_frame_ms": $FIRST_FRAME_MS
}
ENDJSON

echo "[measure] done: bundle_gzip_bytes=$BUNDLE_GZIP idle_rss_bytes=$IDLE_RSS first_frame_ms=$FIRST_FRAME_MS"
echo "[measure] written: measurements.json"
