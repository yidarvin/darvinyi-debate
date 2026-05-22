-- AlterTable
ALTER TABLE "Evaluation" ADD COLUMN     "humanAgreedWithJudge" BOOLEAN,
ADD COLUMN     "humanVotedAt" TIMESTAMP(3),
ADD COLUMN     "humanWinner" TEXT;
