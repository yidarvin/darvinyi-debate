-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "elo" DOUBLE PRECISION NOT NULL DEFAULT 1200,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Debate" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "affAgentId" TEXT NOT NULL,
    "negAgentId" TEXT NOT NULL,
    "winner" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Debate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebateTurn" (
    "id" TEXT NOT NULL,
    "debateId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "roundName" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebateTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "debateId" TEXT NOT NULL,
    "winner" TEXT NOT NULL,
    "affArgument" DOUBLE PRECISION NOT NULL,
    "affEvidence" DOUBLE PRECISION NOT NULL,
    "affResponsive" DOUBLE PRECISION NOT NULL,
    "affPersuasion" DOUBLE PRECISION NOT NULL,
    "affTotal" DOUBLE PRECISION NOT NULL,
    "negArgument" DOUBLE PRECISION NOT NULL,
    "negEvidence" DOUBLE PRECISION NOT NULL,
    "negResponsive" DOUBLE PRECISION NOT NULL,
    "negPersuasion" DOUBLE PRECISION NOT NULL,
    "negTotal" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT NOT NULL,
    "judgeModel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EloChange" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "debateId" TEXT NOT NULL,
    "before" DOUBLE PRECISION NOT NULL,
    "after" DOUBLE PRECISION NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EloChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Debate_createdAt_idx" ON "Debate"("createdAt");

-- CreateIndex
CREATE INDEX "Debate_status_idx" ON "Debate"("status");

-- CreateIndex
CREATE INDEX "Debate_completedAt_idx" ON "Debate"("completedAt");

-- CreateIndex
CREATE INDEX "DebateTurn_debateId_roundNumber_idx" ON "DebateTurn"("debateId", "roundNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Evaluation_debateId_key" ON "Evaluation"("debateId");

-- CreateIndex
CREATE INDEX "EloChange_agentId_createdAt_idx" ON "EloChange"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "EloChange_debateId_idx" ON "EloChange"("debateId");

-- AddForeignKey
ALTER TABLE "Debate" ADD CONSTRAINT "Debate_affAgentId_fkey" FOREIGN KEY ("affAgentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Debate" ADD CONSTRAINT "Debate_negAgentId_fkey" FOREIGN KEY ("negAgentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebateTurn" ADD CONSTRAINT "DebateTurn_debateId_fkey" FOREIGN KEY ("debateId") REFERENCES "Debate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_debateId_fkey" FOREIGN KEY ("debateId") REFERENCES "Debate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EloChange" ADD CONSTRAINT "EloChange_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EloChange" ADD CONSTRAINT "EloChange_debateId_fkey" FOREIGN KEY ("debateId") REFERENCES "Debate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
