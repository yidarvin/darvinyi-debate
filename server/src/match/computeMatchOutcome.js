// Computes the agent-level outcome of a two-leg match from its two
// per-leg judge evaluations.
//
// Rule: agent A's match total = leg1.affTotal + leg2.negTotal
//       agent B's match total = leg1.negTotal + leg2.affTotal
//       higher total wins; equal → draw.
//
// Per-leg human votes do NOT affect this calculation. Human votes record
// agreement only; the judge's scores are what determine the outcome.

/**
 * @param {object} params
 * @param {object} params.eval1 - leg 1 evaluation (A=aff, B=neg)
 * @param {object} params.eval2 - leg 2 evaluation (A=neg, B=aff)
 * @returns {{ winner: 'A'|'B'|'draw', aTotal: number, bTotal: number, leg1Winner: string, leg2Winner: string }}
 */
export function computeMatchOutcome({ eval1, eval2 }) {
  if (!eval1 || !eval2) {
    throw new Error('computeMatchOutcome: both leg evaluations required');
  }

  const aTotal = (eval1.affTotal ?? 0) + (eval2.negTotal ?? 0);
  const bTotal = (eval1.negTotal ?? 0) + (eval2.affTotal ?? 0);

  let winner;
  if (aTotal > bTotal) winner = 'A';
  else if (bTotal > aTotal) winner = 'B';
  else winner = 'draw';

  return {
    winner,
    aTotal,
    bTotal,
    leg1Winner: eval1.winner,
    leg2Winner: eval2.winner,
  };
}
