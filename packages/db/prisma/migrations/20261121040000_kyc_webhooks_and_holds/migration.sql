-- KYC webhooks and account holds (playbook Step 8, spec §5.1, §15). Grants come from the default
-- privileges in 20261121020400_role_grants.

-- CreateEnum
CREATE TYPE "AccountHoldKind" AS ENUM ('redemption');

-- CreateTable
CREATE TABLE "processed_webhooks" (
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhooks_pkey" PRIMARY KEY ("provider","event_id")
);

-- CreateTable
CREATE TABLE "account_holds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" "AccountHoldKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),
    "released_by" UUID,

    CONSTRAINT "account_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_holds_user_id_kind_idx" ON "account_holds"("user_id", "kind");

-- AddForeignKey
ALTER TABLE "account_holds" ADD CONSTRAINT "account_holds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A released hold names who released it, and only a released hold does.
ALTER TABLE "account_holds" ADD CONSTRAINT "account_holds_release_check"
  CHECK (("released_at" IS NULL) = ("released_by" IS NULL));

-- Active holds are what every redemption checks.
CREATE INDEX "account_holds_active_idx" ON "account_holds" ("user_id", "kind")
  WHERE "released_at" IS NULL;

-- The dedupe record is evidence that an event was acted on: the app may add rows, never change
-- or remove them.
REVOKE UPDATE, DELETE, TRUNCATE ON "processed_webhooks" FROM reef_app;
