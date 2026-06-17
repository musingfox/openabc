# Rendering While Streaming — Implementation Handoff Plan

> Target consumer: `/context-flow:cf` implement agent.
> This document is a planning artifact, not production code.
> Do NOT modify any frontend or backend source in this turn.

---

## Investigated

- `frontend/src/avatar.js` — pure functions: `revealText`, `isRevealComplete`, `renderRich`, `shouldRenderRich`, `scrollTopToBottom`; the streaming/rich coexistence switch lives here.
- `frontend/src/App.svelte` — bubble template (line 176–179), `startReveal`, `renderMermaidPending`, `$effect` re-render hook, `revealing` CSS class; the per-tick render decision lives here.
- `frontend/src/avatar.test.js` — full existing test suite; `shouldRenderRich` tests at lines 286–291 (bun path) and 637–642 (node path); these are the tests that must be updated or superseded.
- `.spiral/gate-turn-18.sh` — full regression gate; the 8 invariants below are derived from its checks.
- `.spiral/gate-turn-19.sh` — the document-shape gate this plan must satisfy.

---

## Assumptions

- `renderRich` remains a pure, synchronous function with no browser-DOM dependency — all new helpers can follow the same pattern and be tested with `bun test`. Affects: SplitRevealedForRender contract.
- `Intl.Segmenter` remains the grapheme-split mechanism in `revealText`; the new helper receives the already-split prefix string (not the raw `full` + `charsShown`), so grapheme integrity is guaranteed upstream. Affects: Grapheme Safety contract.
- `isomorphic-dompurify` is a singleton in the module; the mermaid hook registration/de-registration pattern already in `renderRich` is safe to call on a partial prefix. Affects: SplitRevealedForRender contract.
- The `mermaid.initialize` call and the `renderMermaidPending` / `$effect` loop in App.svelte remain structurally unchanged; only the input HTML that feeds them changes (prefix HTML may now include mermaid-pending nodes before full reveal). Affects: MermaidPendingOnClose contract.

---

## Decisions

### D1: Hybrid prefix/suffix split replaces binary reveal-gate

- **Impact**: Medium
- **Choice**: Replace the `shouldRenderRich(isRevealComplete(...))` binary gate with a call to a new helper `splitRevealedForRender(revealedPrefix)` that splits the already-revealed text into a safe-to-render prefix and a plain-text suffix, then renders the prefix with the existing `renderRich` pipeline.
- **Trade-off**: Gains incremental rich display during streaming; mermaid diagrams and math equations appear as soon as their fence/delimiter closes, not only after the full message arrives. Gives up the simplicity of the current binary gate (one branch in the template vs. two). The per-tick cost of running `renderRich` on a partial string is higher than the current guard — mitigation is that `renderRich` is already O(n) and the prefix grows incrementally. Performance tuning (debounce, memoize last rendered prefix) is a two-way door left to later iterations.
- **Alternatives considered**: Full re-parse of the entire `fullText` on every tick and discarding the tail — same complexity, worse DX because the tail is not available as plain text; rejected. Incremental fence-state machine tracking grapheme by grapheme — lower per-tick cost, but significantly more complex and harder to test in isolation; rejected for this iteration.
- **Rationale**: Re-using the existing `renderRich` pipeline on the safe prefix requires zero changes to the rendering logic itself; the only new surface is the split function. This keeps the diff minimal and keeps all existing renderRich tests as-is.

### D2: Every tick re-run split+renderRich on the revealed prefix (two-way door — default chosen)

- **Impact**: Medium
- **Choice**: On every `setInterval` tick in `startReveal`, compute `splitRevealedForRender(revealText(m.text, charsShown))` and use the result directly in the bubble template. No caching across ticks.
- **Trade-off**: Simplest implementation; the existing pipeline is already called once per message on completion, now called once per tick. At 30 ms intervals and typical message lengths (< 10 KB) this is acceptable. If profiling shows jank, a memoize-last-input guard (skip re-render if prefix string unchanged) is a one-line change. Making a decision now not to cache keeps the code surface minimal.
- **Alternatives considered**: Debounced render (only re-render every N ticks) — reduces cost, complicates the split boundary logic and introduces lag; rejected. Memoizing last rendered prefix — net benefit depends on how frequently the prefix changes (always by ≥1 grapheme), so the cache rarely hits for short graphemes; deferred.
- **Rationale**: Matches the "minimum viable" operating model; correctness is easier to validate than an optimized version.

### D3: splitRevealedForRender is a new exported pure function in avatar.js (one-way door — UNRESOLVED, see Unresolved section)

- **Impact**: High (one-way door — this shapes the exported API surface of avatar.js and the test contract for every future streaming-render feature)
- **Choice**: Tentatively export `splitRevealedForRender` from `avatar.js` as a named export, making it part of the public pure-function API.
- **Trade-off**: Exporting enables direct `bun test` coverage without App.svelte involvement — cleaner contract. Once exported and consumed by App.svelte, the function signature becomes a two-party contract; renaming it is a refactor but not data-destructive. The risk is over-exposing an internal mechanism.
- **Alternatives considered**: Keep it module-private (unexported), test only through App.svelte integration tests — harder to write deterministic unit tests for the split logic; rejected for this iteration but noted in Unresolved.
- **Rationale**: Consistent with existing avatar.js pattern (all pure functions are exported and unit-tested directly).

---

## Behavioral Contracts

### SplitRevealedForRender

- **Effect**: Given the already-revealed text prefix, the bubble renders any fully-closed markdown/LaTeX/mermaid regions as rich HTML while leaving any unclosed region as plain text appended after the HTML.
- **purpose**: Enables incremental rich display during streaming (E1, E3 of goal).
- **input**: `revealedPrefix: string` — the result of `revealText(m.text, charsShown)`, i.e. the grapheme-safe prefix of the full message text currently visible.
- **output**: `{ richHtml: string, plainTail: string }` — `richHtml` is the sanitized HTML of the safe-to-render prefix (may be empty string), `plainTail` is the unsafe remainder as plain text (may be empty string). Concatenating them in this order reconstructs the full revealed content.
- **errors**: Never throws. If split detection is ambiguous, the entire `revealedPrefix` is returned as `plainTail` with empty `richHtml` (fail-safe to plain text).
- **depends**: `renderRich` (for the prefix HTML), `revealText` / `isRevealComplete` upstream in App.svelte.

#### Prefix/suffix split rule

The split point is the index of the **start of the last unclosed special region** in `revealedPrefix`. "Special region" means:

1. **Code fence**: an opening ` ``` ` (optionally with a language tag) that has no matching closing ` ``` ` later in the prefix.
2. **Display math**: an opening `$$` that has no matching closing `$$`.
3. **Inline math**: an opening `$` (not followed immediately by another `$`) that has no matching closing `$` on the same line.
4. **Mermaid fence**: a code fence with language `mermaid` — handled identically to rule 1 (it is a code fence variant); the mermaid-pending node is only emitted after the closing ` ``` ` is included in the prefix.

Algorithm (linear scan, O(n)):
1. Walk `revealedPrefix` left-to-right tracking open/close state for each construct above.
2. Record the byte index where each unclosed construct opened.
3. After the full scan, if any construct is still open, the split point is the minimum open-start index across all open constructs.
4. `prefix = revealedPrefix.slice(0, splitPoint)`, `suffix = revealedPrefix.slice(splitPoint)`.
5. If no construct is open, `prefix = revealedPrefix`, `suffix = ''`.
6. Call `renderRich(prefix)` → `richHtml`; return `{ richHtml, plainTail: suffix }`.

#### States (user-facing)

- **Streaming / in-progress**: bubble shows `{@html richHtml}` (rich HTML of closed regions) followed immediately by `{plainTail}` (plain text of unclosed tail); the `.revealing::after` cursor still applies to the bubble wrapper.
- **Reveal complete**: `isRevealComplete` is still called to detect completion; on completion, `splitRevealedForRender` is called with the full text → split point is at end (no unclosed regions in a complete message) → `richHtml = renderRich(fullText)`, `plainTail = ''` — same visual result as current behavior.
- **Empty prefix** (charsShown = 0): `richHtml = ''`, `plainTail = ''` — empty bubble (same as today).

#### Test Cases

- input `"Hello **world**"` (fully closed, no special region) → `richHtml` contains `<strong>world</strong>`, `plainTail = ''`.
- input `"See $x$ and now \`\`\`"` (unclosed code fence starting at byte 14) → `richHtml` = `renderRich("See $x$ and now ")` (contains katex), `plainTail = "` + "` ` `" + `"` (the unclosed fence as plain text).
- input `"result: $$\frac{a"` (unclosed `$$` starting at byte 8) → `richHtml = renderRich("result: ")`, `plainTail = "$$\frac{a"`.
- input `"text $lonely"` (unclosed `$` at byte 5) → `richHtml = renderRich("text ")`, `plainTail = "$lonely"`.
- input `"` + "```mermaid\ngraph TD;A-->B" + `"` (half mermaid fence, no closing ` ``` `) → `richHtml = ''` (or leading paragraph text before the fence), `plainTail` contains the mermaid fence opener and graph text as plain text — no `mermaid-pending` node, no `<pre class`.
- input `"` + "```mermaid\ngraph TD;A-->B\n```" + `"` (fully closed mermaid fence) → `richHtml` contains a `data-mermaid` attribute (mermaid-pending node), `plainTail = ''`.
- input `"$x$ is inline and **bold**"` (all closed) → `richHtml` contains katex markup and `<strong>bold</strong>`, `plainTail = ''`.

---

### UnclosedRegionSafety

- **Effect**: Any unclosed code fence, isolated `$`, unclosed `$$`, or half mermaid fence in the revealed prefix is passed through as plain text and never partially rendered.
- **purpose**: Prevents broken HTML, garbled KaTeX, or phantom mermaid-pending nodes from appearing mid-stream (E2 of goal).
- **input**: `revealedPrefix: string` containing an unclosed construct.
- **output**: The unclosed region appears in `plainTail` (plain string). `richHtml` contains only the portion before the unclosed construct. The `plainTail` string does NOT contain `<pre class`, `class="katex`, or `class="mermaid-pending` — it is raw text.
- **errors**: None (this is the fail-safe path).
- **depends**: SplitRevealedForRender.

#### Test Cases

- input `"` + "```js\nconst x = 1" + `"` (unclosed code fence) → `plainTail` does not match `/<pre class/`; `plainTail` does not match `/class="katex/`; `plainTail` does not match `/mermaid-pending/`.
- input `"price is $5 per unit"` (isolated `$` with no closing `$`) → `plainTail` does not match `/class="katex/`.
- input `"` + "```mermaid\ngraph LR;X" + `"` (half mermaid fence) → `plainTail` does not match `/mermaid-pending/`; `plainTail` does not match `/<pre class/`.
- input `"formula $$\int_0^1"` (unclosed `$$`) → `plainTail` does not match `/class="katex/`.

---

### ClosedRegionMidStreamRender

- **Effect**: A markdown/LaTeX region that is fully closed in the revealed prefix renders as rich HTML before the full message has been revealed.
- **purpose**: The core user-visible value proposition — math and markup appear formatted as soon as they close, not only at end of stream (E3 of goal).
- **input**: `revealedPrefix` where a `$x$` or other closed construct appears before the streaming tail.
- **output**: `richHtml` from `splitRevealedForRender` contains KaTeX markup for the closed `$x$`; `plainTail` is the still-streaming raw tail.
- **errors**: None.
- **depends**: SplitRevealedForRender, renderRich.

#### Test Cases

- input `"The value $x$ is important and the next part is still"` (closed `$x$`, streaming tail) → `richHtml` matches `/class="katex/`; `plainTail = ' still'` (or the tail up to the next unclosed region).
- input `"**bold** and \`\`\`py\ncode"` (closed bold, unclosed fence) → `richHtml` contains `<strong>bold</strong>`; `plainTail` does not match `/<pre class/`.

---

### MermaidPendingOnClose

- **Effect**: A mermaid diagram fence emits a `mermaid-pending` marker node in `richHtml` exactly when the closing ` ``` ` enters the revealed prefix; the existing `renderMermaidPending` loop in App.svelte then picks it up and renders it to SVG.
- **purpose**: Mermaid diagrams appear as soon as the fence closes mid-stream, without changing the `renderMermaidPending` invariant (E5 of goal).
- **input**: `revealedPrefix` that ends at or after the closing ` ``` ` of a mermaid fence.
- **output**: `richHtml` contains exactly one element matching `/class="mermaid-pending"[^>]*data-mermaid=/`; `plainTail = ''` (or whatever follows the closed fence).
- **errors**: None. Half fence → no pending node (covered by UnclosedRegionSafety).
- **depends**: SplitRevealedForRender, renderRich (which already emits the mermaid-pending marker via its custom renderer).

#### States (user-facing)

- **Half fence (streaming)**: no `mermaid-pending` node in DOM; plain text tail visible.
- **Fence just closed**: `richHtml` now contains the mermaid-pending marker; `$effect` in App.svelte triggers `renderMermaidPending`; the pending node becomes SVG asynchronously.
- **SVG rendered**: mermaid-pending class removed, node replaced with SVG.

#### Test Cases

- input `"` + "```mermaid\ngraph TD;A-->B" + `"` (half fence) → `richHtml` does NOT match `/mermaid-pending/`.
- input `"` + "```mermaid\ngraph TD;A-->B\n```" + `"` (closed fence) → `richHtml` matches `/class="mermaid-pending"[^>]*data-mermaid=/`; contains exactly one such node.
- input `"prefix text\n` + "```mermaid\ngraph TD;A-->B\n```\n" + `suffix still streaming"` (closed fence with tail) → `richHtml` contains mermaid-pending node; `plainTail` contains `"suffix still streaming"`.

---

### AppSvelteBubbleTemplate

- **Effect**: The bubble template in App.svelte uses `splitRevealedForRender` during streaming and falls back to full `renderRich` on completion, producing the correct mixed or fully-rich output at each tick.
- **purpose**: Wires the new pure-function contracts into the UI render path (E4 of goal).
- **input**: Svelte reactive state — `m.text`, `revealState[i]`, `isRevealComplete(m.text, revealState[i] ?? 0)`.
- **output**: DOM shows `{@html richHtml}` (rendered prefix) + `{plainTail}` (plain suffix) during streaming; `{@html renderRich(m.text)}` after completion. The `.revealing` class remains on the bubble wrapper as long as `!isRevealComplete(...)`.
- **errors**: If `splitRevealedForRender` returns empty richHtml, only plainTail is shown (graceful degradation).
- **depends**: SplitRevealedForRender, renderRich, isRevealComplete, scrollTopToBottom.

#### States (user-facing)

- **Streaming**: bubble shows mixed HTML+plain with blinking cursor (`.revealing::after`).
- **Complete**: bubble shows fully rendered HTML, cursor gone.
- **Empty message**: bubble is empty.

#### Test Cases

- (Integration check in App.svelte template, not a pure-fn unit test): when `isRevealComplete` is false, the template branch that calls `splitRevealedForRender` is active.
- (Pure-fn unit test via avatar.js): `splitRevealedForRender(revealText(fullText, mid))` returns `{ richHtml, plainTail }` where `richHtml + plainTail === revealText(fullText, mid)` as raw text (modulo HTML encoding of the rich portion — the plain tail must round-trip exactly).

---

## Regression Invariants

The following 8 invariants are carried forward from `.spiral/gate-turn-18.sh`. The implement agent **must not break any of these**. Each is currently green; the new feature must keep them green.

### Invariant 1 — Avatar sprite switching

**What**: `stateToSrc` maps `idle|speaking|listening|thinking` to `/assets/*.png`; the four sprite PNG assets are present in `dist/assets/`; the `replyToState` emoji-to-state mapping is intact.
**Gate/test**: `bun test` (stateToSrc describe block, replyToState describe block in `frontend/src/avatar.test.js`); `gate-turn-18.sh` E6 sprite checks.
**This feature's impact**: No change to `stateToSrc`, `replyToState`, or sprite assets. Zero risk.

### Invariant 2 — frontend/dist deterministic anti-drift

**What**: `frontend/verify-dist.sh` exits 0, meaning the committed `dist/` matches a fresh `vite build` output byte-for-byte.
**Gate/test**: `gate-turn-18.sh` E5 (`bash frontend/verify-dist.sh`).
**This feature's impact**: The implement agent must rebuild `dist/` after editing `App.svelte` or `avatar.js` and commit the updated `dist/`. The verify-dist check will catch any drift.

### Invariant 3 — Reveal-aware autoscroll during streaming

**What**: `scrollTopToBottom` is called on every `setInterval` tick in `startReveal`; the `#messages` container scrolls to bottom as each grapheme is revealed. With rich rendering, bubble height may increase when a math block or heading appears — autoscroll must still fire after the DOM settles.
**Gate/test**: `bun test` (scrollTopToBottom describe block); `gate-turn-18.sh` E6 H1 check (`overflow-y:auto`, `max-height:40vh` in dist CSS). **How not to break it**: `scrollMessagesToEnd()` is called inside `setInterval` regardless of the render path. The `$effect` in App.svelte also re-runs `renderMermaidPending` after each reactive update, which may asynchronously change bubble height — the implement agent should call `scrollMessagesToEnd()` (or queue it via `Promise.resolve().then(...)`) after `renderMermaidPending` completes if height-changing renders occur.

### Invariant 4 — Grapheme-level reveal (Intl.Segmenter, no emoji/CJK cut)

**What**: `revealText` uses `Intl.Segmenter` to split by grapheme clusters; CJK characters, ZWJ sequences (e.g. `👨‍💻`), and combining diacritics are never split mid-cluster.
**Gate/test**: `bun test` (revealText grapheme tests, `E5e` ZWJ tests); `gate-turn-18.sh` E6 H2 (`Segmenter` in avatar.js).
**How not to break it**: `splitRevealedForRender` receives the already-split prefix string produced by `revealText` — it must not re-split by byte index or code-unit index. Any internal scan (for fence detection) must operate on the string content (regex or string methods), never on raw byte offsets that could cut inside a multi-byte grapheme. The split point in `splitRevealedForRender` is a **character index of a fence/delimiter boundary** in the revealed prefix, which is always on an ASCII boundary (`` ` ``, `$`, newline), so it is grapheme-safe by definition.

### Invariant 5 — In-progress visual distinguishable from complete

**What**: `.bubble.revealing::after` shows a blinking cursor (`▋`) when streaming; the `.revealing` class is absent when reveal is complete. The two states must be visually distinguishable.
**Gate/test**: `gate-turn-18.sh` E6 H3 (checks `revealing` class in App.svelte, `::after` in App.svelte, `revealing` in dist CSS).
**How not to break it**: The `.revealing` class is conditioned on `!isRevealComplete(m.text, revealState[i] ?? 0)` (App.svelte line 174). This condition must remain unchanged in the new template structure.

### Invariant 6 — renderRich pure function + XSS sanitization + streaming×rich coexistence

**What**: `renderRich` is an exported pure function; XSS vectors (onerror, script, javascript:, CSS expression) are stripped; `shouldRenderRich(true) === true`, `shouldRenderRich(false) === false`.
**Gate/test**: `bun test` renderRich describe blocks (E-MD1/E-MD2/E-XSS/E-LTX/E-COEX, E-XSS-STYLE, E-XSS-VECTORS, mermaid E1-E5); `gate-turn-18.sh` E6 behavioral probe.
**How not to break it**: `renderRich` itself is unchanged. The two `shouldRenderRich` tests (`E-COEX`) test the existing binary-gate semantics (`shouldRenderRich(true) === true`, `shouldRenderRich(false) === false`). These tests remain valid — `shouldRenderRich` is still called for the completion branch. The implement agent must **not delete** these tests. If `shouldRenderRich` is deprecated in favor of `splitRevealedForRender`, it must remain exported and passing its existing tests; it can be marked as a legacy helper in comments.

### Invariant 7 — KaTeX 9-family @font-face data:woff2 self-contained

**What**: `dist/assets/index.css` embeds all 9 KaTeX font families (`KaTeX_Main`, `KaTeX_Math`, `KaTeX_Size`, `KaTeX_AMS`, `KaTeX_Caligraphic`, `KaTeX_Fraktur`, `KaTeX_SansSerif`, `KaTeX_Script`, `KaTeX_Typewriter`) as `data:font/woff2;base64` inline `@font-face` rules. No naked font URLs.
**Gate/test**: `gate-turn-18.sh` E6 font embedding Python probe.
**How not to break it**: The Vite font-inlining plugin (`vite-plugin-katex-inline-fonts.js`) handles this at build time. As long as the build is re-run and the dist is committed, this invariant is maintained automatically.

### Invariant 8 — Embedded binary serving completeness (all /assets/* respond 200)

**What**: The Rust integration test `serve_all_assets_from_html` (in `tests/native_integration.rs`) starts the embedded server, GETs `/native`, parses all `/assets/*` references from the HTML, and asserts each returns HTTP 200. No chunk-split regressions.
**Gate/test**: `gate-turn-18.sh` E4 (`cargo test --test native_integration <smoke_test_name>`); `cargo test` full suite.
**How not to break it**: The build must remain single-chunk (`inlineDynamicImports: true` in vite config). Do not introduce dynamic imports that would cause Vite to emit additional JS chunks. The committed dist must be the single-chunk build.

---

## Risks and Tensions

### Risk: Unclosed region cannot be safely rendered mid-stream

**Tension**: The core of "rendering while streaming" is the desire to render as early as possible. But markdown parsers, KaTeX, and the mermaid renderer all expect well-formed input. Passing a half-closed code fence to `marked` produces `<pre><code>` with no closing tags; passing `$$\int_0^1` to KaTeX throws or produces broken markup; passing a partial mermaid source to the mermaid renderer produces an error node. Any of these can corrupt the DOM or trigger XSS vectors that DOMPurify then has to fight.

**Resolution (the hybrid approach)**: The split function guarantees that `renderRich` is only called on a prefix that ends before any unclosed construct. Because all unclosed-construct markers are ASCII (`` ` ``, `$`, newline), the split boundary is always on a character boundary that is also a grapheme boundary — so the grapheme-safety invariant is preserved.

**Trade-off**: The user sees slightly less rich content than a perfect incremental parser would provide (the tail from the last unclosed construct is plain text, not even partially rendered). This is the correct trade-off: safety and correctness over eagerness.

**Alternatives considered**:
1. *Every-tick full re-parse of entire `fullText` with tail discarded*: same complexity, loses the plain-text tail (user sees nothing for long unclosed regions), and wastes CPU parsing the unrevealed portion. Rejected.
2. *Incremental fence-state machine tracking grapheme by grapheme*: lower per-tick memory, but significantly higher code complexity and harder to unit-test in isolation. Not suitable for this iteration.
3. *Maintain current behavior (render only on reveal complete)*: zero risk, zero new value. The explicit goal of this feature is to move away from this. Rejected.

---

## Implementation Plan

### Test Runners

- **TEST_RUNNER**: `cd frontend && bun test` (JavaScript pure-function suite) followed by `cargo test` (Rust integration suite, includes embedded-server smoke test).
- **SHARD_TEST_RUNNER**: `cd frontend && bun test src/avatar.test.js` (hermetic, no live services, no ports).

### Step 1: Add `splitRevealedForRender` to `frontend/src/avatar.js` — fulfills SplitRevealedForRender, UnclosedRegionSafety, ClosedRegionMidStreamRender, MermaidPendingOnClose

- **target**: `frontend/src/avatar.js`
- **approach**: Add a new exported pure function `splitRevealedForRender(revealedPrefix)` after the `shouldRenderRich` function (currently ending at line 333). The function:
  1. Scans `revealedPrefix` for unclosed code fences (counting ` ``` ` delimiters), unclosed `$$`, and unclosed inline `$`. Uses regex or linear scan — must not cut inside a grapheme (all fence markers are ASCII, so safe).
  2. Finds the minimum start index of any unclosed construct.
  3. Calls `renderRich(prefix)` on the safe prefix and returns `{ richHtml, plainTail }`.
  4. On any exception, returns `{ richHtml: '', plainTail: revealedPrefix }` (fail-safe).
- **order**: Must be done before Step 2 (App.svelte depends on it).

### Step 2: Update bubble template in `frontend/src/App.svelte` — fulfills AppSvelteBubbleTemplate

- **target**: `frontend/src/App.svelte`
- **approach**: Import `splitRevealedForRender` from `./avatar.js` (line 4 import statement). Replace the current bubble block (lines 175–180):
  ```
  {#if shouldRenderRich(isRevealComplete(m.text, revealState[i] ?? 0))}
    {@html renderRich(m.text)}
  {:else}
    {revealText(m.text, revealState[i] ?? 0)}
  {/if}
  ```
  With a new block that:
  - When `isRevealComplete(...)` is true: `{@html renderRich(m.text)}` (unchanged — full render on completion).
  - When streaming: destructure `splitRevealedForRender(revealText(m.text, revealState[i] ?? 0))` and render `{@html richHtml}{plainTail}`.
  Keep `shouldRenderRich` imported and its two existing tests passing (do not remove the export).
  Keep `.revealing` class condition unchanged (line 174).
  After `renderMermaidPending`, call `scrollMessagesToEnd()` if height may have changed (or rely on the `$effect` re-run which already defers to `Promise.resolve().then(renderMermaidPending)`).
- **order**: After Step 1.

### Step 3: Add unit tests for `splitRevealedForRender` in `frontend/src/avatar.test.js` — fulfills all contracts

- **target**: `frontend/src/avatar.test.js`
- **approach**: Add a `describe('splitRevealedForRender', ...)` block (both bun and node paths) with test cases covering: fully closed → richHtml non-empty, plainTail empty; unclosed code fence → richHtml is prefix before fence, plainTail contains fence opener, no `<pre class` in plainTail; isolated `$` → plainTail contains `$`, no `class="katex` in plainTail; half mermaid fence → no `mermaid-pending` in richHtml, no `<pre class` in plainTail; closed mermaid fence → richHtml contains `data-mermaid`, plainTail empty; closed `$x$` with streaming tail → richHtml contains katex, plainTail is the tail.
- **order**: Can be done in parallel with Step 2; requires Step 1 to be complete.

### Step 4: Rebuild dist and verify — fulfills Invariant 2, 7, 8

- **target**: `frontend/dist/` (rebuild artifact, then commit)
- **approach**: Run `cd frontend && bun run build` (or the equivalent Vite build command per `package.json`). Verify with `bash frontend/verify-dist.sh`. Commit the updated dist.
- **order**: After Steps 1 and 2 (source must be final before rebuilding dist).

---

## Completed

- Streaming reveal mechanism (grapheme tick, `startReveal`, `revealText`, `isRevealComplete`) fully read and characterized — contracts trace directly to existing code. [confidence: high]
- renderRich pipeline (marked + KaTeX + DOMPurify + mermaid-pending) fully read — `splitRevealedForRender` can call it on a sub-string safely. [confidence: high]
- Current decision switch (`shouldRenderRich(isRevealComplete(...))`) identified at App.svelte lines 176–179 and avatar.js lines 331–333 — these are the precise change points. [confidence: high]
- 8 regression invariants traced to specific gate checks in `gate-turn-18.sh` — each has a named test or probe that must remain green. [confidence: high]

---

## Unresolved

### U1 — One-way door: should `splitRevealedForRender` be a permanent exported API?

- **Why unresolved**: Exporting the function makes it a first-class contract of avatar.js, committing future streaming-render features to its `{ richHtml, plainTail }` signature. Keeping it unexported makes the split an implementation detail of App.svelte but removes direct unit-test coverage.
- **Suggested resolution**: Export it (consistent with all other avatar.js pure functions, enables clean unit tests). If the signature changes in a future turn, it is a refactor, not a data migration. However, because this shapes the test surface and the API every subsequent streaming-render turn will build upon, a human should confirm before cf implements.
- **Alternatives**:
  - Export (recommended): clean testability, visible contract, minimal extra coupling.
  - Keep private: hides the function, forces App.svelte integration tests for split logic, harder to isolate bugs.

### U2 — Autoscroll timing after async mermaid render

- **Why unresolved**: When a mermaid diagram appears mid-stream (fence closes, pending node created, `renderMermaidPending` runs asynchronously), the bubble height increases after the `$effect` resolves. The current `scrollMessagesToEnd()` inside `setInterval` fires before the async SVG render settles. Whether the user observes a scroll-lag is environment-dependent.
- **Suggested resolution**: After `renderMermaidPending` resolves (inside the async function), call `scrollMessagesToEnd()` once more. This is a one-line change in App.svelte's `renderMermaidPending` function. Low risk, low effort — implement agent may decide.
