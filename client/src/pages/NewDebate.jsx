import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchJson, ApiError } from '../api.js';

const MIN_TOPIC_LENGTH = 5;
const MAX_TOPIC_LENGTH = 500;
const KEYPHRASE_STORAGE_KEY = 'debate_arena_keyphrase';

const EXAMPLE_TOPICS = [
  'A four-day workweek would improve overall economic productivity in developed nations.',
  'Social media platforms should be legally classified as publishers, not neutral platforms.',
  'Universal basic income is a better anti-poverty policy than means-tested welfare programs.',
  'Public funding of professional sports stadiums is rarely justified by the economic returns.',
];

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
    // localStorage disabled — silent fail; user just re-enters next time.
  }
}

// ============================================================================
// Page
// ============================================================================

export default function NewDebate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const rerunOf = searchParams.get('rerunOf');

  const [topic, setTopic] = useState('');
  const [keyphrase, setKeyphrase] = useState(readStoredKeyphrase);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [rerunSource, setRerunSource] = useState(null);
  const [loadingRerun, setLoadingRerun] = useState(false);
  const [rerunError, setRerunError] = useState(null);

  // If rerunOf is in URL, fetch source debate and pre-populate topic.
  useEffect(() => {
    if (!rerunOf) return;
    let cancelled = false;

    setLoadingRerun(true);
    setRerunError(null);

    fetchJson(`/debates/${encodeURIComponent(rerunOf)}`)
      .then((res) => {
        if (cancelled) return;
        setRerunSource(res.debate);
        setTopic(res.debate.topic);
      })
      .catch((err) => {
        if (cancelled) return;
        setRerunError(
          err.status === 404
            ? 'Source debate not found.'
            : `Could not load source debate (${err.message ?? 'unknown'}).`,
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingRerun(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rerunOf]);

  const trimmedTopic = topic.trim();
  const topicTooShort = trimmedTopic.length > 0 && trimmedTopic.length < MIN_TOPIC_LENGTH;
  const topicTooLong = topic.length > MAX_TOPIC_LENGTH;
  const topicValid = trimmedTopic.length >= MIN_TOPIC_LENGTH && !topicTooLong;
  const keyphraseValid = keyphrase.trim().length > 0;
  const canSubmit = topicValid && keyphraseValid && !submitting && !loadingRerun;

  const handleSubmit = async (event) => {
    if (event?.preventDefault) event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    const body = rerunOf ? { rerunOf } : { topic: trimmedTopic };

    try {
      const res = await fetchJson('/debates', {
        method: 'POST',
        body,
        headers: { 'X-Debate-Key': keyphrase.trim() },
      });

      storeKeyphrase(keyphrase.trim());
      navigate(`/debate/${res.debateId}`);
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError('Invalid keyphrase. Check the value and try again.');
        } else if (err.status === 429) {
          setError(err.message || 'Rate limit reached. Try again in a few hours.');
        } else if (err.status === 400) {
          setError(err.message || 'Invalid input.');
        } else if (err.status === 404) {
          setError(err.message || 'Resource not found.');
        } else {
          setError(err.message || 'Something went wrong.');
        }
      } else {
        setError(err.message || 'Network error. Is the server running?');
      }
    }
  };

  // Cmd/Ctrl+Enter submits from the textarea.
  const handleTextareaKeyDown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      handleSubmit();
    }
  };

  return (
    <div className="max-w-reading mx-auto px-6 py-12 md:py-16">
      <PageHeader
        rerunOf={rerunOf}
        rerunSource={rerunSource}
        loadingRerun={loadingRerun}
        rerunError={rerunError}
      />

      <form onSubmit={handleSubmit} className="space-y-8" noValidate>
        <TopicField
          topic={topic}
          onChange={setTopic}
          onKeyDown={handleTextareaKeyDown}
          tooShort={topicTooShort}
          tooLong={topicTooLong}
          locked={!!rerunOf}
          disabled={submitting || loadingRerun}
        />

        {!rerunOf && !loadingRerun && (
          <ExampleTopics
            onPick={(text) => setTopic(text)}
            disabled={submitting}
          />
        )}

        <KeyphraseField
          value={keyphrase}
          onChange={setKeyphrase}
          disabled={submitting}
        />

        {error && <ErrorBanner message={error} />}

        <SubmitSection
          canSubmit={canSubmit}
          submitting={submitting}
          rerunOf={!!rerunOf}
        />
      </form>
    </div>
  );
}

// ============================================================================
// Header
// ============================================================================

function PageHeader({ rerunOf, rerunSource, loadingRerun, rerunError }) {
  return (
    <div className="mb-10">
      {rerunOf && (
        <div className="mb-6">
          {loadingRerun && (
            <div className="border border-bg-border rounded-md p-4 animate-pulse">
              <div className="h-3 bg-bg-surface rounded w-1/4 mb-2" />
              <div className="h-4 bg-bg-surface rounded w-2/3" />
            </div>
          )}
          {rerunError && (
            <div className="border border-red-500/30 bg-red-500/5 rounded-md p-4">
              <p className="font-mono text-xs text-red-400 uppercase tracking-wider mb-1">
                Re-run failed
              </p>
              <p className="font-mono text-sm text-red-400/90">{rerunError}</p>
              <Link
                to="/new"
                className="font-mono text-xs text-text-dim hover:text-accent mt-3 inline-block"
              >
                Start a fresh debate instead →
              </Link>
            </div>
          )}
          {rerunSource && !rerunError && (
            <div className="border border-accent/30 bg-accent/5 rounded-md p-4 flex items-start gap-3">
              <span className="font-mono text-xs text-accent uppercase tracking-wider shrink-0 mt-0.5">
                Re-run
              </span>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs text-text-dim mb-1.5">
                  Previous verdict:{' '}
                  <span className="text-text">
                    {rerunSource.winner === 'aff'
                      ? rerunSource.affAgent?.displayName ?? 'Affirmative'
                      : rerunSource.winner === 'neg'
                      ? rerunSource.negAgent?.displayName ?? 'Negative'
                      : rerunSource.winner === 'draw'
                      ? 'Draw'
                      : 'Unresolved'}
                  </span>
                </p>
                <p className="font-body text-sm text-text leading-relaxed">
                  {rerunSource.topic}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <h1 className="font-display text-display-md md:text-display-lg text-text">
        {rerunOf ? 'Re-run debate' : 'New debate'}
      </h1>
      <p className="font-body text-text-dim mt-2 leading-relaxed">
        {rerunOf
          ? 'Same topic, fresh random agents. Different debate, possibly different verdict.'
          : 'Submit a proposition. The site picks two language models at random and starts a six-round Lincoln-Douglas debate.'}
      </p>
    </div>
  );
}

// ============================================================================
// Topic field
// ============================================================================

function TopicField({ topic, onChange, onKeyDown, tooShort, tooLong, locked, disabled }) {
  const counterClass = useMemo(() => {
    if (tooLong) return 'text-red-400';
    if (topic.length > MAX_TOPIC_LENGTH * 0.9) return 'text-amber-400';
    return 'text-text-muted';
  }, [topic.length, tooLong]);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <label htmlFor="topic" className="font-mono text-sm text-text">
          Proposition
        </label>
        <span className={`font-mono text-xs ${counterClass}`}>
          {topic.length} / {MAX_TOPIC_LENGTH}
        </span>
      </div>
      <textarea
        id="topic"
        value={topic}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled || locked}
        readOnly={locked}
        placeholder="A four-day workweek would improve overall economic productivity in developed nations."
        rows={4}
        className="w-full bg-bg-elevated border border-bg-border rounded-lg p-4 font-body text-base text-text placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors resize-none disabled:opacity-60 read-only:cursor-not-allowed"
        aria-invalid={tooLong || undefined}
      />
      <div className="min-h-[1.25rem] mt-2">
        {locked && (
          <p className="font-mono text-xs text-text-muted">
            Topic locked — pre-filled from the source debate.
          </p>
        )}
        {!locked && tooShort && (
          <p className="font-mono text-xs text-text-muted">
            Need at least {MIN_TOPIC_LENGTH} characters.
          </p>
        )}
        {!locked && tooLong && (
          <p className="font-mono text-xs text-red-400">
            Too long — max {MAX_TOPIC_LENGTH} characters.
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Example topics
// ============================================================================

function ExampleTopics({ onPick, disabled }) {
  return (
    <div>
      <p className="font-mono text-xs text-text-muted mb-3 uppercase tracking-wider">
        Or try one of these
      </p>
      <ul className="space-y-1">
        {EXAMPLE_TOPICS.map((text) => (
          <li key={text}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(text)}
              className="w-full text-left text-sm font-body text-text-dim hover:text-accent border border-transparent hover:border-bg-border hover:bg-bg-elevated/50 rounded-md px-3 py-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <span className="text-text-muted/60 mr-2" aria-hidden="true">
                →
              </span>
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================================
// Keyphrase field
// ============================================================================

function KeyphraseField({ value, onChange, disabled }) {
  return (
    <div>
      <label htmlFor="keyphrase" className="font-mono text-sm text-text block mb-2">
        Keyphrase
      </label>
      <input
        id="keyphrase"
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder="••••••••"
        autoComplete="off"
        spellCheck={false}
        className="w-full bg-bg-elevated border border-bg-border rounded-lg p-3 font-mono text-text placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors disabled:opacity-60"
      />
      <p className="font-mono text-xs text-text-muted mt-2 leading-relaxed">
        Site is private — debates can only be started by people who know the keyphrase.
        It's saved to this browser so you'll only need to enter it once.
      </p>
    </div>
  );
}

// ============================================================================
// Error banner
// ============================================================================

function ErrorBanner({ message }) {
  return (
    <div role="alert" className="border border-red-500/30 bg-red-500/5 rounded-md p-4">
      <p className="font-mono text-xs text-red-400 uppercase tracking-wider mb-1">Error</p>
      <p className="font-body text-sm text-red-400/90">{message}</p>
    </div>
  );
}

// ============================================================================
// Submit
// ============================================================================

function SubmitSection({ canSubmit, submitting, rerunOf }) {
  return (
    <div className="space-y-4 pt-2">
      <button
        type="submit"
        disabled={!canSubmit}
        className="btn-primary w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting ? (
          <>
            <SpinnerDot />
            Starting debate…
          </>
        ) : (
          <>
            {rerunOf ? 'Start re-run' : 'Start debate'}
            <span aria-hidden="true">→</span>
          </>
        )}
      </button>
      <p className="font-mono text-xs text-text-muted text-center leading-relaxed">
        A full debate takes 2–4 minutes and uses approximately $1–$3 in API credits.
        <br />
        You'll be redirected to the live viewer.
      </p>
    </div>
  );
}

function SpinnerDot() {
  return (
    <span className="inline-flex items-center justify-center w-3 h-3" aria-hidden="true">
      <span className="absolute w-3 h-3 rounded-full bg-bg/40 animate-ping" />
      <span className="relative w-2 h-2 rounded-full bg-bg" />
    </span>
  );
}
