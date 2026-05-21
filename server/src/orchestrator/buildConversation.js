// Constructs the conversation array passed to AgentRunner.runTurn for a given
// round. The conversation is from the perspective of the CURRENT agent:
//   - The agent's own previous turns appear as 'assistant' messages.
//   - The opponent's previous turns appear as 'user' messages, prefixed with
//     context so the agent knows which round and side it came from.
//   - The final user message is the instruction for the current round,
//     appended onto the last opponent turn's content where possible.
//
// See /context/DEBATE_FORMAT.md for the canonical rules.

/**
 * @typedef {Object} PreviousTurn
 * @property {number} roundNumber
 * @property {string} roundName
 * @property {'aff'|'neg'} side
 * @property {string} content
 */

/**
 * @typedef {Object} RoundDef
 * @property {number} number
 * @property {string} name
 * @property {'aff'|'neg'} side
 * @property {number} wordLimit
 */

/**
 * @param {object} params
 * @param {Array<PreviousTurn>} params.previousTurns - turns from rounds 1..(N-1), in order
 * @param {RoundDef} params.currentRound
 * @param {'aff'|'neg'} params.currentSide
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 */
export function buildConversation({ previousTurns, currentRound, currentSide }) {
  if (currentSide !== 'aff' && currentSide !== 'neg') {
    throw new Error(`buildConversation: currentSide must be 'aff' or 'neg' (got ${currentSide})`);
  }
  if (!currentRound || typeof currentRound.number !== 'number') {
    throw new Error('buildConversation: currentRound must be a round definition object');
  }

  const conversation = [];
  let pendingOpponentBlock = null; // accumulates the most recent opponent turn for instruction merging

  const flushPendingOpponent = () => {
    if (pendingOpponentBlock) {
      conversation.push({ role: 'user', content: pendingOpponentBlock });
      pendingOpponentBlock = null;
    }
  };

  for (const turn of previousTurns) {
    if (turn.side === currentSide) {
      // Our own previous turn — assistant role, no prefix.
      flushPendingOpponent();
      conversation.push({ role: 'assistant', content: turn.content });
    } else {
      // Opponent's turn — user role, with round/side prefix.
      flushPendingOpponent();
      const opponentSideUpper = turn.side === 'aff' ? 'AFFIRMATIVE' : 'NEGATIVE';
      pendingOpponentBlock = `OPPONENT [Round ${turn.roundNumber} — ${opponentSideUpper} ${turn.roundName.toUpperCase()}]:\n\n${turn.content}`;
    }
  }

  // Build the instruction for the current round.
  const sideUpper = currentSide === 'aff' ? 'AFFIRMATIVE' : 'NEGATIVE';
  const instruction =
    `It is now your turn for Round ${currentRound.number}: ${currentRound.name}. ` +
    `Argue ${sideUpper}. Word limit: ${currentRound.wordLimit} words. ` +
    `Begin your response now — no preamble, no headers, just the body of your turn.`;

  // If the last turn was the opponent's, append the instruction to its message.
  // Otherwise (round 1, or after our own previous turn), the instruction stands alone.
  if (pendingOpponentBlock) {
    conversation.push({
      role: 'user',
      content: `${pendingOpponentBlock}\n\n---\n\n${instruction}`,
    });
  } else {
    conversation.push({ role: 'user', content: instruction });
  }

  return conversation;
}
