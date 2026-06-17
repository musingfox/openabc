# Rendering While Streaming — Implementation Handoff Plan

> Target consumer: `/context-flow:cf` implement agent.
> This document is a planning artifact, not production code.
> Do NOT modify any frontend or backend source in this turn.

---

## cf Baton Mode Positioning

This document is a `docs/handoff-*.md` handoff doc. The `/context-flow:cf` baton mode (see
`commands/cf.md:28-43`) recognizes `docs/handoff-*.md` files as self-contained planning handoffs:
in its plan phase, cf reads this file and **derives** a `contracts.json` sidecar from the
Behavioral Contracts here. The upstream spiral turn does not need to hand-write that sidecar —
cf derives it from this authoritative source. The contracts live here, in this handoff doc, as
the single source of truth; the sidecar is a derived artifact, not hand-written by the upstream.

---

## Investigated

- `frontend/src/avatar.js` — pure functions: `revealText`, `isRevealComplete`, `renderRich`,
  `shouldRenderRich`, `scrollTopToBottom`; the streaming/rich coexistence switch lives here.
- `frontend/src/App.svelte` — bubble template (line 176–179), `startReveal`,
  `renderMermaidPending`, `$effect` re-render hook, `revealing` CSS class; the per-tick render
  decision lives here.
- `frontend/src/avatar.test.js` — full existing test suite; `shouldRenderRich` tests at lines
  286–291 (bun path) and 637–642 (node path); these are the tests that must be updated or superseded.
- `.spiral/gate-turn-18.sh` — full regression gate; the 8 invariants below are derived from its
  checks.
- `.spiral/gate-turn-19.sh` — the document-shape gate this plan must satisfy.
- `.spiral/gate-turn-20.sh` — the current gate this revision must satisfy.

### renderRich tokenization pipeline (avatar.js lines 155–322)

The `renderRich` function tokenizes math before passing to `marked`. The **scan priority is
display `$$` before inline `$`** (precedence guaranteed by the order of replacements):

1. **Line 161** — display math: `/\$\$([\s\S]+?)\$\$/g` — replaces `$$...$$` first.
2. **Line 169** — inline math: `/\$([^$\n]+?)\$/g` — replaces `$...$` after display math is
   consumed. Inline `$` semantics: content must be non-empty and must not contain a newline.
3. **Lines 179–217** — `marked` custom renderer intercepts `mermaid` code fences; all other code
   blocks (including fences that contain `$`) render as `<pre><code>`.

**Critical priority rule**: code fence state is checked by `marked` at step 3, *after* the math
replacements. However, the spec for `splitRevealedForRender` must reflect the actual scanning
priority: **fence state takes precedence over math detection** — i.e., inside a closed code fence,
`$` must not trigger math tokenization. The shared tokenizer approach (see E-SHARED-TOKENIZER in
Decisions) enforces this.

---

## Assumptions

- `renderRich` remains a pure, synchronous function with no browser-DOM dependency — all new
  helpers can follow the same pattern and be tested with `bun test`. Affects:
  SplitRevealedForRender contract.
- `Intl.Segmenter` remains the grapheme-split mechanism in `revealText`; the new helper receives
  the already-split prefix string (not the raw `full` + `charsShown`), so grapheme integrity is
  guaranteed upstream. Affects: Grapheme Safety contract.
- `isomorphic-dompurify` is a singleton in the module; the mermaid hook registration/de-registration
  pattern already in `renderRich` is safe to call on a partial prefix. Affects:
  SplitRevealedForRender contract.
- The `mermaid.initialize` call and the `renderMermaidPending` / `$effect` loop in App.svelte
  remain structurally unchanged; only the input HTML that feeds them changes (prefix HTML may now
  include mermaid-pending nodes before full reveal). Affects: MermaidPendingOnClose contract.

---

## Decisions

### D1: Hybrid prefix/suffix split replaces binary reveal-gate

- **Impact**: Medium
- **Choice**: Replace the `shouldRenderRich(isRevealComplete(...))` binary gate with a call to a
  new helper `splitRevealedForRender(revealedPrefix)` that splits the already-revealed text into a
  safe-to-render prefix and a plain-text suffix, then renders the prefix with the existing
  `renderRich` pipeline.
- **Trade-off**: Gains incremental rich display during streaming; mermaid diagrams and math
  equations appear as soon as their fence/delimiter closes, not only after the full message arrives.
  Gives up the simplicity of the current binary gate. The per-tick cost of running `renderRich` on
  a partial string is higher than the current guard — mitigation is that `renderRich` is already
  O(n) and the prefix grows incrementally. Performance tuning (debounce, memoize last rendered
  prefix) is a two-way door left to later iterations.
- **Alternatives considered**: Full re-parse of the entire `fullText` on every tick and discarding
  the tail — same complexity, worse DX because the tail is not available as plain text; rejected.
  Incremental fence-state machine tracking grapheme by grapheme — lower per-tick cost, but
  significantly more complex and harder to test in isolation; rejected for this iteration.
- **Rationale**: Re-using the existing `renderRich` pipeline on the safe prefix requires zero
  changes to the rendering logic itself; the only new surface is the split function.

### D2: Every tick re-run split+renderRich on the revealed prefix (two-way door — default chosen)

- **Impact**: Medium
- **Choice**: On every `setInterval` tick in `startReveal`, compute
  `splitRevealedForRender(revealText(m.text, charsShown))` and use the result directly in the
  bubble template. No caching across ticks.
- **Trade-off**: Simplest implementation; the existing pipeline is already called once per message
  on completion, now called once per tick. At 30 ms intervals and typical message lengths (< 10 KB)
  this is acceptable.
- **Alternatives considered**: Debounced render; memoizing last rendered prefix — deferred.
- **Rationale**: Matches the "minimum viable" operating model.

### D3: splitRevealedForRender is a new exported pure function in avatar.js

- **Impact**: Medium
- **Choice**: Export `splitRevealedForRender` from `avatar.js` as a named export.
- **Trade-off**: Exporting enables direct `bun test` coverage. Once exported and consumed by
  App.svelte, the function signature becomes a two-party contract. However, this decision is
  reversible in a later refactor: the function can be made private again if the API changes, or
  inlined into App.svelte, without data-migration cost.
- **Alternatives considered**: Keep module-private — harder to write deterministic unit tests;
  rejected for this iteration.
- **Rationale**: Consistent with existing avatar.js pattern (all pure functions are exported and
  unit-tested directly). Because the planning phase can reverse this export decision at low cost
  (no persisted schema, no outward network contract), this is a two-way door treated as a
  sane default. A later refactor can revisit it without structural disruption.

### D4: E-SHARED-TOKENIZER — splitRevealedForRender reuses renderRich tokenization semantics

- **Impact**: High (correctness)
- **Choice**: The `splitRevealedForRender` scan logic must not introduce a parallel, independent
  set of `$` / fence matching rules. Instead it must **reuse the tokenization semantics of
  `renderRich`** — either by extracting a shared tokenizer function that both `renderRich` and
  `splitRevealedForRender` call, or by having `splitRevealedForRender` perform a dry-run through
  the existing pipeline to determine a fail-safe split boundary. **Default: extract a shared
  tokenizer** (two-way door — either approach is acceptable; the loop corrects it if needed).
- **Tokenization rules that the shared tokenizer must embody** (derived from avatar.js):
  - **Scan precedence**: display `$$` has priority over inline `$` (avatar.js line 161 runs
    before line 169). A `$$` match consumes both `$` characters, preventing false inline matches.
  - **Inline `$` semantics**: the content between `$...$` must be non-empty and must not contain a
    newline — matching the regex `/\$([^$\n]+?)\$/g` (avatar.js line 169). The match is greedy:
    for `$5 and $10`, the first `$` is paired with the second `$` (content: `5 and `, which is
    non-empty and contains no newline), leaving `10` as a non-delimiter suffix — the whole string
    is closed from the tokenizer's perspective.
  - **Fence state priority over math**: content inside a code fence is **not scanned for math or
    mermaid**; the fence-open/fence-close state takes priority. A `$` or `$$` inside a balanced
    ` ``` ` fence does not trigger math tokenization.
  - **Mermaid fences** are a code fence variant (lang=mermaid); handled identically by the fence
    state machine; the mermaid-pending node is emitted only after the closing ` ``` ` enters the
    prefix.
- **Rationale**: A parallel $/fence matching rule in `splitRevealedForRender` diverges silently
  from `renderRich` and is the root cause of the correctness defects (E-DEFECT1 through
  E-DEFECT3). A single shared tokenizer is the only way to guarantee the two agree.

---

## Behavioral Contracts

### SplitRevealedForRender

- **Effect**: Given the already-revealed text prefix, the bubble renders any fully-closed
  markdown/LaTeX/mermaid regions as rich HTML while leaving any unclosed region as plain text
  appended after the HTML.
- **purpose**: Enables incremental rich display during streaming (E1, E3 of goal).
- **input**: `revealedPrefix: string` — the result of `revealText(m.text, charsShown)`, i.e. the
  grapheme-safe prefix of the full message text currently visible.
- **output**: `{ richHtml: string, plainTail: string }` — `richHtml` is the sanitized HTML of the
  safe-to-render prefix (may be empty string), `plainTail` is the unsafe remainder as plain text
  (may be empty string). Concatenating `richHtml` (as rendered text) and `plainTail` (as raw text)
  allows the original `revealedPrefix` string to be reconstructed / recovered — the plainTail must
  round-trip exactly, and the rich portion must be the original chars rendered as HTML.
- **errors**: Never throws. If split detection is ambiguous, the entire `revealedPrefix` is
  returned as `plainTail` with empty `richHtml` (fail-safe to plain text).
- **depends**: `renderRich` (for the prefix HTML), `revealText` / `isRevealComplete` upstream in
  App.svelte.

#### Prefix/suffix split rule

The split point is the char-index / grapheme-index of the **start of the last unclosed special
region** in `revealedPrefix`. All internal scanning must use char-index or grapheme-granularity
(via `Intl.Segmenter` if needed) — char-index only, no raw-octet addressing. Because
fence and math delimiters are ASCII characters (`` ` ``, `$`, newline), any char-index split
boundary is always on a grapheme boundary, so grapheme safety is preserved automatically.

"Special region" means:

1. **Code fence**: an opening ` ``` ` (optionally with a language tag) that has no matching closing
   ` ``` ` later in the prefix.
2. **Display math** (`$$`): opening `$$` that has no matching closing `$$`. Priority: display `$$`
   is matched before inline `$` — this mirrors `renderRich` line 161 running before line 169.
3. **Inline math** (`$`): an opening `$` (not followed immediately by another `$`) that has no
   matching closing `$` on the same line (content must be non-empty and newline-free, matching
   `/\$([^$\n]+?)\$/g`).
4. **Mermaid fence**: a code fence with language `mermaid` — handled identically to rule 1; the
   mermaid-pending node is only emitted after the closing ` ``` ` enters the prefix.

**Fence state takes priority**: when inside an open code fence, rules 2 and 3 are suspended — `$`
characters inside the fence do not trigger inline or display math detection.

#### Linear tokenizer (single left-to-right scan)

The split point is found by a **single left-to-right scan** (O(n)) through `revealedPrefix`
using a shared tokenizer that mirrors `renderRich`'s exact tokenization rules. There is no
repeated re-parsing, no iterative prefix-lengthening, and no separate parallel rule set.

##### Tokenizer pseudo-code

// Inline $ rule: greedy left-to-right match; content must be non-empty and no newline
// (mirrors /\$([^$\n]+?)\$/g — [^$\n] means non-empty, no-newline constraint)
```
function findSplitPoint(text):
  i = 0
  fenceOpen = false          // true while inside a balanced ``` fence
  unclosedStart = null       // char-index of first still-open delimiter

  while i < text.length:
    // 1. Fence detection — highest priority; suspends math detection inside
    if text[i..i+3] == "```":
      if fenceOpen:
        fenceOpen = false    // close fence; the fence construct is now balanced
        if unclosedStart == fenceOpenIdx:
          unclosedStart = null
      else:
        fenceOpen = true
        fenceOpenIdx = i
        if unclosedStart == null: unclosedStart = i
      i += 3; continue

    // 2. Inside fence: skip math detection entirely
    if fenceOpen:
      i += 1; continue

    // 3. Display math $$ — matched before inline $ (same priority as renderRich line 161)
    if text[i..i+2] == "$$":
      j = text.indexOf("$$", i+2)
      if j != -1:            // closed pair — both delimiters consumed, skip past
        i = j + 2; continue
      else:                  // unclosed $$
        if unclosedStart == null: unclosedStart = i
        i += 2; continue

    // 4. Inline $ — non-empty, no newline content; matches renderRich line 169
    //    Semantics: greedy match of /\$([^$\n]+?)\$/ — find next $ on same line
    //    that is preceded by at least one non-$, non-newline character.
    if text[i] == "$" and text[i+1] != "$":
      j = findNextInlineDollar(text, i+1)   // next $ on same line, non-empty content
      if j != -1:            // closed pair — greedy match consumed both; skip past
        i = j + 1; continue
      else:                  // unclosed $
        if unclosedStart == null: unclosedStart = i
        i += 1; continue

    i += 1

  return unclosedStart ?? text.length   // text.length means no unclosed construct
```

**Greedy inline `$` semantics** (step 4): `findNextInlineDollar(text, from)` finds the
**next `$` at or after `from` that (a) does not follow immediately from another `$` and
(b) is on the same line** — matching `[^$\n]+?` (non-empty, no newline). The match is
greedy: the first eligible closing `$` is taken. Content that spans across intermediate `$`
characters (like `$5 and $10`) is consumed as a single matched pair (`$5 and $` closes on
the second `$`), leaving whatever follows as a non-delimiter suffix.

**Mermaid fences** are a code fence variant (lang=mermaid); they are handled by the fence
state machine in step 1 — the **same as any other code fence** (identical behavior to rule 1).
The mermaid-pending node is emitted only after the closing ` ``` ` enters the prefix.

Once the scan returns `splitPoint`:

1. `prefix = revealedPrefix.slice(0, splitPoint)`, `suffix = revealedPrefix.slice(splitPoint)`.
2. If no construct is open (`splitPoint === text.length`), `prefix = revealedPrefix`, `suffix = ''`.
3. Call `renderRich(prefix)` → `richHtml`; return `{ richHtml, plainTail: suffix }`.

**Correctness condition / invariant**: `richHtml === renderRich(prefix)` — the HTML returned
is identical to calling `renderRich` directly on the safe prefix. This is an invariant, not an
algorithm step: it is the property that makes `splitRevealedForRender` correct.

#### States (user-facing)

- **Streaming / in-progress**: bubble shows `{@html richHtml}` (rich HTML of closed regions)
  followed immediately by `{plainTail}` (plain text of unclosed tail); the `.revealing::after`
  cursor still applies to the bubble wrapper.
- **Reveal complete**: `isRevealComplete` is still called to detect completion; on completion,
  `splitRevealedForRender` is called with the full text → split point is at end (no unclosed
  regions in a complete message) → `richHtml = renderRich(fullText)`, `plainTail = ''` — same
  visual result as current behavior.
- **Empty prefix** (charsShown = 0): `richHtml = ''`, `plainTail = ''` — empty bubble (same as
  today).

#### Test Cases

- input `"Hello **world**"` (fully closed, no special region) → `richHtml` contains
  `<strong>world</strong>`, `plainTail = ''`.
- input `"See $x$ and now \`\`\`"` (unclosed code fence) → `richHtml` = `renderRich("See $x$ and
  now ")` (contains katex), `plainTail` = the unclosed fence as plain text.
- input `"result: $$\frac{a"` (unclosed `$$`) → `richHtml = renderRich("result: ")`,
  `plainTail = "$$\frac{a"`.
- input `"text $lonely"` (unclosed `$` at char-index 5) → `richHtml = renderRich("text ")`,
  `plainTail = "$lonely"`.
- input `"` + "```mermaid\ngraph TD;A-->B" + `"` (half mermaid fence, no closing ` ``` `) →
  `richHtml = ''` (or leading paragraph text before the fence), `plainTail` contains the mermaid
  fence opener and graph text as plain text — no `mermaid-pending` node, no `<pre class`.
- input `"` + "```mermaid\ngraph TD;A-->B\n```" + `"` (fully closed mermaid fence) → `richHtml`
  contains a `data-mermaid` attribute (mermaid-pending node), `plainTail = ''`.
- input `"$x$ is inline and **bold**"` (all closed) → `richHtml` contains katex markup and
  `<strong>bold</strong>`, `plainTail = ''`.

##### Greedy simulation test cases and parity comparison

The following two cases illustrate how the greedy tokenizer processes `$` delimiters. A naive
**parity** (odd/even `$`-count) approach would count raw `$` occurrences and declare the
string open if the count is odd — but **parity does not account for the non-empty and
no-newline constraints of inline `$`**. The real distinguishing cases are inputs where a `$`
is immediately followed by a newline (e.g. `$x\n$y`) or where two adjacent `$` form an empty
span (`$$` treated as display, not two separate inline delimiters) — in those situations parity
gives the wrong answer while the greedy simulation gives the correct one.

The two cases below (`a $x$ b $y` and `$5 and $10`) happen to agree between parity and greedy
simulation in pure inline context, so they **cannot on their own distinguish** greedy from
parity. They are included to demonstrate the greedy pairing order; the cross-line and
empty-content cases are the true discriminators.

**Case 1** — input literal `a $x$ b $y`:

- Display pass: no `$$` → unchanged.
- Inline pass (`/\$([^$\n]+?)\$/g`): greedy matches `$x$` as the first pair (content `x`,
  non-empty, no newline). After consuming `$x$`, the remaining text is `a I b $y`.
- `$y` has no closing `$` on the same line → unclosed. Split point falls at the start of `$y`.
- `plainTail` contains `$y`; `richHtml = renderRich("a $x$ b ")` (katex for `x`).

**Case 2** — input literal `$5 and $10`:

- Display pass: no `$$` → unchanged.
- Inline pass: greedy matches `$5 and $` as a pair (content `5 and `, non-empty, no newline,
  no intermediate `$`). After consuming, `10` remains with no leading `$`.
- No unclosed delimiter → split point = end. `plainTail` is empty; the entire string is
  closed from the tokenizer's perspective. `richHtml` contains katex for `5 and ` (greedy
  false-positive, faithfully replicated).

**Why parity misleads** — the key reason to prefer greedy simulation over parity (just counting
`$` odd/even): inline `$` requires **non-empty content** (`[^$\n]+?`, at least one char) and
**no newline** (`[^\n]`). A parity check counts `$` without these constraints. For example,
input `$x\n$y` has two `$` (parity says even → closed), but the greedy scan finds no valid
closing `$` for the first one (newline in between) → first `$` is unclosed → split there.
Similarly, `$$` at the start of a line triggers display math detection (two `$` = display
delimiter), not two independent inline delimiters, so counting them as two for parity
purposes gives the wrong pairing. The shared tokenizer's greedy simulation is the only
approach that faithfully replicates `renderRich`'s actual behaviour.

**Boundary case — `$$$x$$`** (faithful-mirror regression):

- input literal `"$$$x$$"`.
- Display pass (pseudocode step 3, the indexOf search starting at i+2): at position 0,
  text[0..2]=="$$", so search for closing `$$` starting at index 2; finds `$$` at index 4 →
  closed display pair, content `$x` (chars 2–3), `i` advances to 6, loop ends.
- `renderRich` display regex likewise matches `$$…$$` greedily at the start, yielding the same
  closed display block with content `$x`.
- Both methods agree: closed display construct, no unclosed delimiter, `plainTail` is empty,
  `richHtml === renderRich("$$$x$$")`.
- This confirms the faithful-mirror invariant holds at the `$$$` boundary (three consecutive
  dollar signs): the pseudocode `indexOf` and `renderRich`'s own regex produce identical
  tokenization, so `splitRevealedForRender` cannot diverge here.

##### E-DEFECT1 test case: greedy inline `$` produces katex for price-like text

- input literal `"I paid $5 and $10"` — the inline `$` regex `/\$([^$\n]+?)\$/g` greedily
  matches `$5 and $` as a pair (content: `5 and `), so `renderRich` produces katex for this
  input. This is a known greedy false-positive in the current pipeline.
- Expected (faithful to renderRich): `richHtml` **contains** `class="katex` — because
  `splitRevealedForRender` must faithfully replicate `renderRich` output; the trailing `10`
  is emitted as plain text after the katex span. `plainTail` is empty (the entire string is a
  closed construct from renderRich's perspective).
- Purpose: `splitRevealedForRender` must not diverge from `renderRich`; it must replicate
  `renderRich` exactly, including greedy false-positives. A split function that suppresses the
  katex output for this input would silently diverge from `renderRich`'s tokenization.

##### E-DEFECT2 test case: closed code fence containing `$` renders as `<pre>`, not math

- input: a string with a closed triple-backtick code fence containing `cost is $5`, e.g.:
  ` ```\ncost is $5\n``` `
- Expected: `richHtml` renders the fence as a `<pre>` code block; the `$` inside the fence does
  NOT trigger math tokenization; `plainTail = ''` (the fence is closed, nothing in the tail).
- Assertion: `richHtml` matches `/<pre/`; `richHtml` does NOT contain `class="katex`; `plainTail`
  is empty.

##### E-DEFECT3 test case: `$$a$$` and `$b` — display match first, `$b` is plain tail

- input literal `"$$a$$ and $b"` — the `$$a$$` is a valid display math pair; the trailing `$b`
  is an unclosed inline `$`.
- Expected: `richHtml` contains display-mode katex (rendered `$$a$$`); `plainTail === "$b"`.
- This test case validates the **display `$$` priority over inline `$`** rule: the `$$` is matched
  first (leaving `" and "` as safe closed text), and the unclosed `$b` falls into `plainTail`.

##### E-DEFECT4 test case: ZWJ emoji adjacent to `$` — grapheme boundary integrity

- input literal `"👨‍💻$x"` — a man-technologist ZWJ sequence (`👨‍💻`, U+1F468 U+200D U+1F4BB)
  directly adjacent to an unclosed `$x`. The ZWJ sequence is a multi-codepoint grapheme cluster;
  the `$` is an ASCII delimiter.
- Expected: the split point falls on the ASCII `$` character, not inside the ZWJ sequence;
  `plainTail` does not contain U+FFFD (replacement character `�`) — i.e. the ZWJ sequence
  is not corrupted by the split. The ZWJ emoji appears intact in `richHtml` (rendered as the
  leading paragraph text); `plainTail` contains `"$x"` (unclosed inline `$`).
- This validates the char-index / grapheme granularity invariant: the split boundary is always
  on an ASCII character, which is by definition a grapheme boundary, so no replacement character
  (U+FFFD) can appear in `plainTail` and no ZWJ sequence is split mid-cluster.

---

### UnclosedRegionSafety

- **Effect**: Any unclosed code fence, isolated `$`, unclosed `$$`, or half mermaid fence in the
  revealed prefix is passed through as plain text and never partially rendered.
- **purpose**: Prevents broken HTML, garbled KaTeX, or phantom mermaid-pending nodes from
  appearing mid-stream (E2 of goal).
- **input**: `revealedPrefix: string` containing an unclosed construct.
- **output**: The unclosed region appears in `plainTail` (plain string). `richHtml` contains only
  the portion before the unclosed construct. The `plainTail` string does NOT contain
  `<pre class`, `class="katex`, or `class="mermaid-pending` — it is raw text.
- **errors**: None (this is the fail-safe path).
- **depends**: SplitRevealedForRender.

#### Test Cases

- input `"` + "```js\nconst x = 1" + `"` (unclosed code fence) → `plainTail` does not match
  `/<pre class/`; `plainTail` does not match `/class="katex/`; `plainTail` does not match
  `/mermaid-pending/`.
- input `"price is $5 per unit"` (isolated `$` with no closing `$`) → `plainTail` does not match
  `/class="katex/`.
- input `"` + "```mermaid\ngraph LR;X" + `"` (half mermaid fence) → `plainTail` does not match
  `/mermaid-pending/`; `plainTail` does not match `/<pre class/`.
- input `"formula $$\int_0^1"` (unclosed `$$`) → `plainTail` does not match `/class="katex/`.

---

### ClosedRegionMidStreamRender

- **Effect**: A markdown/LaTeX region that is fully closed in the revealed prefix renders as rich
  HTML before the full message has been revealed.
- **purpose**: The core user-visible value proposition — math and markup appear formatted as soon
  as they close, not only at end of stream (E3 of goal).
- **input**: `revealedPrefix` where a `$x$` or other closed construct appears before the streaming
  tail.
- **output**: `richHtml` from `splitRevealedForRender` contains KaTeX markup for the closed `$x$`;
  `plainTail` is the still-streaming raw tail.
- **errors**: None.
- **depends**: SplitRevealedForRender, renderRich.

#### Test Cases

- input `"The value $x$ is important and the next part is still"` (closed `$x$`, streaming tail)
  → `richHtml` matches `/class="katex/`; `plainTail = ' still'` (or the tail up to the next
  unclosed region).
- input `"**bold** and \`\`\`py\ncode"` (closed bold, unclosed fence) → `richHtml` contains
  `<strong>bold</strong>`; `plainTail` does not match `/<pre class/`.

---

### MermaidPendingOnClose

- **Effect**: A mermaid diagram fence emits a `mermaid-pending` marker node in `richHtml` exactly
  when the closing ` ``` ` enters the revealed prefix; the existing `renderMermaidPending` loop in
  App.svelte then picks it up and renders it to SVG.
- **purpose**: Mermaid diagrams appear as soon as the fence closes mid-stream, without changing
  the `renderMermaidPending` invariant (E5 of goal).
- **input**: `revealedPrefix` that ends at or after the closing ` ``` ` of a mermaid fence.
- **output**: `richHtml` contains exactly one element matching
  `/class="mermaid-pending"[^>]*data-mermaid=/`; `plainTail = ''` (or whatever follows the closed
  fence).
- **errors**: None. Half fence → no pending node (covered by UnclosedRegionSafety).
- **depends**: SplitRevealedForRender, renderRich (which already emits the mermaid-pending marker
  via its custom renderer).

#### States (user-facing)

- **Half fence (streaming)**: no `mermaid-pending` node in DOM; plain text tail visible.
- **Fence just closed**: `richHtml` now contains the mermaid-pending marker; `$effect` in
  App.svelte triggers `renderMermaidPending`; the pending node becomes SVG asynchronously.
- **SVG rendered**: mermaid-pending class removed, node replaced with SVG.
- **Autoscroll after mermaid SVG render**: when a mermaid diagram renders asynchronously, bubble
  height increases after `$effect` resolves. The current `scrollMessagesToEnd()` inside
  `setInterval` fires before the async SVG settles. **This timing gap is listed as a manual
  acceptance item** — see U2 in Unresolved. This is not a pure-function gate-testable behavior;
  it requires manual verification or an integration assertion after cf implements.

#### Test Cases

- input `"` + "```mermaid\ngraph TD;A-->B" + `"` (half fence) → `richHtml` does NOT match
  `/mermaid-pending/`.
- input `"` + "```mermaid\ngraph TD;A-->B\n```" + `"` (closed fence) → `richHtml` matches
  `/class="mermaid-pending"[^>]*data-mermaid=/`; contains exactly one such node.
- input `"prefix text\n` + "```mermaid\ngraph TD;A-->B\n```\n" + `suffix still streaming"` (closed
  fence with tail) → `richHtml` contains mermaid-pending node; `plainTail` contains
  `"suffix still streaming"`.

---

### AppSvelteBubbleTemplate

- **Effect**: The bubble template in App.svelte uses `splitRevealedForRender` during streaming and
  falls back to full `renderRich` on completion, producing the correct mixed or fully-rich output
  at each tick.
- **purpose**: Wires the new pure-function contracts into the UI render path (E4 of goal).
- **input**: Svelte reactive state — `m.text`, `revealState[i]`,
  `isRevealComplete(m.text, revealState[i] ?? 0)`.
- **output**: DOM shows `{@html richHtml}` (rendered prefix) + `{plainTail}` (plain suffix) during
  streaming; `{@html renderRich(m.text)}` after completion. The `.revealing` class remains on the
  bubble wrapper as long as `!isRevealComplete(...)`.
- **errors**: If `splitRevealedForRender` returns empty richHtml, only plainTail is shown
  (graceful degradation).
- **depends**: SplitRevealedForRender, renderRich, isRevealComplete, scrollTopToBottom.

#### States (user-facing)

- **Streaming**: bubble shows mixed HTML+plain with blinking cursor (`.revealing::after`).
- **Complete**: bubble shows fully rendered HTML, cursor gone.
- **Empty message**: bubble is empty.

#### Test Cases

- (Integration check in App.svelte template, not a pure-fn unit test): when `isRevealComplete` is
  false, the template branch that calls `splitRevealedForRender` is active.
- (Pure-fn unit test via avatar.js): `splitRevealedForRender(revealText(fullText, mid))` returns
  `{ richHtml, plainTail }` where `richHtml + plainTail` allows recovery of the original
  `revealText(fullText, mid)` string — the `plainTail` must reconstruct exactly, and the rich
  portion must be the original chars rendered as HTML.

---

## E1–E8 Traceability

The Behavioral Contracts in this document correspond to the goals tracked in the gate system.
Below is the traceability map (E1–E8 labels ↔ contract names):

| Label | Contract / Goal                                         |
|-------|---------------------------------------------------------|
| E1    | SplitRevealedForRender — incremental rich display       |
| E2    | UnclosedRegionSafety — no broken partial render         |
| E3    | ClosedRegionMidStreamRender — mid-stream rich emit      |
| E4    | AppSvelteBubbleTemplate — template wiring               |
| E5    | MermaidPendingOnClose — mermaid appears on fence close  |
| E6    | Regression Invariants 1–8 (see below)                   |
| E7    | D4 / E-SHARED-TOKENIZER — tokenizer correctness         |
| E8    | GraphemeSafety / E-DEFECT4 — CJK / char-index integrity |

---

## Regression Invariants

The following 8 invariants are carried forward from `.spiral/gate-turn-18.sh`. The implement agent
**must not break any of these**. Each is currently green; the new feature must keep them green.

### Invariant 1 — Avatar sprite switching

**What**: `stateToSrc` maps `idle|speaking|listening|thinking` to `/assets/*.png`; the four sprite
PNG assets are present in `dist/assets/`; the `replyToState` emoji-to-state mapping is intact.
**Gate/test**: `bun test` (stateToSrc describe block, replyToState describe block in
`frontend/src/avatar.test.js`); `gate-turn-18.sh` E6 sprite checks.
**This feature's impact**: No change to `stateToSrc`, `replyToState`, or sprite assets. Zero risk.

### Invariant 2 — frontend/dist deterministic anti-drift

**What**: `frontend/verify-dist.sh` exits 0, meaning the committed `dist/` matches a fresh
`vite build` output byte-for-byte.
**Gate/test**: `gate-turn-18.sh` E5 (`bash frontend/verify-dist.sh`).
**This feature's impact**: The implement agent must rebuild `dist/` after editing `App.svelte` or
`avatar.js` and commit the updated `dist/`. The verify-dist check will catch any drift.

### Invariant 3 — Reveal-aware autoscroll during streaming

**What**: `scrollTopToBottom` is called on every `setInterval` tick in `startReveal`; the
`#messages` container scrolls to bottom as each grapheme is revealed. With rich rendering, bubble
height may increase when a math block or heading appears — autoscroll must still fire after the
DOM settles.
**Gate/test**: `bun test` (scrollTopToBottom describe block); `gate-turn-18.sh` E6 H1 check
(`overflow-y:auto`, `max-height:40vh` in dist CSS). **How not to break it**: `scrollMessagesToEnd()`
is called inside `setInterval` regardless of the render path. The `$effect` in App.svelte also
re-runs `renderMermaidPending` after each reactive update, which may asynchronously change bubble
height — the implement agent should call `scrollMessagesToEnd()` (or queue it via
`Promise.resolve().then(...)`) after `renderMermaidPending` completes if height-changing renders
occur.

### Invariant 4 — Grapheme-level reveal (Intl.Segmenter, no emoji/CJK cut)

**What**: `revealText` uses `Intl.Segmenter` to split by grapheme clusters; CJK characters, ZWJ
sequences (e.g. `👨‍💻`), and combining diacritics are never split mid-cluster.
**Gate/test**: `bun test` (revealText grapheme tests, `E5e` ZWJ tests); `gate-turn-18.sh` E6 H2
(`Segmenter` in avatar.js).
**How not to break it**: `splitRevealedForRender` receives the already-split prefix string
produced by `revealText` — it must operate on char-index / grapheme-granularity positions, and
must operate purely on char-index / grapheme positions to determine the split point. Any
internal scan (for fence detection) must operate on the string content (regex or string methods)
using character indices. The split boundary in `splitRevealedForRender` is always on an ASCII
character (`` ` ``, `$`, newline), which is by definition also a grapheme boundary — so grapheme
safety is preserved, and no replacement character (U+FFFD) can appear in `plainTail`.

### Invariant 5 — In-progress visual distinguishable from complete

**What**: `.bubble.revealing::after` shows a blinking cursor (`▋`) when streaming; the `.revealing`
class is absent when reveal is complete. The two states must be visually distinguishable.
**Gate/test**: `gate-turn-18.sh` E6 H3 (checks `revealing` class in App.svelte, `::after` in
App.svelte, `revealing` in dist CSS).
**How not to break it**: The `.revealing` class is conditioned on
`!isRevealComplete(m.text, revealState[i] ?? 0)` (App.svelte line 174). This condition must remain
unchanged in the new template structure.

### Invariant 6 — renderRich pure function + XSS sanitization + streaming×rich coexistence

**What**: `renderRich` is an exported pure function; XSS vectors (onerror, script, javascript:,
CSS expression) are stripped; `shouldRenderRich(true) === true`, `shouldRenderRich(false) === false`.
**Gate/test**: `bun test` renderRich describe blocks (E-MD1/E-MD2/E-XSS/E-LTX/E-COEX,
E-XSS-STYLE, E-XSS-VECTORS, mermaid E1-E5); `gate-turn-18.sh` E6 behavioral probe.
**How not to break it**: `renderRich` itself is unchanged. The two `shouldRenderRich` tests
(`E-COEX`) test the existing binary-gate semantics. These tests remain valid — `shouldRenderRich`
is still called for the completion branch. The implement agent must **not delete** these tests. If
`shouldRenderRich` is deprecated in favor of `splitRevealedForRender`, it must remain exported and
passing its existing tests; it can be marked as a legacy helper in comments.

### Invariant 7 — KaTeX 9-family @font-face data:woff2 self-contained

**What**: `dist/assets/index.css` embeds all 9 KaTeX font families (`KaTeX_Main`, `KaTeX_Math`,
`KaTeX_Size`, `KaTeX_AMS`, `KaTeX_Caligraphic`, `KaTeX_Fraktur`, `KaTeX_SansSerif`,
`KaTeX_Script`, `KaTeX_Typewriter`) as `data:font/woff2;base64` inline `@font-face` rules. No
naked font URLs.
**Gate/test**: `gate-turn-18.sh` E6 font embedding Python probe.
**How not to break it**: The Vite font-inlining plugin (`vite-plugin-katex-inline-fonts.js`)
handles this at build time. As long as the build is re-run and the dist is committed, this
invariant is maintained automatically.

### Invariant 8 — Embedded binary serving completeness (all /assets/* respond 200)

**What**: The Rust integration test `serve_all_assets_from_html` (in `tests/native_integration.rs`)
starts the embedded server, GETs `/native`, parses all `/assets/*` references from the HTML, and
asserts each returns HTTP 200. No chunk-split regressions.
**Gate/test**: `gate-turn-18.sh` E4 (`cargo test --test native_integration <smoke_test_name>`);
`cargo test` full suite.
**How not to break it**: The build must remain single-chunk (`inlineDynamicImports: true` in vite
config). Do not introduce dynamic imports that would cause Vite to emit additional JS chunks. The
committed dist must be the single-chunk build.

---

## Risks and Tensions

### Risk: Unclosed region cannot be safely rendered mid-stream

**Tension**: The core of "rendering while streaming" is the desire to render as early as possible.
But markdown parsers, KaTeX, and the mermaid renderer all expect well-formed input. Passing a
half-closed code fence to `marked` produces `<pre><code>` with no closing tags; passing
`$$\int_0^1` to KaTeX throws or produces broken markup; passing a partial mermaid source to the
mermaid renderer produces an error node.

**Resolution (the hybrid approach)**: The split function guarantees that `renderRich` is only
called on a prefix that ends before any unclosed construct. Because all unclosed-construct markers
are ASCII (`` ` ``, `$`, newline), the split boundary is always on a character boundary that is
also a grapheme boundary — so the grapheme-safety invariant is preserved.

**Trade-off**: The user sees slightly less rich content than a perfect incremental parser would
provide (the tail from the last unclosed construct is plain text, not even partially rendered).
This is the correct trade-off: safety and correctness over eagerness.

---

## Implementation Plan

### Test Runners

- **TEST_RUNNER**: `cd frontend && bun test` (JavaScript pure-function suite) followed by
  `cargo test` (Rust integration suite, includes embedded-server smoke test).
- **SHARD_TEST_RUNNER**: `cd frontend && bun test src/avatar.test.js` (hermetic, no live services,
  no ports).

### Step 1: Add `splitRevealedForRender` to `frontend/src/avatar.js` — fulfills SplitRevealedForRender, UnclosedRegionSafety, ClosedRegionMidStreamRender, MermaidPendingOnClose

- **target**: `frontend/src/avatar.js`
- **approach**: Add a new exported pure function `splitRevealedForRender(revealedPrefix)` after
  the `shouldRenderRich` function (currently ending at line 333). The function:
  1. Scans `revealedPrefix` for unclosed code fences, unclosed `$$`, and unclosed inline `$`
     using the same tokenization semantics as `renderRich` (see D4 / E-SHARED-TOKENIZER) — a
     shared tokenizer extracted from or aligned with the `renderRich` pipeline. Scanning uses
     char-index positions (string `.slice()`, regex match indices) — char-index only.
  2. Fence state takes priority: math delimiters inside a balanced fence are ignored.
  3. Scan priority: display `$$` before inline `$` (matching `renderRich` pipeline order).
  4. Finds the first unclosed construct start.
  5. Calls `renderRich(prefix)` on the safe prefix and returns `{ richHtml, plainTail }`.
  6. On any exception, returns `{ richHtml: '', plainTail: revealedPrefix }` (fail-safe).
- **order**: Must be done before Step 2 (App.svelte depends on it).

### Step 2: Update bubble template in `frontend/src/App.svelte` — fulfills AppSvelteBubbleTemplate

- **target**: `frontend/src/App.svelte`
- **approach**: Import `splitRevealedForRender` from `./avatar.js` (line 4 import statement).
  Replace the current bubble block (lines 175–180):
  ```
  {#if shouldRenderRich(isRevealComplete(m.text, revealState[i] ?? 0))}
    {@html renderRich(m.text)}
  {:else}
    {revealText(m.text, revealState[i] ?? 0)}
  {/if}
  ```
  With a new block that:
  - When `isRevealComplete(...)` is true: `{@html renderRich(m.text)}` (unchanged — full render on
    completion).
  - When streaming: destructure `splitRevealedForRender(revealText(m.text, revealState[i] ?? 0))`
    and render `{@html richHtml}{plainTail}`.
  Keep `shouldRenderRich` imported and its two existing tests passing (do not remove the export).
  Keep `.revealing` class condition unchanged (line 174).
  After `renderMermaidPending`, call `scrollMessagesToEnd()` if height may have changed (or rely
  on the `$effect` re-run which already defers to `Promise.resolve().then(renderMermaidPending)`).
- **order**: After Step 1.

### Step 3: Add unit tests for `splitRevealedForRender` in `frontend/src/avatar.test.js` — fulfills all contracts

- **target**: `frontend/src/avatar.test.js`
- **approach**: Add a `describe('splitRevealedForRender', ...)` block (both bun and node paths)
  with test cases covering:
  - fully closed → richHtml non-empty, plainTail empty
  - unclosed code fence → richHtml is prefix before fence, plainTail contains fence opener, no
    `<pre class` in plainTail
  - isolated `$` (`$5 and $10`) → determined by shared tokenizer (see E-DEFECT1)
  - `cost is $5` inside closed fence → richHtml has `<pre`, no katex (E-DEFECT2)
  - `$$a$$ and $b` → display katex in richHtml, `plainTail === "$b"` (E-DEFECT3)
  - `價格 $5 未閉合` (CJK) → no U+FFFD replacement characters in plainTail (E-DEFECT4)
  - half mermaid fence → no `mermaid-pending` in richHtml, no `<pre class` in plainTail
  - closed mermaid fence → richHtml contains `data-mermaid`, plainTail empty
  - closed `$x$` with streaming tail → richHtml contains katex, plainTail is the tail
- **order**: Can be done in parallel with Step 2; requires Step 1 to be complete.

### Step 4: Rebuild dist and verify — fulfills Invariant 2, 7, 8

- **target**: `frontend/dist/` (rebuild artifact, then commit)
- **approach**: Run `cd frontend && bun run build` (or the equivalent Vite build command per
  `package.json`). Verify with `bash frontend/verify-dist.sh`. Commit the updated dist.
- **order**: After Steps 1 and 2 (source must be final before rebuilding dist).

---

## Completed

- Streaming reveal mechanism (grapheme tick, `startReveal`, `revealText`, `isRevealComplete`) fully
  read and characterized — contracts trace directly to existing code. [confidence: high]
- renderRich pipeline (marked + KaTeX + DOMPurify + mermaid-pending) fully read — `splitRevealedForRender`
  can call it on a sub-string safely. [confidence: high]
- Current decision switch (`shouldRenderRich(isRevealComplete(...))`) identified at App.svelte
  lines 176–179 and avatar.js lines 331–333 — these are the precise change points. [confidence: high]
- 8 regression invariants traced to specific gate checks in `gate-turn-18.sh` — each has a named
  test or probe that must remain green. [confidence: high]
- renderRich tokenization priority confirmed: display `$$` (avatar.js line 161) before inline `$`
  (line 169); fence handling via marked custom renderer (lines 179–217). [confidence: high]

---

## Unresolved

### U1 — Export decision for `splitRevealedForRender` — resolved by D3

**Status**: resolved by D3 (two-way door, sane default chosen).

- **Resolution**: Export `splitRevealedForRender` as a named export from `avatar.js`. This is
  consistent with all other avatar.js pure functions and enables direct `bun test` coverage.
  As D3 notes, the export decision is reversible at low cost (no persisted schema, no outward
  network contract) — a later refactor can make it private or inline it into App.svelte without
  structural disruption. No further confirmation needed before cf implements.
- **Alternatives**:
  - Export (default, chosen by D3): clean testability, visible contract, minimal extra coupling.
  - Keep private: hides the function, forces App.svelte integration tests for split logic, harder
    to isolate bugs.

### U2 — Autoscroll timing after async mermaid render (manual acceptance required)

- **Why unresolved**: When a mermaid diagram appears mid-stream (fence closes, pending node
  created, `renderMermaidPending` runs asynchronously), the bubble height increases after the
  `$effect` resolves. The current `scrollMessagesToEnd()` inside `setInterval` fires before the
  async SVG render settles. Whether the user observes a scroll-lag is environment-dependent.
- **Manual acceptance**: This is a non-pure-function behavior that cannot be reliably asserted by
  a unit gate. **After cf implements, this must be manually verified** (manual acceptance item):
  start a streaming message containing a mermaid fence, observe that the view scrolls to bottom
  after the SVG renders. Alternatively, after cf implements, an integration assertion can be added
  to cover this timing gap.
- **Suggested resolution**: After `renderMermaidPending` resolves (inside the async function),
  call `scrollMessagesToEnd()` once more. This is a one-line change in App.svelte's
  `renderMermaidPending` function. Low risk, low effort — implement agent may decide.
