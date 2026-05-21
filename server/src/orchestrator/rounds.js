// Round definitions for the simplified Lincoln-Douglas format.
// See /context/DEBATE_FORMAT.md.

export const ROUNDS = [
  { number: 1, name: 'Affirmative Constructive', side: 'aff', wordLimit: 800 },
  { number: 2, name: 'Negative Constructive',    side: 'neg', wordLimit: 800 },
  { number: 3, name: 'Affirmative Rebuttal',     side: 'aff', wordLimit: 700 },
  { number: 4, name: 'Negative Rebuttal',        side: 'neg', wordLimit: 700 },
  { number: 5, name: 'Affirmative Closing',      side: 'aff', wordLimit: 500 },
  { number: 6, name: 'Negative Closing',         side: 'neg', wordLimit: 500 },
];

export const ROUND_DESCRIPTIONS = {
  1: "Open the case FOR the proposition. Lay out your strongest 2–4 arguments. Structure them clearly. Back each with specific evidence — cite sources by name and year when possible. This is the foundation your later turns will defend. Establish the framework you want the debate evaluated against.",

  2: "Open the case AGAINST the proposition. You have two jobs: (1) attack the affirmative's specific arguments that were just presented — name them, identify their weaknesses, undermine the evidence; (2) present your own positive case for why the proposition is wrong. Do both. Lead with whichever is stronger.",

  3: "Defend your affirmative case from the negative's attacks. Address their critiques directly — concede what you must (selectively), defend what you can, counter where they overreach. Then attack their negative case: name their arguments, identify their weaknesses, undermine their evidence. Sharpen the strongest threads from your constructive.",

  4: "Defend your negative case from the affirmative's rebuttal. Address their counter-attacks directly. Then land your final critical attacks on the affirmative case — this is your last chance to dismantle it before closing. Save space for your closing argument.",

  5: "Final summary. Why does the affirmative win this debate? Synthesize your strongest threads. Acknowledge the negative's points only insofar as you can dispatch them. Make the case a thoughtful judge would find compelling. Do not introduce new arguments — argue from what's already been established.",

  6: "Final summary. Why does the negative win this debate? Synthesize your strongest threads. Address the affirmative's closing. Make the case a thoughtful judge would find compelling. Do not introduce new arguments.",
};
