-- Clearing a false-positive sanctions hit (playbook Step 9 review, spec §15). Two Compliance
-- officers approve the clearance through the four-eyes approvals; the vendor's verdict stays
-- recorded as sanctions_hit.

-- AlterTable
ALTER TABLE "kyc_checks" ADD COLUMN     "sanctions_cleared_at" TIMESTAMPTZ(3),
ADD COLUMN     "sanctions_cleared_by" UUID;

-- AddForeignKey
ALTER TABLE "kyc_checks" ADD CONSTRAINT "kyc_checks_sanctions_cleared_by_fkey" FOREIGN KEY ("sanctions_cleared_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Only a sanctions hit can be cleared, and a clearance always names when.
ALTER TABLE "kyc_checks" ADD CONSTRAINT "kyc_checks_clearance_is_for_sanctions_hit"
  CHECK ("sanctions_cleared_at" IS NULL OR "status" = 'sanctions_hit');
ALTER TABLE "kyc_checks" ADD CONSTRAINT "kyc_checks_clearer_has_time"
  CHECK ("sanctions_cleared_by" IS NULL OR "sanctions_cleared_at" IS NOT NULL);
