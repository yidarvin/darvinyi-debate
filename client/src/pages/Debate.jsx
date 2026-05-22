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
  { number: 1, side: 'aff', name: 'Affirmative Constructive' },
  { number: 2, side: 'neg', name: 'Negative Constructive' },
  { number: 3, side: 'aff', name: 'Affirmative Rebuttal' },
  { number: 4, side: 'neg', name: 'Negative Rebuttal' },
  { number: 5, side: 'aff', name: 'Affirmative Closing' },
  { number: 6, side: 'neg', name: 'Negative Closing' },
];

// ============================================================================
// Reducer
// ============================================================================

const initialState = {
  phase: 'connecting', // 'connecting' | 'streaming' | 'judging' | 'complete' | 'failed'
  topic: null,

  // Turns organized by leg → roundNumber → turn
  turns: { 1: {}, 2: {} },

  // Active position during streaming
  activeLeg: null,
  activeRound: null,

  // Per-leg judge state
  judgeThinking: { 1: false, 2: false },
  judgeText: { 1: '', 2: '' },

  // Per-leg evaluations
  evaluations: { 1: null, 2: null },

  // Agent identities and match-level result (set on debate_complete)
  agentA: null,
  agentB: null,
  winner: null, // 'A' | 'B' | 'draw' | null
  matchOutcome: null,
  reveal: false,

  eloChanges: [],

  // Lifecycle flags
  legsComplete: { 1: false, 2: false },
  allLegsComplete: false,

  streamError: null,
  streamNotice: null,
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

    case 'leg_start': {
      const { leg } = action.payload;
      return {
        ...state,
        activeLeg: leg,
        activeRound: null,
        phase: state.phase === 'connecting' ? 'streaming' : state.phase,
      };
    }

    case 'text_delta': {
      const { leg, round, side, text } = action.payload;
      const legTurns = { ...state.turns[leg] };
      const existing =
        legTurns[round] ?? { round, side, segments: [], toolCalls: [], complete: false };
      const segments = [...existing.segments];
      const last = segments[segments.length - 1];
      if (last && last.kind === 'text') {
        segments[segments.length - 1] = { ...last, text: last.text + text };
      } else {
        segments.push({ kind: 'text', text });
      }
      legTurns[round] = { ...existing, side, segments };
      return {
        ...state,
        turns: { ...state.turns, [leg]: legTurns },
        activeLeg: leg,
        activeRound: round,
        phase: state.phase === 'connecting' ? 'streaming' : state.phase,
      };
    }

    case 'tool_call_start': {
      const { leg, round, side, tool, input } = action.payload;
      const legTurns = { ...state.turns[leg] };
      const existing =
        legTurns[round] ?? { round, side, segments: [], toolCalls: [], complete: false };
      const segments = [
        ...existing.segments,
        { kind: 'tool', tool, input: stringifyInput(input), status: 'active', summary: null },
      ];
      legTurns[round] = { ...existing, side, segments };
      return {
        ...state,
        turns: { ...state.turns, [leg]: legTurns },
        activeLeg: leg,
        activeRound: round,
      };
    }

    case 'tool_call_end': {
      const { leg, round, tool, outputSummary } = action.payload;
      const legTurns = { ...state.turns[leg] };
      const existing = legTurns[round];
      if (!existing) return state;
      const segments = [...existing.segments];
      for (let i = segments.length - 1; i >= 0; i--) {
        if (
          segments[i].kind === 'tool' &&
          segments[i].tool === tool &&
          segments[i].status === 'active'
        ) {
          segments[i] = { ...segments[i], status: 'complete', summary: outputSummary };
          break;
        }
      }
      legTurns[round] = { ...existing, segments };
      return {
        ...state,
        turns: { ...state.turns, [leg]: legTurns },
      };
    }

    case 'round_complete': {
      const {
        leg,
        round,
        side,
        content,
        toolCalls,
        tokensIn,
        tokensOut,
        durationMs,
        resumed,
      } = action.payload;
      const legTurns = { ...state.turns[leg] };
      const existing =
        legTurns[round] ?? { round, side, segments: [], toolCalls: [], complete: false };
      const segments =
        existing.segments.length > 0
          ? existing.segments
          : [{ kind: 'text', text: content ?? '' }];
      legTurns[round] = {
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
      };
      return {
        ...state,
        turns: { ...state.turns, [leg]: legTurns },
      };
    }

    case 'leg_complete': {
      const { leg } = action.payload;
      const legsComplete = { ...state.legsComplete, [leg]: true };
      const bothDone = legsComplete[1] && legsComplete[2];
      return {
        ...state,
        legsComplete,
        activeRound: bothDone ? null : state.activeRound,
        activeLeg: bothDone ? null : state.activeLeg,
      };
    }

    case 'all_legs_complete': {
      return {
        ...state,
        allLegsComplete: true,
        phase: 'judging',
        activeLeg: null,
        activeRound: null,
      };
    }

    case 'judge_thinking': {
      const { leg } = action.payload;
      return {
        ...state,
        judgeThinking: { ...state.judgeThinking, [leg]: true },
        phase: 'judging',
      };
    }

    case 'judge_text_delta': {
      const { leg, text } = action.payload;
      return {
        ...state,
        judgeText: {
          ...state.judgeText,
          [leg]: state.judgeText[leg] + text,
        },
      };
    }

    case 'evaluation_complete': {
      const { leg, winner, affScores, negScores, reasoning, judgeModel } = action.payload;
      const judgeThinking = { ...state.judgeThinking, [leg]: false };
      // Preserve any streamed reasoning text; fall back to payload reasoning on replay.
      const judgeText = { ...state.judgeText };
      if (!judgeText[leg]) judgeText[leg] = reasoning ?? '';
      return {
        ...state,
        judgeThinking,
        judgeText,
        evaluations: {
          ...state.evaluations,
          [leg]: {
            winner,
            affScores,
            negScores,
            reasoning,
            judgeModel,
            humanWinner: null,
            humanAgreedWithJudge: null,
            humanVotedAt: null,
          },
        },
      };
    }

    case 'elo_updated': {
      return { ...state, eloChanges: action.payload.changes ?? [] };
    }

    case 'debate_complete': {
      const {
        debateId: _debateId,
        topic,
        agentA,
        agentB,
        winner,
        evaluations: serverEvals,
        matchOutcome,
        eloChanges,
      } = action.payload;

      // Merge human vote fields from the server's evaluations array into the
      // in-memory state.evaluations. Server's array is length-2, sorted by leg ASC.
      const mergedEvaluations = { ...state.evaluations };
      for (const serverEval of serverEvals ?? []) {
        const { leg } = serverEval;
        const inMem = mergedEvaluations[leg];
        if (inMem) {
          mergedEvaluations[leg] = {
            ...inMem,
            humanWinner: serverEval.humanWinner ?? null,
            humanAgreedWithJudge: serverEval.humanAgreedWithJudge ?? null,
            humanVotedAt: serverEval.humanVotedAt ?? null,
          };
        } else {
          // Replay path where evaluation_complete arrived just before debate_complete:
          // most flows populate inMem first, but guard just in case.
          mergedEvaluations[leg] = {
            winner: serverEval.winner,
            affScores: serverEval.affScores,
            negScores: serverEval.negScores,
            reasoning: serverEval.reasoning,
            judgeModel: serverEval.judgeModel,
            humanWinner: serverEval.humanWinner ?? null,
            humanAgreedWithJudge: serverEval.humanAgreedWithJudge ?? null,
            humanVotedAt: serverEval.humanVotedAt ?? null,
          };
        }
      }

      return {
        ...state,
        phase: 'complete',
        topic: state.topic ?? topic,
        agentA,
        agentB,
        winner: winner ?? state.winner,
        matchOutcome: matchOutcome ?? state.matchOutcome,
        reveal: true,
        evaluations: mergedEvaluations,
        eloChanges: state.eloChanges.length > 0 ? state.eloChanges : (eloChanges ?? []),
        allLegsComplete: true,
      };
    }

    case 'vote_recorded': {
      const { agreed, humanWinner, leg } = action.payload;
      const existing = state.evaluations[leg];
      if (!existing) return state;
      return {
        ...state,
        evaluations: {
          ...state.evaluations,
          [leg]: {
            ...existing,
            humanWinner,
            humanAgreedWithJudge: agreed,
            humanVotedAt: new Date().toISOString(),
          },
        },
      };
    }

    case 'stream_error': {
      const { message } = action.payload;
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
// Status label
// ============================================================================

function getStatusLabel(state) {
  if (state.phase === 'connecting') return 'Connecting…';
  if (state.phase === 'streaming') {
    if (state.activeLeg && state.activeRound) {
      return `LEG ${state.activeLeg} OF 2 · ROUND ${state.activeRound} OF 6`;
    }
    if (state.activeLeg) {
      return `LEG ${state.activeLeg} OF 2`;
    }
    return 'Streaming…';
  }
  if (state.phase === 'judging') {
    if (!state.evaluations[1]) return 'Judging Leg 1…';
    if (!state.evaluations[2]) return 'Judging Leg 2…';
    return 'Judging…';
  }
  if (state.phase === 'complete') return 'Complete';
  if (state.phase === 'failed') return 'Failed';
  return state.phase;
}

// ============================================================================
// Page
// ============================================================================

export default function Debate() {
  const { id } = useParams();
  const [state, dispatch] = useReducer(reducer, initialState);

  // SSE setup
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

    const events = [
      'debate_start',
      'leg_start',
      'text_delta',
      'tool_call_start',
      'tool_call_end',
      'round_complete',
      'leg_complete',
      'all_legs_complete',
      'judge_thinking',
      'judge_text_delta',
      'evaluation_complete',
      'elo_updated',
    ];
    for (const name of events) {
      es.addEventListener(name, handle(name));
    }

    es.addEventListener('debate_complete', (event) => {
      handle('debate_complete')(event);
      closeStream();
    });

    es.addEventListener('error', (event) => {
      if (event?.data) {
        let data = null;
        try {
          data = JSON.parse(event.data);
        } catch {}
        dispatch({ type: 'stream_error', payload: data ?? { message: 'Stream error' } });
        closeStream();
      } else if (es.readyState === EventSource.CLOSED) {
        dispatch({ type: 'connection_lost', payload: {} });
        closeStream();
      }
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

  const streamSig = useMemo(() => {
    const t1 = Object.values(state.turns[1])
      .map((t) => t.content?.length ?? t.segments.length)
      .join(',');
    const t2 = Object.values(state.turns[2])
      .map((t) => t.content?.length ?? t.segments.length)
      .join(',');
    const j1 = state.judgeText[1].length;
    const j2 = state.judgeText[2].length;
    return `${state.phase}:${state.activeLeg ?? '-'}-${state.activeRound ?? '-'}:${t1}|${t2}:${j1}|${j2}`;
  }, [state.phase, state.activeLeg, state.activeRound, state.turns, state.judgeText]);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }, [streamSig]);

  return (
    <div className="max-w-content mx-auto px-6 py-12 md:py-16">
      <PageHeader id={id} state={state} />

      <LegSection leg={1} state={state} dispatch={dispatch} debateId={id} />
      <LegSection leg={2} state={state} dispatch={dispatch} debateId={id} />

      {(state.allLegsComplete || state.matchOutcome) && (
        <MatchOutcomeSection state={state} />
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

      {state.phase === 'complete' && <ReRunFooter debateId={id} />}
    </div>
  );
}

// ============================================================================
// Page header
// ============================================================================

function PageHeader({ id, state }) {
  const statusLabel = useMemo(() => getStatusLabel(state), [state]);

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
// Leg section
// ============================================================================

function LegSection({ leg, state, dispatch, debateId }) {
  const evaluation = state.evaluations[leg];
  const judgeText = state.judgeText[leg];
  const judgeThinking = state.judgeThinking[leg];
  const isFirstLeg = leg === 1;

  return (
    <section
      className={
        isFirstLeg ? 'mt-10' : 'mt-12 pt-12 border-t border-bg-border'
      }
    >
      <LegHeader
        leg={leg}
        reveal={state.reveal}
        agentA={state.agentA}
        agentB={state.agentB}
      />

      <div className="mt-8 space-y-6">
        {ROUND_DEFS.map((def) => (
          <RoundCard
            key={`${leg}-${def.number}`}
            leg={leg}
            def={def}
            turn={state.turns[leg][def.number]}
            isActive={
              state.activeLeg === leg && state.activeRound === def.number
            }
          />
        ))}
      </div>

      {(judgeThinking || judgeText || evaluation) && (
        <JudgeReasoning
          leg={leg}
          judgeText={judgeText}
          judgeThinking={judgeThinking}
          evaluation={evaluation}
        />
      )}

      {evaluation && (
        <ScoreSection
          leg={leg}
          evaluation={evaluation}
          reveal={state.reveal}
          agentA={state.agentA}
          agentB={state.agentB}
        />
      )}

      {evaluation && (
        <VoteSection
          leg={leg}
          debateId={debateId}
          evaluation={evaluation}
          dispatch={dispatch}
        />
      )}
    </section>
  );
}

function LegHeader({ leg, reveal, agentA, agentB }) {
  // For leg 1: agentA is AFF, agentB is NEG.
  // For leg 2: agents swap — agentB is AFF, agentA is NEG.
  const affAgent = leg === 1 ? agentA : agentB;
  const negAgent = leg === 1 ? agentB : agentA;

  return (
    <header>
      <p className="font-mono text-xs text-text-muted uppercase tracking-[0.2em] mb-2">
        LEG {leg} OF 2
      </p>
      <h2 className="font-display text-display-md text-text leading-tight">
        {reveal && affAgent && negAgent ? (
          <span className="animate-fade-in">
            <span className="text-side-aff">{affAgent.displayName}</span>{' '}
            <span className="font-mono text-base text-text-muted align-middle">(AFF)</span>{' '}
            <span className="text-text-dim">vs</span>{' '}
            <span className="text-side-neg">{negAgent.displayName}</span>{' '}
            <span className="font-mono text-base text-text-muted align-middle">(NEG)</span>
          </span>
        ) : (
          <>
            <span className="text-side-aff">Affirmative</span>{' '}
            <span className="text-text-dim">vs</span>{' '}
            <span className="text-side-neg">Negative</span>
          </>
        )}
      </h2>
    </header>
  );
}

// ============================================================================
// Round card
// ============================================================================

function RoundCard({ leg, def, turn, isActive }) {
  const sideTokens =
    def.side === 'aff'
      ? { border: 'border-l-side-aff/60', text: 'text-side-aff', bg: 'bg-side-aff' }
      : { border: 'border-l-side-neg/60', text: 'text-side-neg', bg: 'bg-side-neg' };

  const sideLabel = def.side === 'aff' ? 'AFFIRMATIVE' : 'NEGATIVE';

  return (
    <article
      className={`card border-l-4 ${sideTokens.border} p-5 md:p-6 ${
        isActive ? 'ring-1 ring-accent/20' : ''
      } animate-fade-in`}
    >
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <div>
          <span className={`font-mono text-xs uppercase tracking-wider ${sideTokens.text}`}>
            {sideLabel}
          </span>
          <h3 className="font-display text-xl md:text-2xl text-text mt-1">
            Round {def.number} · {def.name}
          </h3>
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
    return <p className="font-mono text-sm text-text-muted italic">Waiting…</p>;
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
    <div
      className={`inline-flex items-center gap-2 border border-bg-border rounded-md px-3 py-1.5 text-xs font-mono ${sideTokens.text} bg-bg-elevated my-1`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${sideTokens.bg} ${
          seg.status === 'active' ? 'animate-pulse' : ''
        }`}
      />
      <span className="text-text-dim">{seg.tool}</span>
      {seg.input && (
        <span className="text-text-muted truncate max-w-[24rem]">· {seg.input}</span>
      )}
      {seg.summary && <span className="text-text-muted">· {seg.summary}</span>}
    </div>
  );
}

// ============================================================================
// Judge reasoning (per leg)
// ============================================================================

function JudgeReasoning({ leg, judgeText, judgeThinking, evaluation }) {
  return (
    <div className="mt-8">
      <h3 className="font-display text-xl md:text-2xl text-text mb-3">
        Leg {leg} — Judge's Reasoning
      </h3>
      <div className="card border-l-4 border-l-accent p-5 md:p-6">
        <div className="flex items-center justify-between gap-4 mb-3">
          <span className="font-mono text-xs text-text-dim uppercase tracking-wider">
            Judge reasoning
          </span>
          <span className="font-mono text-xs text-text-muted">
            {evaluation?.judgeModel ?? 'claude-opus-4-7'}
          </span>
        </div>

        {judgeText ? (
          <p className="font-body text-text-dim leading-relaxed whitespace-pre-wrap">
            {judgeText}
            {judgeThinking && !evaluation && (
              <span
                className="inline-block ml-0.5 bg-accent animate-pulse"
                style={{ width: '0.6ch', height: '1.1em', verticalAlign: '-0.2em' }}
                aria-hidden="true"
              />
            )}
          </p>
        ) : (
          <p className="font-mono text-sm text-text-muted italic">
            {judgeThinking ? 'Thinking…' : 'Waiting…'}
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Score section (per leg)
// ============================================================================

function ScoreSection({ leg, evaluation, reveal, agentA, agentB }) {
  const { winner, affScores, negScores } = evaluation;
  const axes = [
    { key: 'argument', label: 'Argument' },
    { key: 'evidence', label: 'Evidence' },
    { key: 'responsive', label: 'Responsiveness' },
    { key: 'persuasion', label: 'Persuasion' },
  ];

  // Column identity: leg 1 → aff=A, neg=B; leg 2 → aff=B, neg=A.
  const affAgent = leg === 1 ? agentA : agentB;
  const negAgent = leg === 1 ? agentB : agentA;

  return (
    <div className="mt-6">
      <h3 className="font-display text-xl md:text-2xl text-text mb-4">
        Leg {leg} — Judge's Verdict
      </h3>
      <div className="card p-5 md:p-6">
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div />
          <SideHeader
            side="aff"
            isWinner={winner === 'aff'}
            reveal={reveal}
            agent={affAgent}
          />
          <SideHeader
            side="neg"
            isWinner={winner === 'neg'}
            reveal={reveal}
            agent={negAgent}
          />
        </div>

        <div className="space-y-2">
          {axes.map((axis) => (
            <div key={axis.key} className="grid grid-cols-3 gap-4 items-center">
              <span className="font-mono text-xs text-text-dim uppercase tracking-wider">
                {axis.label}
              </span>
              <ScoreCell
                value={affScores[axis.key]}
                winning={affScores[axis.key] > negScores[axis.key]}
                side="aff"
              />
              <ScoreCell
                value={negScores[axis.key]}
                winning={negScores[axis.key] > affScores[axis.key]}
                side="neg"
              />
            </div>
          ))}
        </div>

        <div className="border-t border-bg-border mt-4 pt-4 grid grid-cols-3 gap-4 items-center">
          <span className="font-mono text-xs text-text uppercase tracking-wider">Total</span>
          <ScoreCell
            value={affScores.total}
            winning={winner === 'aff'}
            side="aff"
            emphasis
          />
          <ScoreCell
            value={negScores.total}
            winning={winner === 'neg'}
            side="neg"
            emphasis
          />
        </div>

        {winner === 'draw' && (
          <p className="mt-4 font-mono text-xs text-text-dim text-center uppercase tracking-wider">
            Draw — equal scores
          </p>
        )}
      </div>
    </div>
  );
}

function SideHeader({ side, isWinner, reveal, agent }) {
  const sideTokens = side === 'aff' ? 'text-side-aff' : 'text-side-neg';
  const anonLabel = side === 'aff' ? 'AFFIRMATIVE' : 'NEGATIVE';

  return (
    <div className="text-right md:text-center">
      <div
        className={`font-mono text-xs uppercase tracking-wider ${sideTokens} mb-1`}
      >
        {reveal && agent ? (
          <span className="animate-fade-in">{agent.displayName}</span>
        ) : (
          anonLabel
        )}
        {isWinner && <span className="ml-1.5 text-accent">·  WIN</span>}
      </div>
      {reveal && agent && (
        <div className="font-mono text-[10px] text-text-muted uppercase tracking-wider animate-fade-in">
          {anonLabel}
        </div>
      )}
    </div>
  );
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
// Match outcome section
// ============================================================================

function MatchOutcomeSection({ state }) {
  const { matchOutcome, reveal, agentA, agentB, eloChanges } = state;
  if (!matchOutcome) {
    // allLegsComplete fired but matchOutcome hasn't arrived yet — render nothing
    // until the elo_updated / debate_complete event delivers it.
    return null;
  }

  const { winner, aTotal, bTotal } = matchOutcome;

  const borderClass =
    winner === 'A'
      ? 'border-l-accent'
      : winner === 'B'
      ? 'border-l-side-neg'
      : 'border-l-text-dim';

  const winnerColor =
    winner === 'A'
      ? 'text-accent'
      : winner === 'B'
      ? 'text-side-neg'
      : 'text-text-dim';

  const aLabel = reveal && agentA ? `Agent A (${agentA.displayName})` : 'Agent A';
  const bLabel = reveal && agentB ? `Agent B (${agentB.displayName})` : 'Agent B';

  let winnerText;
  if (winner === 'draw') {
    winnerText = 'Draw';
  } else if (winner === 'A') {
    winnerText = reveal && agentA ? `Agent A (${agentA.displayName})` : 'Agent A';
  } else {
    winnerText = reveal && agentB ? `Agent B (${agentB.displayName})` : 'Agent B';
  }

  return (
    <section className="mt-16 pt-12 border-t border-bg-border">
      <h2 className="font-display text-display-md text-text mb-6">Match Outcome</h2>

      <div className={`card border-l-4 ${borderClass} p-6 md:p-8`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <div>
            <p className="font-mono text-xs text-text-muted uppercase tracking-wider mb-2">
              {aLabel}
            </p>
            <p className="font-mono text-sm text-text-dim mb-2">
              Leg 1 affirmative + Leg 2 negative
            </p>
            <p className={`font-display text-3xl ${winner === 'A' ? 'text-accent' : 'text-text'}`}>
              {Number(aTotal).toFixed(1)}
            </p>
          </div>
          <div>
            <p className="font-mono text-xs text-text-muted uppercase tracking-wider mb-2">
              {bLabel}
            </p>
            <p className="font-mono text-sm text-text-dim mb-2">
              Leg 1 negative + Leg 2 affirmative
            </p>
            <p className={`font-display text-3xl ${winner === 'B' ? 'text-side-neg' : 'text-text'}`}>
              {Number(bTotal).toFixed(1)}
            </p>
          </div>
        </div>

        <div className="border-t border-bg-border pt-6">
          <p className="font-mono text-xs text-text-muted uppercase tracking-wider mb-2">
            Winner
          </p>
          <p className={`font-display text-display-md ${winnerColor}`}>{winnerText}</p>
          <p className="font-mono text-xs text-text-muted mt-3 leading-relaxed">
            Match winner is the agent with the highest summed score across both legs.
          </p>
        </div>
      </div>

      {eloChanges.length > 0 && (
        <EloChangesList
          eloChanges={eloChanges}
          reveal={reveal}
          agentA={agentA}
          agentB={agentB}
        />
      )}
    </section>
  );
}

function EloChangesList({ eloChanges, reveal, agentA, agentB }) {
  return (
    <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
      {eloChanges.map((change) => {
        let agentLabel;
        if (reveal) {
          if (agentA && change.agentId === agentA.id) {
            agentLabel = agentA.displayName;
          } else if (agentB && change.agentId === agentB.id) {
            agentLabel = agentB.displayName;
          } else {
            agentLabel = 'Agent';
          }
        } else {
          if (agentA && change.agentId === agentA.id) agentLabel = 'Agent A';
          else if (agentB && change.agentId === agentB.id) agentLabel = 'Agent B';
          else agentLabel = 'Agent';
        }

        const delta = Math.round(change.delta);
        const sign = delta > 0 ? '+' : '';
        const deltaColor =
          delta > 0 ? 'text-accent' : delta < 0 ? 'text-red-400' : 'text-text-muted';

        return (
          <div key={change.agentId} className="card p-4">
            <p className="font-mono text-xs text-text-muted uppercase tracking-wider mb-2">
              <span className={reveal ? 'animate-fade-in inline-block' : ''}>{agentLabel}</span>
            </p>
            <p className="font-mono text-sm">
              <span className="text-text-dim">{Math.round(change.before)}</span>
              <span className="text-text-muted"> → </span>
              <span className="text-text">{Math.round(change.after)}</span>
              <span className={`ml-2 ${deltaColor}`}>
                ({sign}
                {delta})
              </span>
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Vote section (per leg)
// ============================================================================

function VoteSection({ leg, debateId, evaluation, dispatch }) {
  const judgeWinner = evaluation.winner;
  const humanWinner = evaluation.humanWinner ?? null;
  const agreed = evaluation.humanAgreedWithJudge;

  if (humanWinner) {
    return (
      <VotedCard
        leg={leg}
        humanWinner={humanWinner}
        judgeWinner={judgeWinner}
        agreed={agreed}
      />
    );
  }

  return (
    <VotePanel
      leg={leg}
      debateId={debateId}
      judgeWinner={judgeWinner}
      dispatch={dispatch}
    />
  );
}

function VotePanel({ leg, debateId, judgeWinner, dispatch }) {
  const [keyphrase, setKeyphrase] = useState(readStoredKeyphrase);
  const [submitting, setSubmitting] = useState(null);
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
        body: { leg, winner },
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
          setError('This leg already has a recorded vote.');
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
    <section className="mt-8">
      <h3 className="font-display text-xl md:text-2xl text-text mb-2">
        Your call on Leg {leg}?
      </h3>
      <p className="font-body text-text-dim mb-6 max-w-reading leading-relaxed">
        The judge's per-leg verdict is above. Do you agree?
      </p>

      {needsKeyphraseInput && (
        <div className="mb-6">
          <label
            htmlFor={`vote-keyphrase-${leg}`}
            className="font-mono text-xs text-text-muted block mb-2 uppercase tracking-wider"
          >
            Keyphrase
          </label>
          <input
            id={`vote-keyphrase-${leg}`}
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

function VotedCard({ leg, humanWinner, judgeWinner, agreed }) {
  const labelFor = (w) =>
    w === 'aff' ? 'Affirmative' : w === 'neg' ? 'Negative' : w === 'draw' ? 'Draw' : '—';

  const borderClass = agreed ? 'border-l-accent' : 'border-l-amber-500';

  return (
    <section className="mt-8">
      <h3 className="font-display text-xl md:text-2xl text-text mb-4">
        Your verdict on Leg {leg}
      </h3>

      <div className={`card border-l-4 ${borderClass} p-5 md:p-6`}>
        {agreed ? (
          <>
            <p className="font-mono text-xs text-accent uppercase tracking-wider mb-3">
              Agreed with judge
            </p>
            <p className="font-body text-text-dim leading-relaxed">
              You and the judge both called Leg {leg} for{' '}
              <strong className="text-text font-medium">{labelFor(humanWinner)}</strong>.
            </p>
          </>
        ) : (
          <>
            <p className="font-mono text-xs text-amber-400 uppercase tracking-wider mb-3">
              Disagreed with judge
            </p>
            <p className="font-body text-text-dim leading-relaxed">
              The judge called Leg {leg} for{' '}
              <strong className="text-text font-medium">{labelFor(judgeWinner)}</strong>, but
              you ruled{' '}
              <strong className="text-text font-medium">{labelFor(humanWinner)}</strong>.
              Recorded as a disagreement; the match outcome is based on the judge's scores.
            </p>
          </>
        )}
      </div>
    </section>
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
      <Link
        to={`/new?rerunOf=${encodeURIComponent(debateId)}`}
        className="btn-primary"
      >
        Re-run this debate
        <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}
