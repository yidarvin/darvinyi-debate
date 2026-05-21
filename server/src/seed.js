// Idempotent agent seed.
//
// Runs on every Railway deploy (via the root start script:
//   "cd server && npx prisma migrate deploy && node src/seed.js && node src/index.js")
//
// Rules:
//   - On first run: creates all roster agents at default ELO (1200) and zero stats.
//   - On subsequent runs:
//       - Identity fields (displayName, provider, modelId) are updated if they
//         differ from the spec. This allows fixing typos or model renames.
//       - Stats fields (elo, wins, losses, draws, createdAt) are NEVER touched
//         on existing rows. ELO history is preserved across deploys.
//   - Roster is defined inline here. See /context/AGENT_SPEC.md for the canonical
//     spec — this list must mirror that table.

import 'dotenv/config';
import { prisma } from './db.js';

const ROSTER = [
  { id: 'claude-opus-4-7',   displayName: 'Claude Opus 4.7',   provider: 'anthropic', modelId: 'claude-opus-4-7'   },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
  { id: 'gpt-5',             displayName: 'GPT-5',             provider: 'openai',    modelId: 'gpt-5'             },
  { id: 'gemini-2-5-pro',    displayName: 'Gemini 2.5 Pro',    provider: 'google',    modelId: 'gemini-2.5-pro'    },
  { id: 'grok-4',            displayName: 'Grok 4',            provider: 'xai',       modelId: 'grok-4'            },
];

async function seed() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed] DATABASE_URL is not set. Ensure /server/.env is configured and you are running from /server.');
    process.exit(1);
  }

  console.log('[seed] Starting agent seeding...');

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const agent of ROSTER) {
    const existing = await prisma.agent.findUnique({ where: { id: agent.id } });

    if (!existing) {
      await prisma.agent.create({ data: agent });
      console.log(`[seed]   + created   ${agent.id}`);
      created++;
      continue;
    }

    const identityChanged =
      existing.displayName !== agent.displayName ||
      existing.provider !== agent.provider ||
      existing.modelId !== agent.modelId;

    if (identityChanged) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          displayName: agent.displayName,
          provider: agent.provider,
          modelId: agent.modelId,
        },
      });
      console.log(`[seed]   ~ updated   ${agent.id} (identity changed; stats preserved)`);
      updated++;
    } else {
      console.log(`[seed]   = unchanged ${agent.id}`);
      unchanged++;
    }
  }

  console.log(`[seed] Done. created=${created} updated=${updated} unchanged=${unchanged} total=${ROSTER.length}`);
}

seed()
  .catch((err) => {
    console.error('[seed] FAILED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
