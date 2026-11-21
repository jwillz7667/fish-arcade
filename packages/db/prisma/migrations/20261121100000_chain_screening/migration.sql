-- Chain screening (playbook Step 12, spec §15, §22): versioned OFAC SDN imports and the
-- account freeze hold.

-- AlterEnum
ALTER TYPE "AccountHoldKind" ADD VALUE 'freeze';

-- CreateTable
CREATE TABLE "ofac_imports" (
    "list_version" TEXT NOT NULL,
    "publish_date" DATE NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "address_count" INTEGER NOT NULL,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ofac_imports_pkey" PRIMARY KEY ("list_version")
);

-- CreateIndex
CREATE UNIQUE INDEX "ofac_imports_sha256_key" ON "ofac_imports"("sha256");

-- CreateIndex
CREATE INDEX "ofac_imports_imported_at_idx" ON "ofac_imports"("imported_at");

-- AddForeignKey
ALTER TABLE "ofac_addresses" ADD CONSTRAINT "ofac_addresses_list_version_fkey" FOREIGN KEY ("list_version") REFERENCES "ofac_imports"("list_version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Imported lists and screening history are evidence: the app adds rows and never rewrites them.
-- The only change it may make is moving an import's checked_at forward.
REVOKE UPDATE, DELETE, TRUNCATE ON "ofac_imports", "ofac_addresses", "chain_screenings" FROM reef_app;
GRANT UPDATE ("checked_at") ON "ofac_imports" TO reef_app;
