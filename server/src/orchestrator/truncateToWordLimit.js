// Hard-truncate an agent's turn to a fixed word count. The judge sees only
// the truncated version, so this is what's stored on DebateTurn.content and
// emitted on round_complete.
//
// Words are whitespace-delimited tokens. Truncation preserves the original
// inter-word whitespace by walking the source string and counting word starts.

/**
 * @param {string} text
 * @param {number} wordLimit
 * @returns {{ content: string, originalWordCount: number, truncated: boolean }}
 */
export function truncateToWordLimit(text, wordLimit) {
  if (typeof text !== 'string') {
    return { content: '', originalWordCount: 0, truncated: false };
  }
  if (!Number.isInteger(wordLimit) || wordLimit < 1) {
    throw new Error(`truncateToWordLimit: wordLimit must be a positive integer (got ${wordLimit})`);
  }

  const originalWordCount = countWords(text);
  if (originalWordCount <= wordLimit) {
    return { content: text, originalWordCount, truncated: false };
  }

  let wordsSeen = 0;
  let inWord = false;
  let cutIndex = text.length;

  for (let i = 0; i < text.length; i++) {
    const isWs = isWhitespace(text[i]);
    if (!isWs && !inWord) {
      wordsSeen++;
      if (wordsSeen > wordLimit) {
        cutIndex = i;
        break;
      }
      inWord = true;
    } else if (isWs) {
      inWord = false;
    }
  }

  const truncated = text.slice(0, cutIndex).trimEnd();
  return { content: truncated, originalWordCount, truncated: true };
}

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
