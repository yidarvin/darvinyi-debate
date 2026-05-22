// Standalone judge test for two-leg debates.
//
// Creates a fresh debate with 12 synthetic turns (6 per leg) and runs judgeLeg
// twice — once for leg 1, once for leg 2 — verifying that two evaluations
// are saved with the correct leg field. Does NOT run any debater models —
// turn content is canned. Real Opus call for the judge, ~$0.20-$0.60 per run.
//
// Usage: cd server && node scripts/test-judge.js

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { judgeLeg } from '../src/judge/judgeDebate.js';

const TEST_TOPIC =
  'TEST DEBATE — judge module verification. A four-day workweek would improve overall economic productivity in developed nations.';

// Realistic-enough turn content so the judge has something to chew on.
const LEG_TURNS = [
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
  const agents = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });
  if (agents.length < 2) {
    throw new Error('Need at least 2 agents in DB. Run `node src/seed.js` first.');
  }

  const allTurns = [];
  for (const leg of [1, 2]) {
    for (const t of LEG_TURNS) {
      allTurns.push({ leg, ...t });
    }
  }

  const debate = await prisma.debate.create({
    data: {
      topic: TEST_TOPIC,
      status: 'in_progress',
      agentAId: agents[0].id,
      agentBId: agents[1].id,
      turns: { create: allTurns },
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

  console.log('=== Judge test (two legs) ===');

  const debateId = await setupTestDebate();
  console.log(`Created test debate: ${debateId}`);

  const fail = (m) => { console.error(`\nFAIL: ${m}`); process.exit(1); };

  for (const leg of [1, 2]) {
    console.log(`\n--- Judging leg ${leg} (streaming Opus output) ---\n`);

    const events = [];
    let judgeChars = 0;

    const start = Date.now();
    const { evaluation } = await judgeLeg({
      debateId,
      leg,
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === 'judge_text_delta') {
          judgeChars += event.text.length;
          if (judgeChars % 100 < event.text.length) process.stdout.write('.');
        } else if (event.type === 'judge_thinking') {
          process.stdout.write(`  [judge_thinking leg=${event.leg}]\n`);
        } else if (event.type === 'evaluation_complete') {
          process.stdout.write(`\n  [evaluation_complete leg=${event.leg}]\n`);
        }
      },
    });
    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\nVerdict leg ${leg}: winner=${evaluation.winner}, affTotal=${evaluation.affTotal.toFixed(1)}, negTotal=${evaluation.negTotal.toFixed(1)} (${elapsedSec}s)`);

    if (evaluation.leg !== leg) fail(`evaluation.leg expected ${leg}, got ${evaluation.leg}`);
    if (!['aff', 'neg', 'draw'].includes(evaluation.winner)) fail(`Invalid winner: ${evaluation.winner}`);
    if (evaluation.judgeModel !== 'claude-opus-4-7') fail(`Wrong judge model: ${evaluation.judgeModel}`);
    if (evaluation.reasoning.length < 200) fail(`Reasoning too short: ${evaluation.reasoning.length}`);

    const forbiddenWords = ['claude', 'gpt', 'gemini', 'grok', 'opus', 'sonnet', 'anthropic', 'openai', 'google', 'xai'];
    const reasoningLower = evaluation.reasoning.toLowerCase();
    for (const word of forbiddenWords) {
      if (reasoningLower.includes(word)) {
        fail(`Leg ${leg} judge reasoning leaked identity word: "${word}"`);
      }
    }

    if (!events.includes('judge_thinking')) fail(`Leg ${leg}: Missing judge_thinking event`);
    if (events.filter((t) => t === 'judge_text_delta').length === 0) fail(`Leg ${leg}: Missing judge_text_delta events`);
    if (events.filter((t) => t === 'evaluation_complete').length !== 1) fail(`Leg ${leg}: Expected exactly one evaluation_complete`);
  }

  console.log('\n✓ Both legs judged with identity-clean reasoning and proper events');

  // DB state
  const finalDebate = await prisma.debate.findUnique({
    where: { id: debateId },
    include: { evaluations: { orderBy: { leg: 'asc' } } },
  });

  if (finalDebate.evaluations.length !== 2) fail(`Expected 2 evaluations, got ${finalDebate.evaluations.length}`);
  if (finalDebate.evaluations[0].leg !== 1) fail(`First evaluation leg should be 1`);
  if (finalDebate.evaluations[1].leg !== 2) fail(`Second evaluation leg should be 2`);
  // Note: judgeLeg does NOT transition status — the SSE wrapper does after ELO.
  if (finalDebate.status !== 'in_progress') fail(`debate.status should still be 'in_progress' (judge doesn't transition), got '${finalDebate.status}'`);

  console.log('✓ DB state correct: 2 evaluations with leg=1 and leg=2');

  // Idempotency
  try {
    await judgeLeg({ debateId, leg: 1, onEvent: () => {} });
    fail('Re-judging leg 1 should have thrown');
  } catch (err) {
    if (!err.message.includes('already has an evaluation')) fail(`Re-judge threw wrong error: ${err.message}`);
    console.log('✓ Refuses to re-judge an already-judged leg');
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
