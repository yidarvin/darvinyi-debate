-- DropForeignKey
ALTER TABLE "Debate" DROP CONSTRAINT "Debate_affAgentId_fkey";

-- DropForeignKey
ALTER TABLE "Debate" DROP CONSTRAINT "Debate_negAgentId_fkey";

-- DropIndex
DROP INDEX "DebateTurn_debateId_roundNumber_idx";

-- DropIndex
DROP INDEX "Evaluation_debateId_key";

-- AlterTable
ALTER TABLE "Debate" DROP COLUMN "affAgentId",
DROP COLUMN "negAgentId",
ADD COLUMN     "agentAId" TEXT NOT NULL,
ADD COLUMN     "agentBId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DebateTurn" ADD COLUMN     "leg" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Evaluation" ADD COLUMN     "leg" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "DebateTurn_debateId_leg_roundNumber_idx" ON "DebateTurn"("debateId", "leg", "roundNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DebateTurn_debateId_leg_roundNumber_key" ON "DebateTurn"("debateId", "leg", "roundNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Evaluation_debateId_leg_key" ON "Evaluation"("debateId", "leg");

-- AddForeignKey
ALTER TABLE "Debate" ADD CONSTRAINT "Debate_agentAId_fkey" FOREIGN KEY ("agentAId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Debate" ADD CONSTRAINT "Debate_agentBId_fkey" FOREIGN KEY ("agentBId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
