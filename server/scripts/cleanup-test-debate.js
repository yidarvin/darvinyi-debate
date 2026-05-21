// Deletes all debates with topics starting with "TEST DEBATE — ".
// onDelete: Cascade in the schema means turns, evaluation, and eloChanges
// are removed automatically.

import 'dotenv/config';
import { prisma } from '../src/db.js';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[cleanup-test-debate] DATABASE_URL not set.');
    process.exit(1);
  }

  const result = await prisma.debate.deleteMany({
    where: { topic: { startsWith: 'TEST DEBATE — ' } },
  });

  console.log(`[cleanup-test-debate] Deleted ${result.count} test debate(s).`);
}

main()
  .catch((err) => {
    console.error('[cleanup-test-debate] FAILED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
