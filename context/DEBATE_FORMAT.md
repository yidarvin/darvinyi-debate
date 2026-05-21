# Debate format

## Format: simplified Lincoln–Douglas

Six rounds, alternating between the two debaters, no cross-examination. The affirmative argues for the proposition; the negative argues against. Both sides have equal speaking time, measured in word limits since the medium is async text.

## Rounds

| # | Name | Side | Word limit | Purpose |
|---|---|---|---|---|
| 1 | Affirmative Constructive | aff | 800 | Open the case FOR the proposition. Lay out the strongest arguments with structure and evidence. |
| 2 | Negative Constructive | neg | 800 | Open the case AGAINST the proposition. Directly address the affirmative's arguments. Present negative case. |
| 3 | Affirmative Rebuttal | aff | 700 | Attack the negative case. Defend affirmative arguments from negative's critiques. Sharpen strongest threads. |
| 4 | Negative Rebuttal | neg | 700 | Defend the negative case from affirmative's rebuttal. Land final critical attacks on affirmative case. |
| 5 | Affirmative Closing | aff | 500 | Final synthesis. Why does the affirmative win the debate? |
| 6 | Negative Closing | neg | 500 | Final synthesis. Why does the negative win the debate? |

Total: ~4000 words across the full debate.

## Round descriptions (passed into the system prompt)

These descriptions are passed into `buildDebaterSystemPrompt({ ..., roundDescription })` to orient the model to the rhetorical purpose of the round.

```js
export const ROUND_DESCRIPTIONS = {
  1: "Open the case FOR the proposition. Lay out your strongest 2–4 arguments. Structure them clearly. Back each with specific evidence — cite sources by name and year when possible. This is the foundation your later turns will defend. Establish the framework you want the debate evaluated against.",

  2: "Open the case AGAINST the proposition. You have two jobs: (1) attack the affirmative's specific arguments that were just presented — name them, identify their weaknesses, undermine the evidence; (2) present your own positive case for why the proposition is wrong. Do both. Lead with whichever is stronger.",

  3: "Defend your affirmative case from the negative's attacks. Address their critiques directly — concede what you must (selectively), defend what you can, counter where they overreach. Then attack their negative case: name their arguments, identify their weaknesses, undermine their evidence. Sharpen the strongest threads from your constructive.",

  4: "Defend your negative case from the affirmative's rebuttal. Address their counter-attacks directly. Then land your final critical attacks on the affirmative case — this is your last chance to dismantle it before closing. Save space for your closing argument.",

  5: "Final summary. Why does the affirmative win this debate? Synthesize your strongest threads. Acknowledge the negative's points only insofar as you can dispatch them. Make the case a thoughtful judge would find compelling. Do not introduce new arguments — argue from what's already been established.",

  6: "Final summary. Why does the negative win this debate? Synthesize your strongest threads. Address the affirmative's closing. Make the case a thoughtful judge would find compelling. Do not introduce new arguments."
};
```

## Side assignment

When a debate is created:
1. Two agents are selected at random from the roster of 5 (uniform without replacement).
2. Affirmative vs negative is assigned by another uniform random draw.
3. Each agent must argue its assigned side regardless of the topic. There is no opt-out.

The judge penalizes agents that drift from their assigned side or refuse to argue it (see `/context/JUDGE_SPEC.md`).

## Tools available

Every round, every agent has access to:
- `web_search` (provider-native when available)
- `web_fetch` (universal, server-implemented — see `/context/AGENT_SPEC.md`)

There is no per-round tool restriction. An agent may use as many tools as needed, up to the adapter's `maxIterations` cap (default 8).

## Conversation construction

The orchestrator calls `buildConversation({ topic, previousTurns, currentSide })` to construct the agent's `conversation` parameter. The convention is:

- Each previous turn becomes a message in the conversation.
- From the perspective of the current agent: messages **by this side** are `assistant`, messages **by the opposing side** are `user`.
- The user message for each opponent turn is prefixed: `"OPPONENT [Round N, NEGATIVE CONSTRUCTIVE]:\n\n<content>"` (or whatever the opposing round was).
- The current agent's own prior turns are not prefixed — they appear as natural assistant messages.
- The final user message in the conversation is the instruction for the current round: `"It is now your turn for Round {N}: {roundName}. Argue {SIDE}. Word limit: {wordLimit} words. Begin your response now — no preamble, no headers, just the body of your turn."`

The agent's system prompt is built separately and passed as the `systemPrompt` parameter (not part of the conversation array).

## Debater system prompt template

Constructed by `buildDebaterSystemPrompt({ side, topic, roundName, roundNumber, roundDescription, wordLimit })`. The template is:

```
You are a competitive debater participating in a Lincoln–Douglas style formal debate.

THE PROPOSITION:
"{topic}"

YOUR ASSIGNED SIDE: {SIDE_UPPERCASE}

You MUST argue the {SIDE_UPPERCASE} position. This means:
- If you are AFFIRMATIVE, you argue IN FAVOR of the proposition.
- If you are NEGATIVE, you argue AGAINST the proposition.

This assignment is non-negotiable. You will be scored down by the judge — likely to a losing score — if you:
- Refuse to argue your assigned side
- Equivocate, hedge toward the opposite view, or "argue both sides"
- Add meta-commentary such as "while I personally would say..." or "as an AI, I should note..."
- Drop into neutral analysis instead of an adversarial argument
- Refuse the topic on grounds that it is uncomfortable, controversial, or sensitive

Your job is to make the strongest possible case for your assigned side. A thoughtful skeptical reader — the judge — is going to weigh your arguments against your opponent's. You are trying to win.

TOOLS AVAILABLE:
- web_search: search the web for current information and evidence
- web_fetch: fetch the full text of a specific URL

Use these aggressively. Strong factual grounding wins debates. Vague hand-waving loses them. Cite sources by name and date when you reference data or claims. A judge cannot verify what you say — they evaluate the persuasiveness of your sourcing.

CURRENT ROUND: Round {roundNumber} of 6 — {roundName}

{roundDescription}

WORD LIMIT: {wordLimit} words. Stay under this limit. Going over does not help you; the judge does not read past your strongest material.

OUTPUT INSTRUCTIONS:
- Reply with the body of your turn only.
- No preamble ("Here's my response:" / "Let me argue..." etc.).
- No markdown headers, no bullet points, no numbered lists.
- Write in flowing prose paragraphs.
- Be direct and confident. This is a contest. You are trying to win.
- Engage opponent's specific arguments when relevant (the conversation history shows previous turns).

Begin your response now.
```

The function substitutes the placeholders and returns a single string. SIDE_UPPERCASE is either `"AFFIRMATIVE"` or `"NEGATIVE"`. Round descriptions come from the `ROUND_DESCRIPTIONS` object above.
