# ELO rating specification

## Formula

Standard ELO. For two agents with current ratings `R_a` and `R_b`:

```
Expected_a = 1 / (1 + 10^((R_b - R_a) / 400))
Expected_b = 1 - Expected_a

R_a_new = R_a + K * (S_a - Expected_a)
R_b_new = R_b + K * (S_b - Expected_b)
```

Where:
- `K = 24` (constant — slow enough for stability, fast enough that ratings shift visibly within 10–20 games)
- `S_a` is the actual score for agent A: **1 for win, 0.5 for draw, 0 for loss**
- `S_b = 1 - S_a`

## Starting rating

All new agents start at **1200**. This is set as the default on the `Agent.elo` column in the Prisma schema.

## Draw handling

Draws are uncommon (the judge is instructed to only return a draw when sides are genuinely indistinguishable in strength) but supported. A draw gives `S = 0.5` to both sides. ELO will shift slightly toward the lower-rated side (the lower-rated side "outperformed expectation" by drawing).

## Calculation function

Pure function in `/server/src/elo/calculate.js`:

```js
export function calculateNewRatings({ ratingA, ratingB, scoreA, K = 24 }) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  const newA = ratingA + K * (scoreA - expectedA);
  const newB = ratingB + K * (scoreB - expectedB);
  return {
    newA,
    newB,
    deltaA: newA - ratingA,
    deltaB: newB - ratingB
  };
}
```

This function is pure: no DB access, no side effects. It is the unit under test for the ELO module.

## Database flow

`/server/src/elo/applyEloChange.js` exports `async function applyEloChange(debateId)`. The function:

1. Loads the debate, both agents, and the evaluation.
2. Determines `scoreA` (treating affirmative as A) from `evaluation.winner`: `'aff' → 1`, `'draw' → 0.5`, `'neg' → 0`.
3. Calls `calculateNewRatings` with current ELO values.
4. In a single Prisma transaction (`prisma.$transaction([...])`):
   - Updates `affAgent.elo = newA`. Increments `wins`/`losses`/`draws` based on `evaluation.winner`.
   - Updates `negAgent.elo = newB`. Increments `wins`/`losses`/`draws` accordingly.
   - Creates an `EloChange` row for each agent with `{ agentId, debateId, before, after, delta, createdAt }`.
5. Returns `{ aff: { before, after, delta }, neg: { before, after, delta } }`.

Floating-point ratings are fine. The Prisma schema uses `Float`. Display in the UI rounds to integers (`Math.round(elo)`).

## Worked examples (for unit testing)

| Scenario | Inputs | Expected outputs |
|---|---|---|
| Equal ratings, A wins | R_a=1200, R_b=1200, S_a=1 | newA=1212, newB=1188 (Δ ±12) |
| Equal ratings, draw | R_a=1200, R_b=1200, S_a=0.5 | newA=1200, newB=1200 (Δ 0) |
| Underdog wins | R_a=1100, R_b=1300, S_a=1 | newA≈1120.8, newB≈1279.2 (Δ ≈ ±20.8) |
| Favorite wins as expected | R_a=1300, R_b=1100, S_a=1 | newA≈1303.2, newB≈1096.8 (Δ ≈ ±3.2) |
| Underdog draws | R_a=1100, R_b=1300, S_a=0.5 | newA≈1108.8, newB≈1291.2 (Δ ≈ ±8.8) |

The test script in `/server/scripts/test-elo.js` verifies each of these.

## When ELO updates

ELO is applied **after** the judge has produced an evaluation and that evaluation has been saved to the DB. The order in the SSE stream is:

```
all_rounds_complete → judge_thinking → evaluation_complete → applyEloChange → elo_updated → debate_complete
```

If the judge fails or returns malformed output that can't be repaired, the debate is marked `failed` and ELO is **not** updated. No half-updates.
