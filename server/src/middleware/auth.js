// requireKeyphrase: middleware that gates a route behind the X-Debate-Key header.
//
// The expected keyphrase is read from process.env.DEBATE_KEYPHRASE.
// Comparison is constant-time via SHA-256 hashing (both sides hashed to 32-byte
// buffers, then crypto.timingSafeEqual). Hashing first sidesteps the
// requirement that timingSafeEqual's inputs be equal length, while still
// preserving constant-time guarantees against both length and content tells.
//
// If DEBATE_KEYPHRASE is not configured on the server, the middleware fails
// closed with 500 — better to break loudly than to silently allow anyone in.

import crypto from 'node:crypto';

function sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest();
}

export function requireKeyphrase(req, res, next) {
  const expected = process.env.DEBATE_KEYPHRASE;

  if (!expected) {
    console.error('[auth] DEBATE_KEYPHRASE is not set on the server.');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const provided = req.get('X-Debate-Key') || '';

  const providedHash = sha256(provided);
  const expectedHash = sha256(expected);

  if (!crypto.timingSafeEqual(providedHash, expectedHash)) {
    return res.status(401).json({ error: 'Invalid keyphrase' });
  }

  next();
}
