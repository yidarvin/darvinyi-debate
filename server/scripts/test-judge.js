// Standalone judge test.
//
// Creates a fresh debate with synthetic turn content and an in_progress
// status, runs judgeDebate on it, verifies the saved evaluation, then cleans
// up. Does NOT run any debater models — turn content is canned. Real Opus
// call for the judge, ~$0.10-$0.30 per run.
//
// Usage: cd server && node scripts/test-judge.js

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { judgeDebate } from '../src/judge/judgeDebate.js';

const TEST_TOPIC =
  'TEST DEBATE — judge module verification. A four-day workweek would improve overall economic productivity in developed nations.';

// Realistic-enough turn content so the judge has something to chew on.
// Affirmative case is moderately strong; negative is sharper. Judge should
// probably side with negative on this content.
const TURNS = [
  {
    roundNumber: 1,
    roundName: 'Affirmative Constructive',
    side: 'aff',
    content:
      "The four-day workweek is empirically validated. Iceland's 2015–2019 trials covered 2,500 public-sector workers and reported that productivity stayed steady or improved in 86% of workplaces while hours dropped to 35–36 per week. The UK's 2022 pilot of 61 companies saw 92% retain the four-day schedule, citing maintained or improved revenue. The mechanism is well-understood: knowledge work has diminishing returns past 35–40 focused hours, and compressing the workweek forces organizations to redesign meetings, async coordination, and deep work blocks — exactly the operational improvements most firms have deferred.",
  },
  {
    roundNumber: 2,
    roundName: 'Negative Constructive',
    side: 'neg',
    content:
      "My opponent's evidence is selective and overstates what the data supports. Iceland's trial was not a productivity study — it was a wage-protected reduction of hours in public-sector roles where output is famously hard to measure. The 86% figure refers to subjective workplace assessments, not measured output. The UK pilot's 92% retention reflects employer satisfaction with retention and recruitment, not productivity gains; revenue holding flat while costs hold flat is not a productivity improvement. More critically, the proposition generalizes from knowledge work to overall economic productivity in developed nations. Manufacturing, healthcare, logistics, retail, and service industries — the bulk of developed-nation employment — cannot compress output the way a marketing team can. A nurse's productive hours are bounded by patient needs. Mandating a four-day standard either raises labor costs by 25% in those sectors or requires productivity gains with no empirical basis outside white-collar pilots.",
  },
  {
    roundNumber: 3,
    roundName: 'Affirmative Rebuttal',
    side: 'aff',
    content:
      "The negative concedes the case in knowledge sectors, then pivots to industries where implementation is harder. That's a meaningful concession: roughly 40% of OECD employment is now in information-intensive roles where four-day weeks have demonstrated viability. Even partial adoption captures large aggregate gains. On manufacturing and services: the negative assumes a fixed-task model. Microsoft Japan's 2019 trial of 2,300 office workers reported a 40% productivity increase attributed to shorter meetings and disciplined collaboration. Sweden's six-hour-day trial at Svartedalens nursing home cut sick leave by 10% and improved patient outcomes. The argument isn't that every sector benefits identically — it's that aggregate national productivity rises when the dominant sector gains substantially and adjacent sectors capture modest improvements.",
  },
  {
    roundNumber: 4,
    roundName: 'Negative Rebuttal',
    side: 'neg',
    content:
      "The Microsoft Japan figure is a frequently misquoted statistic. The actual report measured sales per employee over one month, not productivity, and that month included scheduling anomalies that reduced operating hours regardless. The Svartedalens trial concluded in 2017 and was explicitly not renewed; the municipality cited fiscal infeasibility. The affirmative's '40% of OECD employment in knowledge work' figure is the strongest part of their case, and I concede it for that population. But the resolution is 'overall economic productivity in developed nations.' The remaining 60% of the workforce either sees no benefit, sees cost increases passed through to consumers, or experiences staffing crises in healthcare and education where labor supply is already constrained. The aggregate effect of mandating a four-day workweek is not net-positive; it's net-neutral with significant distributional harm to lower-wage workers.",
  },
  {
    roundNumber: 5,
    roundName: 'Affirmative Closing',
    side: 'aff',
    content:
      "The resolution doesn't require mandating a uniform standard overnight — it asks whether the policy direction improves productivity. The negative has effectively conceded the knowledge-sector case, which already represents the productivity frontier of developed economies. Their objection is implementation friction, not the underlying productivity claim. Where implementation is harder — healthcare, education, frontline services — the response is sector-appropriate adaptation, not refusal. Norway's compressed workweek policies in nursing reduced burnout-driven turnover, which is itself a massive productivity drag. The negative's framing of mandate-or-status-quo is a false binary. The actual policy direction has consistent empirical support across two decades of trials.",
  },
  {
    roundNumber: 6,
    roundName: 'Negative Closing',
    side: 'neg',
    content:
      "The affirmative's closing is a retreat: from 'four-day workweek improves overall productivity' to 'phased, sector-tailored, incentive-aligned policies might, in some places, improve outcomes.' That's not the resolution. The resolution is a substantive policy claim about overall economic productivity, and the evidence simply doesn't support it at the aggregate level. What the evidence does support: knowledge-sector firms can voluntarily shift with neutral or modestly positive results. That is a much weaker claim than the resolution. As a policy direction at national scale, the four-day workweek imposes uneven costs, generates no consistent aggregate productivity gain across the full economy, and risks worsening labor shortages in essential services. The judge should weigh the resolution as stated — not the softened version offered in closing — and find for the negative.",
  },
];

async function setupTestDebate() {
  // Need two agents that exist in the DB. Use the first two from the roster.
  const agents = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });
  if (agents.length < 2) {
    throw new Error('Need at least 2 agents in DB. Run `node src/seed.js` first.');
  }

  const debate = await prisma.debate.create({
    data: {
      topic: TEST_TOPIC,
      status: 'in_progress',
      affAgentId: agents[0].id,
      negAgentId: agents[1].id,
      turns: { create: TURNS },
    },
  });

  return debate.id;
}

async function cleanup() {
  const swept = await prisma.debate.deleteMany({
    where: { topic: { startsWith: 'TEST DEBATE — judge module' } },
  });
  return swept.count;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set in /server/.env');
  }

  console.log('=== Judge test ===');

  const debateId = await setupTestDebate();
  console.log(`Created test debate: ${debateId}`);

  console.log('Running judge (streaming Opus output)...\n');

  const events = [];
  let judgeChars = 0;

  const start = Date.now();
  const { evaluation } = await judgeDebate({
    debateId,
    onEvent: (event) => {
      events.push(event.type);
      if (event.type === 'judge_text_delta') {
        judgeChars += event.text.length;
        if (judgeChars % 100 < event.text.length) process.stdout.write('.');
      } else if (event.type === 'judge_thinking') {
        process.stdout.write('  [judge_thinking]\n');
      } else if (event.type === 'evaluation_complete') {
        process.stdout.write('\n  [evaluation_complete]\n');
      }
    },
  });
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

  console.log('\n--- Verdict ---');
  console.log(`Winner:       ${evaluation.winner}`);
  console.log(`Judge model:  ${evaluation.judgeModel}`);
  console.log(`Aff total:    ${evaluation.affTotal.toFixed(1)}`);
  console.log(`Neg total:    ${evaluation.negTotal.toFixed(1)}`);
  console.log(`Aff scores:   arg=${evaluation.affArgument} ev=${evaluation.affEvidence} resp=${evaluation.affResponsive} pers=${evaluation.affPersuasion}`);
  console.log(`Neg scores:   arg=${evaluation.negArgument} ev=${evaluation.negEvidence} resp=${evaluation.negResponsive} pers=${evaluation.negPersuasion}`);
  console.log(`Elapsed:      ${elapsedSec}s`);
  console.log('\n--- Reasoning (first 600 chars) ---');
  console.log(evaluation.reasoning.slice(0, 600) + (evaluation.reasoning.length > 600 ? '…' : ''));

  // Assertions.
  const fail = (m) => { console.error(`\nFAIL: ${m}`); process.exit(1); };

  // Anonymization sanity: judge's reasoning must NOT mention any agent identity.
  const forbiddenWords = ['claude', 'gpt', 'gemini', 'grok', 'opus', 'sonnet', 'anthropic', 'openai', 'google', 'xai'];
  const reasoningLower = evaluation.reasoning.toLowerCase();
  for (const word of forbiddenWords) {
    if (reasoningLower.includes(word)) {
      fail(`Judge reasoning leaked identity word: "${word}"`);
    }
  }
  console.log('\n✓ Reasoning contains no identity leaks');

  if (!['aff', 'neg', 'draw'].includes(evaluation.winner)) fail(`Invalid winner: ${evaluation.winner}`);
  if (evaluation.judgeModel !== 'claude-opus-4-7') fail(`Wrong judge model: ${evaluation.judgeModel}`);
  if (evaluation.reasoning.length < 200) fail(`Reasoning too short: ${evaluation.reasoning.length}`);

  // Score ranges
  for (const f of ['affArgument', 'affEvidence', 'affResponsive', 'affPersuasion', 'negArgument', 'negEvidence', 'negResponsive', 'negPersuasion']) {
    const v = evaluation[f];
    if (typeof v !== 'number' || v < 0 || v > 10) fail(`${f} out of range: ${v}`);
  }

  // Event sequence
  if (!events.includes('judge_thinking')) fail('Missing judge_thinking event');
  if (events.filter((t) => t === 'judge_text_delta').length === 0) fail('Missing judge_text_delta events');
  if (events.filter((t) => t === 'evaluation_complete').length !== 1) fail('Expected exactly one evaluation_complete');

  console.log('✓ All event types present');

  // DB state
  const finalDebate = await prisma.debate.findUnique({
    where: { id: debateId },
    include: { evaluation: true },
  });
  if (finalDebate.status !== 'completed') fail(`debate.status expected 'completed', got '${finalDebate.status}'`);
  if (finalDebate.winner !== evaluation.winner) fail(`debate.winner mismatch`);
  if (!finalDebate.completedAt) fail('completedAt not set');
  if (!finalDebate.evaluation) fail('Evaluation row not created');

  console.log('✓ DB state correct: status=completed, winner+completedAt set, Evaluation row exists');

  // Idempotency check: running judge again should refuse.
  try {
    await judgeDebate({ debateId, onEvent: () => {} });
    fail('Re-judging a completed debate should have thrown');
  } catch (err) {
    if (!err.message.includes('already completed')) fail(`Re-judge threw wrong error: ${err.message}`);
    console.log('✓ Refuses to re-judge an already-completed debate');
  }
}

(async () => {
  try {
    await main();
    const swept = await cleanup();
    console.log(`\n=== TEST PASSED ===\nCleaned up ${swept} test debate(s).`);
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exitCode = 1;
    try { await cleanup(); } catch {}
  } finally {
    await prisma.$disconnect();
  }
})();
