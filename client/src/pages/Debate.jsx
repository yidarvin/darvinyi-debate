import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, debateStreamUrl, fetchJson } from '../api.js';

// Same key as NewDebate.jsx so keyphrase set on /new carries through to voting.
const KEYPHRASE_STORAGE_KEY = 'debate_arena_keyphrase';

function readStoredKeyphrase() {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(KEYPHRASE_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeKeyphrase(value) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(KEYPHRASE_STORAGE_KEY, value);
  } catch {
    // localStorage disabled — silent fail
  }
}

// ============================================================================
// Constants
// ============================================================================

const ROUND_DEFS = [
  { number: 1, side: 'aff', name: 'Affirmative Constructive', short: 'AC' },
  { number: 2, side: 'neg', name: 'Negative Constructive',    short: 'NC' },
  { number: 3, side: 'aff', name: 'Affirmative Rebuttal',     short: 'AR' },
  { number: 4, side: 'neg', name: 'Negative Rebuttal',        short: 'NR' },
  { number: 5, side: 'aff', name: 'Affirmative Closing',      short: 'AC' },
  { number: 6, side: 'neg', name: 'Negative Closing',         short: 'NC' },
];

// ============================================================================
// Reducer
// ============================================================================

const initialState = {
  phase: 'connecting',           // connecting | streaming | judging | complete | failed
  topic: null,
  // turns: map from round number to { round, side, segments, content?, toolCalls?, complete }
  turns: {},
  activeRound: null,             // the round currently streaming, or null
  judgeThinking: false,
  judgeText: '',
  evaluation: null,              // populated on evaluation_complete
  eloChanges: [],                // populated on elo_updated
  affAgent: null,                // revealed on debate_complete
  negAgent: null,                // revealed on debate_complete
  winner: null,                  // 'aff' | 'neg' | 'draw' on debate_complete
  reveal: false,                 // true once identities have been received
  allRoundsComplete: false,
  streamError: null,             // hard error — render in red
  streamNotice: null,            // soft info — render in amber
};

function reducer(state, action) {
  switch (action.type) {
    case 'debate_start': {
      return {
        ...state,
        phase: 'streaming',
        topic: action.payload.topic ?? state.topic,
      };
    }

    case 'text_delta': {
      const { round, side, text } = action.payload;
      const existing = state.turns[round] ?? { round, side, segments: [], complete: false };
      const segments = [...existing.segments];
      const last = segments[segments.length - 1];
      if (last && last.kind === 'text') {
        segments[segments.length - 1] = { ...last, text: last.text + text };
      } else {
        segments.push({ kind: 'text', text });
      }
      return {
        ...state,
        activeRound: round,
        turns: { ...state.turns, [round]: { ...existing, side, segments } },
      };
    }

    case 'tool_call_start': {
      const { round, side, tool, input } = action.payload;
      const existing = state.turns[round] ?? { round, side, segments: [], complete: false };
      const segments = [
        ...existing.segments,
        { kind: 'tool', tool, input: stringifyInput(input), status: 'active', summary: null },
      ];
      return {
        ...state,
        activeRound: round,
        turns: { ...state.turns, [round]: { ...existing, side, segments } },
      };
    }

    case 'tool_call_end': {
      const { round, tool, outputSummary } = action.payload;
      const existing = state.turns[round];
      if (!existing) return state;
      // Update the LAST matching active tool segment.
      const segments = [...existing.segments];
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].kind === 'tool' && segments[i].tool === tool && segments[i].status === 'active') {
          segments[i] = { ...segments[i], status: 'complete', summary: outputSummary };
          break;
        }
      }
      return {
        ...state,
        turns: { ...state.turns, [round]: { ...existing, segments } },
      };
    }

    case 'round_complete': {
      const { round, side, content, toolCalls, tokensIn, tokensOut, durationMs, resumed } = action.payload;
      const existing = state.turns[round] ?? { round, side, segments: [], complete: false };
      // If we have no segments (replay or resume), construct a single-text-segment view.
      const segments = existing.segments.length > 0
        ? existing.segments
        : [{ kind: 'text', text: content }];
      return {
        ...state,
        activeRound: null,
        turns: {
          ...state.turns,
          [round]: {
            ...existing,
            side,
            segments,
            content,
            toolCalls: toolCalls ?? [],
            tokensIn: tokensIn ?? 0,
            tokensOut: tokensOut ?? 0,
            durationMs: durationMs ?? 0,
            complete: true,
            resumed: !!resumed,
          },
        },
      };
    }

    case 'all_rounds_complete': {
      return { ...state, allRoundsComplete: true, phase: 'judging' };
    }

    case 'judge_thinking': {
      return { ...state, judgeThinking: true, phase: 'judging' };
    }

    case 'judge_text_delta': {
      return { ...state, judgeText: state.judgeText + action.payload.text };
    }

    case 'evaluation_complete': {
      const { winner, affScores, negScores, reasoning, judgeModel } = action.payload;
      return {
        ...state,
        judgeThinking: false,
        // If we never streamed deltas (replay), populate judgeText from the saved reasoning.
        judgeText: state.judgeText || reasoning || '',
        evaluation: { winner, affScores, negScores, reasoning, judgeModel },
        winner,
      };
    }

    case 'elo_updated': {
      return { ...state, eloChanges: action.payload.changes ?? [] };
    }

    case 'debate_complete': {
      const { affAgent, negAgent, winner, evaluation, eloChanges, topic } = action.payload;

      // Merge human vote fields from the server's evaluation payload into the
      // existing in-memory evaluation (built by evaluation_complete on live).
      // On replay, state.evaluation may still be null until this event arrives.
      const mergedEvaluation = state.evaluation
        ? {
            ...state.evaluation,
            humanWinner: evaluation?.humanWinner ?? null,
            humanAgreedWithJudge: evaluation?.humanAgreedWithJudge ?? null,
            humanVotedAt: evaluation?.humanVotedAt ?? null,
          }
        : evaluation ?? null;

      return {
        ...state,
        phase: 'complete',
        affAgent,
        negAgent,
        reveal: true,
        winner: winner ?? state.winner,
        topic: state.topic ?? topic,
        evaluation: mergedEvaluation,
        eloChanges: state.eloChanges.length > 0 ? state.eloChanges : (eloChanges ?? []),
      };
    }

    case 'vote_recorded': {
      // Local action dispatched after a successful POST /:id/vote.
      const { agreed, humanWinner, finalWinner, eloChanges } = action.payload;
      return {
        ...state,
        winner: finalWinner,
        evaluation: state.evaluation
          ? {
              ...state.evaluation,
              humanWinner,
              humanAgreedWithJudge: agreed,
              humanVotedAt: new Date().toISOString(),
            }
          : state.evaluation,
        eloChanges: eloChanges ?? state.eloChanges,
      };
    }

    case 'stream_error': {
      // Server-sent 'error' event payload: { message: string }
      const { message } = action.payload;
      // Distinguish info-level (in-progress in another session) from hard errors.
      const isSoft =
        typeof message === 'string' && /in progress in another session/i.test(message);
      return {
        ...state,
        phase: isSoft ? state.phase : 'failed',
        streamError: isSoft ? null : message,
        streamNotice: isSoft ? message : state.streamNotice,
      };
    }

    case 'connection_lost': {
      // Connection-level error (network, server closed unexpectedly).
      // If we haven't received a normal completion, surface this.
      if (state.phase === 'complete' || state.phase === 'failed') return state;
      return { ...state, phase: 'failed', streamError: 'Connection lost.' };
    }

    default:
      return state;
  }
}

function stringifyInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

// ============================================================================
// Page
// ============================================================================

export default function Debate() {
  const { id } = useParams();
  const [state, dispatch] = useReducer(reducer, initialState);

  // SSE setup.
  useEffect(() => {
    if (!id) return;

    const es = new EventSource(debateStreamUrl(id));
    let closed = false;

    const closeStream = () => {
      if (closed) return;
      closed = true;
      es.close();
    };

    const handle = (type) => (event) => {
      let data = null;
      if (event?.data) {
        try {
          data = JSON.parse(event.data);
        } catch {
          data = null;
        }
      }
      dispatch({ type, payload: data ?? {} });
    };

    es.addEventListener('debate_start',         handle('debate_start'));
    es.addEventListener('text_delta',           handle('text_delta'));
    es.addEventListener('tool_call_start',      handle('tool_call_start'));
    es.addEventListener('tool_call_end',        handle('tool_call_end'));
    es.addEventListener('round_complete',       handle('round_complete'));
    es.addEventListener('all_rounds_complete',  handle('all_rounds_complete'));
    es.addEventListener('judge_thinking',       handle('judge_thinking'));
    es.addEventListener('judge_text_delta',     handle('judge_text_delta'));
    es.addEventListener('evaluation_complete',  handle('evaluation_complete'));
    es.addEventListener('elo_updated',          handle('elo_updated'));

    es.addEventListener('debate_complete', (event) => {
      handle('debate_complete')(event);
      closeStream();
    });

    es.addEventListener('error', (event) => {
      if (event?.data) {
        // Server-sent error event with payload.
        let data = null;
        try { data = JSON.parse(event.data); } catch {}
        dispatch({ type: 'stream_error', payload: data ?? { message: 'Stream error' } });
        closeStream();
      } else if (es.readyState === EventSource.CLOSED) {
        // Server closed connection normally OR network drop.
        dispatch({ type: 'connection_lost', payload: {} });
        closeStream();
      }
      // Otherwise: transient, EventSource will reconnect on its own.
    });

    return () => {
      closeStream();
    };
  }, [id]);

  // Auto-scroll: only follow the stream if the user is near the bottom.
  const autoScrollRef = useRef(true);
  useEffect(() => {
    const handleScroll = () => {
      const fromBottom =
        document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      autoScrollRef.current = fromBottom < 200;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Whenever the streaming content changes, scroll to bottom if user is following.
  const streamSig = useMemo(
    () =>
      JSON.stringify({
        activeRound: state.activeRound,
        judgeLen: state.judgeText.length,
        phase: state.phase,
        // round content lengths
        rcl: ROUND_DEFS.map((r) => state.turns[r.number]?.segments?.length ?? 0).join('-'),
      }),
    [state],
  );

  useEffect(() => {
    if (!autoScrollRef.current) return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }, [streamSig]);

  return (
    <div className="max-w-content mx-auto px-6 py-12 md:py-16">
      <PageHeader id={id} state={state} />

      <div className="mt-10 space-y-6">
        {ROUND_DEFS.map((def) => (
          <RoundCard
            key={def.number}
            def={def}
            turn={state.turns[def.number]}
            isActive={state.activeRound === def.number}
            reveal={state.reveal}
            affName={state.affAgent?.displayName}
            negName={state.negAgent?.displayName}
          />
        ))}
      </div>

      {(state.allRoundsComplete || state.judgeThinking || state.judgeText || state.evaluation) && (
        <VerdictSection state={state} />
      )}

      {state.streamNotice && (
        <div className="mt-10 border border-amber-500/30 bg-amber-500/5 rounded-md p-4">
          <p className="font-mono text-xs text-amber-400 uppercase tracking-wider mb-1">
            Notice
          </p>
          <p className="font-body text-sm text-amber-400/90">{state.streamNotice}</p>
        </div>
      )}

      {state.streamError && (
        <div className="mt-10 border border-red-500/30 bg-red-500/5 rounded-md p-4">
          <p className="font-mono text-xs text-red-400 uppercase tracking-wider mb-1">
            Error
          </p>
          <p className="font-body text-sm text-red-400/90">{state.streamError}</p>
        </div>
      )}

      {state.phase === 'complete' && state.evaluation && (
        <VoteSection debateId={id} state={state} dispatch={dispatch} />
      )}

      {state.phase === 'complete' && <ReRunFooter debateId={id} />}
    </div>
  );
}

// ============================================================================
// Page header (topic + status)
// ============================================================================

function PageHeader({ id, state }) {
  const statusLabel = useMemo(() => {
    if (state.phase === 'connecting') return 'Connecting…';
    if (state.phase === 'streaming') {
      const active = state.activeRound;
      if (active) {
        const def = ROUND_DEFS.find((r) => r.number === active);
        return `Round ${active} of 6 — ${def?.name ?? ''}`;
      }
      return 'Streaming…';
    }
    if (state.phase === 'judging') return 'Judging…';
    if (state.phase === 'complete') return 'Complete';
    if (state.phase === 'failed') return 'Failed';
    return state.phase;
  }, [state.phase, state.activeRound]);

  const statusDotClass =
    state.phase === 'complete'
      ? 'bg-text-muted'
      : state.phase === 'failed'
      ? 'bg-red-500'
      : 'bg-accent shadow-[0_0_8px_rgba(34,211,238,0.7)] animate-pulse-soft';

  return (
    <div>
      <div className="flex items-center gap-2 mb-6">
        <span className={`w-1.5 h-1.5 rounded-full ${statusDotClass}`} />
        <span className="font-mono text-xs text-text-dim uppercase tracking-[0.2em]">
          {statusLabel}
        </span>
        <span className="font-mono text-xs text-text-muted ml-auto truncate">{id}</span>
      </div>

      {state.topic ? (
        <h1 className="font-display text-display-md md:text-display-lg text-text leading-[1.15]">
          {state.topic}
        </h1>
      ) : (
        <div className="h-16 bg-bg-elevated rounded animate-pulse" />
      )}
    </div>
  );
}

// ============================================================================
// Round card
// ============================================================================

function RoundCard({ def, turn, isActive, reveal, affName, negName }) {
  const sideTokens =
    def.side === 'aff'
      ? { border: 'border-l-side-aff/60', text: 'text-side-aff', bg: 'bg-side-aff' }
      : { border: 'border-l-side-neg/60', text: 'text-side-neg', bg: 'bg-side-neg' };

  const sideLabel = def.side === 'aff' ? 'AFFIRMATIVE' : 'NEGATIVE';
  const revealedName = def.side === 'aff' ? affName : negName;

  return (
    <article
      className={`card border-l-4 ${sideTokens.border} p-5 md:p-6 ${
        isActive ? 'ring-1 ring-accent/20' : ''
      } animate-fade-in`}
    >
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-3">
            <span className={`font-mono text-xs uppercase tracking-wider ${sideTokens.text}`}>
              {sideLabel}
            </span>
            {reveal && revealedName && (
              <span className="font-display text-text text-base animate-fade-in">
                · {revealedName}
              </span>
            )}
          </div>
          <h2 className="font-display text-xl md:text-2xl text-text mt-1">
            Round {def.number} · {def.name}
          </h2>
        </div>

        {turn?.complete && (
          <div className="hidden sm:flex items-center gap-3 text-xs font-mono text-text-muted shrink-0">
            <span>{turn.tokensOut?.toLocaleString() ?? 0} tok</span>
            <span>{Math.round((turn.durationMs ?? 0) / 1000)}s</span>
          </div>
        )}
      </div>

      <RoundBody turn={turn} isActive={isActive} sideTokens={sideTokens} />
    </article>
  );
}

function RoundBody({ turn, isActive, sideTokens }) {
  if (!turn) {
    return (
      <p className="font-mono text-sm text-text-muted italic">Waiting…</p>
    );
  }

  return (
    <div className="font-body text-text-dim leading-relaxed space-y-4 prose-body">
      {turn.segments.map((seg, idx) => {
        if (seg.kind === 'text') {
          const isLastSegment = idx === turn.segments.length - 1;
          const showCursor = isActive && isLastSegment && !turn.complete;
          return (
            <p key={idx} className="whitespace-pre-wrap">
              {seg.text}
              {showCursor && (
                <span
                  className={`inline-block ml-0.5 ${sideTokens.bg} animate-pulse`}
                  style={{ width: '0.6ch', height: '1.1em', verticalAlign: '-0.2em' }}
                  aria-hidden="true"
                />
              )}
            </p>
          );
        }
        if (seg.kind === 'tool') {
          return <ToolPill key={idx} seg={seg} sideTokens={sideTokens} />;
        }
        return null;
      })}
    </div>
  );
}

function ToolPill({ seg, sideTokens }) {
  return (
    <div className={`inline-flex items-center gap-2 border border-bg-border rounded-md px-3 py-1.5 text-xs font-mono ${sideTokens.text} bg-bg-elevated my-1`}>
      <span className={`w-1.5 h-1.5 rounded-full ${sideTokens.bg} ${seg.status === 'active' ? 'animate-pulse' : ''}`} />
      <span className="text-text-dim">{seg.tool}</span>
      {seg.input && (
        <span className="text-text-muted truncate max-w-[24rem]">· {seg.input}</span>
      )}
      {seg.summary && (
        <span className="text-text-muted">· {seg.summary}</span>
      )}
    </div>
  );
}

// ============================================================================
// Verdict section
// ============================================================================

function VerdictSection({ state }) {
  return (
    <section className="mt-12 border-t border-bg-border pt-10">
      <h2 className="font-display text-display-md text-text mb-6">Verdict</h2>

      {/* Judge reasoning (streaming or final) */}
      <div className="card p-5 md:p-6 mb-6">
        <div className="flex items-center justify-between gap-4 mb-4">
          <span className="font-mono text-xs text-text-dim uppercase tracking-wider">
            Judge reasoning
          </span>
          <span className="font-mono text-xs text-text-muted">
            {state.evaluation?.judgeModel ?? 'claude-opus-4-7'}
          </span>
        </div>

        {state.judgeText ? (
          <p className="font-body text-text-dim leading-relaxed whitespace-pre-wrap">
            {state.judgeText}
            {state.judgeThinking && !state.evaluation && (
              <span
                className="inline-block ml-0.5 bg-accent animate-pulse"
                style={{ width: '0.6ch', height: '1.1em', verticalAlign: '-0.2em' }}
                aria-hidden="true"
              />
            )}
          </p>
        ) : (
          <p className="font-mono text-sm text-text-muted italic">
            {state.judgeThinking ? 'Thinking…' : 'Waiting…'}
          </p>
        )}
      </div>

      {/* Score table + winner */}
      {state.evaluation && (
        <ScoreSection
          evaluation={state.evaluation}
          affName={state.affAgent?.displayName}
          negName={state.negAgent?.displayName}
          eloChanges={state.eloChanges}
          affAgentId={state.affAgent?.id}
          negAgentId={state.negAgent?.id}
        />
      )}
    </section>
  );
}

function ScoreSection({ evaluation, affName, negName, eloChanges, affAgentId, negAgentId }) {
  const { winner, affScores, negScores } = evaluation;
  const axes = [
    { key: 'argument',   label: 'Argument' },
    { key: 'evidence',   label: 'Evidence' },
    { key: 'responsive', label: 'Responsiveness' },
    { key: 'persuasion', label: 'Persuasion' },
  ];

  const affEloChange = eloChanges.find((c) => c.agentId === affAgentId);
  const negEloChange = eloChanges.find((c) => c.agentId === negAgentId);

  return (
    <div className="card p-5 md:p-6">
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div />
        <SideHeader side="aff" name={affName} isWinner={winner === 'aff'} elo={affEloChange} />
        <SideHeader side="neg" name={negName} isWinner={winner === 'neg'} elo={negEloChange} />
      </div>

      <div className="space-y-2">
        {axes.map((axis) => (
          <div key={axis.key} className="grid grid-cols-3 gap-4 items-center">
            <span className="font-mono text-xs text-text-dim uppercase tracking-wider">
              {axis.label}
            </span>
            <ScoreCell value={affScores[axis.key]} winning={affScores[axis.key] > negScores[axis.key]} side="aff" />
            <ScoreCell value={negScores[axis.key]} winning={negScores[axis.key] > affScores[axis.key]} side="neg" />
          </div>
        ))}
      </div>

      <div className="border-t border-bg-border mt-4 pt-4 grid grid-cols-3 gap-4 items-center">
        <span className="font-mono text-xs text-text uppercase tracking-wider">Total</span>
        <ScoreCell value={affScores.total} winning={winner === 'aff'} side="aff" emphasis />
        <ScoreCell value={negScores.total} winning={winner === 'neg'} side="neg" emphasis />
      </div>

      {winner === 'draw' && (
        <p className="mt-4 font-mono text-xs text-text-dim text-center uppercase tracking-wider">
          Draw — equal scores
        </p>
      )}
    </div>
  );
}

function SideHeader({ side, name, isWinner, elo }) {
  const sideTokens = side === 'aff' ? 'text-side-aff' : 'text-side-neg';
  return (
    <div className="text-right md:text-center">
      <div className={`font-mono text-xs uppercase tracking-wider ${sideTokens} mb-1`}>
        {side === 'aff' ? 'AFFIRMATIVE' : 'NEGATIVE'}
        {isWinner && <span className="ml-1.5 text-accent">·  WIN</span>}
      </div>
      {name && <div className="font-display text-text text-base truncate">{name}</div>}
      {elo && (
        <div className="font-mono text-xs text-text-muted mt-1">
          {Math.round(elo.before)} →{' '}
          <span className="text-text-dim">{Math.round(elo.after)}</span>
          {' '}
          <EloDeltaBadge delta={elo.delta} />
        </div>
      )}
    </div>
  );
}

function EloDeltaBadge({ delta }) {
  const rounded = Math.round(delta);
  const isPositive = rounded > 0;
  const isNegative = rounded < 0;
  const cls = isPositive ? 'text-accent' : isNegative ? 'text-red-400' : 'text-text-muted';
  const sign = isPositive ? '+' : '';
  return <span className={`font-mono ${cls}`}>({sign}{rounded})</span>;
}

function ScoreCell({ value, winning, side, emphasis }) {
  const cls = winning
    ? side === 'aff'
      ? 'text-side-aff'
      : 'text-side-neg'
    : 'text-text-dim';
  return (
    <div className="text-right md:text-center">
      <span className={`font-mono ${emphasis ? 'text-2xl' : 'text-base'} ${cls}`}>
        {Number.isFinite(value) ? value.toFixed(1) : '—'}
      </span>
    </div>
  );
}

// ============================================================================
// Re-run footer
// ============================================================================

function ReRunFooter({ debateId }) {
  return (
    <div className="mt-12 border-t border-bg-border pt-10 flex items-center justify-between flex-wrap gap-4">
      <div>
        <p className="font-display text-xl text-text mb-1">Same topic, different agents?</p>
        <p className="font-mono text-sm text-text-dim">
          Re-run with a fresh random pairing.
        </p>
      </div>
      <Link to={`/new?rerunOf=${encodeURIComponent(debateId)}`} className="btn-primary">
        Re-run this debate
        <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

// ============================================================================
// Vote section — appears below the verdict, after debate_complete
// ============================================================================

function VoteSection({ debateId, state, dispatch }) {
  const judgeWinner = state.evaluation.winner;
  const humanWinner = state.evaluation.humanWinner ?? null;
  const agreed = state.evaluation.humanAgreedWithJudge;

  // If a human vote already exists (set by reducer after vote or arrived on replay),
  // show the confirmation card. Otherwise show the vote panel.
  if (humanWinner) {
    return <VotedCard humanWinner={humanWinner} judgeWinner={judgeWinner} agreed={agreed} />;
  }

  return <VotePanel debateId={debateId} judgeWinner={judgeWinner} dispatch={dispatch} />;
}

// ----------------------------------------------------------------------------
// Vote panel (pre-vote)
// ----------------------------------------------------------------------------

function VotePanel({ debateId, judgeWinner, dispatch }) {
  const [keyphrase, setKeyphrase] = useState(readStoredKeyphrase);
  const [submitting, setSubmitting] = useState(null); // 'aff' | 'neg' | 'draw' | null
  const [error, setError] = useState(null);

  const needsKeyphraseInput = !readStoredKeyphrase();

  const handleVote = async (winner) => {
    if (submitting) return;

    const trimmedKey = keyphrase.trim();
    if (!trimmedKey) {
      setError('Enter your keyphrase first.');
      return;
    }

    setSubmitting(winner);
    setError(null);

    try {
      const result = await fetchJson(`/debates/${encodeURIComponent(debateId)}/vote`, {
        method: 'POST',
        body: { winner },
        headers: { 'X-Debate-Key': trimmedKey },
      });

      storeKeyphrase(trimmedKey);
      dispatch({ type: 'vote_recorded', payload: result });
    } catch (err) {
      setSubmitting(null);
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError('Invalid keyphrase.');
        } else if (err.status === 409) {
          setError('This debate already has a recorded vote.');
        } else if (err.status === 429) {
          setError(err.message || 'Rate limit reached. Try again in a few hours.');
        } else if (err.status === 400) {
          setError(err.message || 'Invalid request.');
        } else {
          setError(err.message || 'Vote failed.');
        }
      } else {
        setError(err.message || 'Network error.');
      }
    }
  };

  return (
    <section className="mt-12 border-t border-bg-border pt-10">
      <h2 className="font-display text-display-md text-text mb-3">Your call?</h2>
      <p className="font-body text-text-dim mb-8 max-w-reading leading-relaxed">
        The judge has weighed in above. Do you agree, or do you see it differently? If you
        override, the ELO will be recalculated based on your verdict. One vote per debate.
      </p>

      {needsKeyphraseInput && (
        <div className="mb-6">
          <label htmlFor="vote-keyphrase" className="font-mono text-xs text-text-muted block mb-2 uppercase tracking-wider">
            Keyphrase
          </label>
          <input
            id="vote-keyphrase"
            type="password"
            value={keyphrase}
            onChange={(e) => setKeyphrase(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="••••••••"
            disabled={!!submitting}
            className="w-full max-w-xs bg-bg-elevated border border-bg-border rounded-md p-2.5 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors disabled:opacity-60"
          />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <VoteButton
          side="aff"
          label="AFF wins"
          isJudgePick={judgeWinner === 'aff'}
          onClick={() => handleVote('aff')}
          submitting={submitting}
        />
        <VoteButton
          side="draw"
          label="Draw"
          isJudgePick={judgeWinner === 'draw'}
          onClick={() => handleVote('draw')}
          submitting={submitting}
        />
        <VoteButton
          side="neg"
          label="NEG wins"
          isJudgePick={judgeWinner === 'neg'}
          onClick={() => handleVote('neg')}
          submitting={submitting}
        />
      </div>

      {error && (
        <p role="alert" className="font-mono text-sm text-red-400 mt-4">
          {error}
        </p>
      )}
    </section>
  );
}

function VoteButton({ side, label, isJudgePick, onClick, submitting }) {
  const sideTokens =
    side === 'aff'
      ? {
          border: 'border-side-aff/30',
          hoverBorder: 'hover:border-side-aff',
          hoverBg: 'hover:bg-side-aff/5',
          text: 'text-side-aff',
        }
      : side === 'neg'
      ? {
          border: 'border-side-neg/30',
          hoverBorder: 'hover:border-side-neg',
          hoverBg: 'hover:bg-side-neg/5',
          text: 'text-side-neg',
        }
      : {
          border: 'border-bg-border',
          hoverBorder: 'hover:border-text-dim',
          hoverBg: 'hover:bg-bg-elevated',
          text: 'text-text-dim',
        };

  const isSubmittingThis = submitting === side;
  const isSubmittingOther = submitting !== null && submitting !== side;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!submitting}
      className={[
        'relative card p-5 transition-all text-center',
        sideTokens.border,
        !submitting && sideTokens.hoverBorder,
        !submitting && sideTokens.hoverBg,
        isSubmittingOther && 'opacity-30',
        submitting && 'cursor-not-allowed',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className={`font-display text-lg ${sideTokens.text}`}>
        {isSubmittingThis ? (
          <span className="inline-flex items-center justify-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
            <span className="opacity-70">Voting…</span>
          </span>
        ) : (
          label
        )}
      </span>
      {isJudgePick && (
        <span className="absolute top-2 right-2 font-mono text-[10px] text-accent uppercase tracking-wider">
          judge
        </span>
      )}
    </button>
  );
}

// ----------------------------------------------------------------------------
// Voted card (post-vote OR replay of voted debate)
// ----------------------------------------------------------------------------

function VotedCard({ humanWinner, judgeWinner, agreed }) {
  const labelFor = (w) =>
    w === 'aff' ? 'Affirmative' : w === 'neg' ? 'Negative' : w === 'draw' ? 'Draw' : '—';

  const borderClass = agreed ? 'border-l-accent' : 'border-l-amber-500';

  return (
    <section className="mt-12 border-t border-bg-border pt-10">
      <h2 className="font-display text-display-md text-text mb-6">Your verdict</h2>

      <div className={`card border-l-4 ${borderClass} p-5 md:p-6`}>
        {agreed ? (
          <>
            <p className="font-mono text-xs text-accent uppercase tracking-wider mb-3">
              Agreed with judge
            </p>
            <p className="font-body text-text-dim leading-relaxed">
              You and the judge both called this for{' '}
              <strong className="text-text font-medium">{labelFor(humanWinner)}</strong>.
              The verdict stands; no ELO changes.
            </p>
          </>
        ) : (
          <>
            <p className="font-mono text-xs text-amber-400 uppercase tracking-wider mb-3">
              Overrode the judge
            </p>
            <p className="font-body text-text-dim leading-relaxed">
              The judge called it for{' '}
              <strong className="text-text font-medium">{labelFor(judgeWinner)}</strong>,
              but you ruled{' '}
              <strong className="text-text font-medium">{labelFor(humanWinner)}</strong>.
              ELO has been recalculated based on your verdict.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
