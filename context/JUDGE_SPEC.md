# Judge specification

## Judge model

**Claude Opus 4.7** (`modelId: claude-opus-4-7`), always. Including when Opus is one of the debaters.

The judge does NOT see agent identities, so self-bias is structurally bounded — the judge only sees `AFFIRMATIVE` and `NEGATIVE` labels and the text of each turn. There is no metadata leak. (See "Anonymization" below.)

## Anonymization rules

The judge prompt MUST contain:
- The proposition (topic)
- The six turn contents, labeled only by side and round number/name

The judge prompt MUST NOT contain:
- Any agent's `id` (`claude-opus-4-7`, `gpt-5`, etc.)
- Any agent's `displayName` (`Claude Opus 4.7`, `GPT-5`, etc.)
- Any provider name (`anthropic`, `openai`, `google`, `xai`)
- Any model ID
- Tool call metadata (the raw text of the turn is sufficient — tool calls are visible in the surrounding event stream for users but not surfaced to the judge as separate metadata)
- Token counts, durations, or any other telemetry
- The debate ID (which encodes nothing identifying but is unnecessary)

If you find yourself adding ANY of the above to the judge prompt, stop. The anonymization is the only thing standing between this project and self-bias collapse.

## Judge prompt template

Constructed by a helper `buildJudgePrompt({ topic, turns })` where `turns` is an array of 6 saved `DebateTurn` rows ordered by `roundNumber`. The template is:

```
You are a senior debate judge with extensive experience evaluating formal Lincoln–Douglas debates.

You will evaluate the debate below. The two debaters are anonymous to you. You see them only as AFFIRMATIVE and NEGATIVE. Do not speculate about their identities. Do not let writing style, vocabulary, or stylistic tells push you toward guesses about who they are. Judge only the arguments.

THE PROPOSITION:
"{topic}"

────────────────────────────────────────
ROUND 1 — AFFIRMATIVE CONSTRUCTIVE
────────────────────────────────────────

{content of turn 1}

────────────────────────────────────────
ROUND 2 — NEGATIVE CONSTRUCTIVE
────────────────────────────────────────

{content of turn 2}

────────────────────────────────────────
ROUND 3 — AFFIRMATIVE REBUTTAL
────────────────────────────────────────

{content of turn 3}

────────────────────────────────────────
ROUND 4 — NEGATIVE REBUTTAL
────────────────────────────────────────

{content of turn 4}

────────────────────────────────────────
ROUND 5 — AFFIRMATIVE CLOSING
────────────────────────────────────────

{content of turn 5}

────────────────────────────────────────
ROUND 6 — NEGATIVE CLOSING
────────────────────────────────────────

{content of turn 6}

────────────────────────────────────────
YOUR EVALUATION TASK
────────────────────────────────────────

Score each side on FOUR axes. Each axis is scored 0.0 to 10.0, in increments of 0.5. The four axes are:

1. ARGUMENT QUALITY — internal coherence, logical structure, depth of analysis. Are the arguments well-formed? Do they build on each other? Is there real substance, or just assertion?

2. EVIDENCE — quality, specificity, and relevance of evidence cited. Specific named sources with dates and figures score higher than vague references. Penalize uncited bold factual claims. Penalize misuse of evidence (e.g. citing a study to support a claim the study doesn't actually make, if you can identify this).

3. RESPONSIVENESS — does each side directly engage opponent's specific arguments, or talk past them? Naming opponent's claims and addressing them earns points. Repeating one's own talking points without engagement loses them.

4. PERSUASION — would a thoughtful, well-informed, skeptical reader find this side compelling? This is the holistic axis. Strong on the other three but unpersuasive overall? Score this lower.

PENALTIES (deduct from PERSUASION):
- Substantial drift from the assigned side: -2.0
- Outright refusal to argue the assigned side: -4.0
- Meta-commentary breaking the debate frame ("As an AI..."): -1.5
- Partial drift that the side recovered from: -1.0
- Hedging that undermines own case: -1.0

DECLARE A WINNER:
- "aff" if affirmative's case is stronger on balance
- "neg" if negative's case is stronger on balance
- "draw" only if the two cases are GENUINELY indistinguishable in strength (this should be rare)

WRITE A REASONING SECTION:
3 to 5 paragraphs, in plain prose (NO bullets, NO numbered lists, NO markdown headers). Walk through each of the four axes. Be specific about which arguments worked or didn't. Discuss any drift from assigned position. Explain why the winner won and why the loser lost.

────────────────────────────────────────
OUTPUT FORMAT
────────────────────────────────────────

Reply with ONLY a single JSON object. No markdown fences, no explanatory text outside the JSON, no greeting. The exact schema:

{
  "winner": "aff" | "neg" | "draw",
  "aff_scores": {
    "argument": <number 0.0–10.0>,
    "evidence": <number 0.0–10.0>,
    "responsiveness": <number 0.0–10.0>,
    "persuasion": <number 0.0–10.0>
  },
  "neg_scores": {
    "argument": <number 0.0–10.0>,
    "evidence": <number 0.0–10.0>,
    "responsiveness": <number 0.0–10.0>,
    "persuasion": <number 0.0–10.0>
  },
  "reasoning": "<3–5 paragraphs of plain prose>"
}

Begin your evaluation now.
```

## Output handling

The judge response is parsed as JSON. Implementation in `/server/src/judge/judgeDebate.js`:

1. Strip whitespace from the response.
2. If the response begins with ```` ```json ```` or ```` ``` ````, strip the fences. Belt and suspenders against the model wrapping JSON in markdown despite instructions.
3. `JSON.parse()`.
4. Validate the parsed object:
   - `winner` is one of `'aff'`, `'neg'`, `'draw'`
   - `aff_scores` and `neg_scores` each have all four required fields
   - All scores are numbers in `[0, 10]` — clamp out-of-range values to the bounds with a warning logged
   - `reasoning` is a non-empty string of at least 200 characters (if shorter, retry)
5. Compute totals: `affTotal = sum of aff_scores values`, same for neg.
6. Save to the `Evaluation` table with all individual scores, totals, reasoning, judgeModel, and the FK to the debate.
7. Update the parent `Debate` row: `winner`, `completedAt = now`, `status = 'completed'`.

## Retry on malformed output

If the initial response cannot be parsed as JSON (or fails validation):

- Make ONE retry: append a user message `"Your previous response could not be parsed as JSON. Please reply with ONLY the JSON object matching the schema, with no surrounding text or markdown fences."` and call the model again.
- If the retry also fails: mark the debate `status = 'failed'` with `errorMessage = 'Judge produced unparseable output after retry.'`. Do NOT apply ELO. Do NOT crash the SSE stream — emit an `error` event and close cleanly.

## Streaming the judge output

The judge response is streamed to the SSE channel as `judge_text_delta` events as the model produces tokens. The full final response is parsed once streaming completes. The frontend may render the streaming reasoning live (under a "judge is thinking..." indicator), then replace it with the parsed structured evaluation once `evaluation_complete` fires.

## What the judge does NOT do

- Does not see agent identities (anonymization rules above)
- Does not have access to web_search or web_fetch (no tools — pure evaluation)
- Does not score on any axes beyond the four specified
- Does not apply ELO changes (that's a separate module)
- Does not modify or rewrite debater content — read-only evaluation
