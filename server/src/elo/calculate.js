// Pure ELO rating calculator.
//
// Standard formula:
//   expectedA = 1 / (1 + 10^((Rb - Ra) / 400))
//   newA = Ra + K * (Sa - expectedA)
//   newB = Rb + K * (Sb - expectedB)   where Sb = 1 - Sa
//
// Sa: 1 = A wins, 0.5 = draw, 0 = A loses.
// K = 24 (project default — see /context/ELO_SPEC.md).
//
// Pure function. No DB. No side effects. Unit-testable in isolation.

const ALLOWED_SCORES = new Set([0, 0.5, 1]);

/**
 * @param {object} params
 * @param {number} params.ratingA - current ELO of side A
 * @param {number} params.ratingB - current ELO of side B
 * @param {number} params.scoreA  - 1 if A wins, 0.5 if draw, 0 if B wins
 * @param {number} [params.K=24]  - K-factor
 * @returns {{ newA: number, newB: number, deltaA: number, deltaB: number, expectedA: number, expectedB: number }}
 */
export function calculateNewRatings({ ratingA, ratingB, scoreA, K = 24 }) {
  if (typeof ratingA !== 'number' || !Number.isFinite(ratingA)) {
    throw new TypeError(`calculateNewRatings: ratingA must be a finite number (got ${ratingA})`);
  }
  if (typeof ratingB !== 'number' || !Number.isFinite(ratingB)) {
    throw new TypeError(`calculateNewRatings: ratingB must be a finite number (got ${ratingB})`);
  }
  if (typeof K !== 'number' || !Number.isFinite(K) || K <= 0) {
    throw new TypeError(`calculateNewRatings: K must be a positive finite number (got ${K})`);
  }
  if (!ALLOWED_SCORES.has(scoreA)) {
    throw new RangeError(`calculateNewRatings: scoreA must be 0, 0.5, or 1 (got ${scoreA})`);
  }

  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;

  const newA = ratingA + K * (scoreA - expectedA);
  const newB = ratingB + K * (scoreB - expectedB);

  return {
    newA,
    newB,
    deltaA: newA - ratingA,
    deltaB: newB - ratingB,
    expectedA,
    expectedB,
  };
}
