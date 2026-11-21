-- One price snapshot per minute (playbook Step 11). The oracle stores the minute it belongs to,
-- so a restarted or second oracle cannot store a minute twice.

-- DropIndex
DROP INDEX "price_snapshots_taken_at_idx";

-- CreateIndex
CREATE UNIQUE INDEX "price_snapshots_taken_at_key" ON "price_snapshots"("taken_at");
