-- Back office SSO identity (playbook Step 9 review): bind each admin to the IdP's (issuer,
-- subject) at the first SSO login. An IdP can let an email change hands; the subject cannot.

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "oidc_issuer" TEXT,
ADD COLUMN     "oidc_subject" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_oidc_issuer_oidc_subject_key" ON "admin_users"("oidc_issuer", "oidc_subject");

-- Both or neither: a subject means nothing without its issuer.
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_oidc_identity_complete"
  CHECK (("oidc_issuer" IS NULL) = ("oidc_subject" IS NULL));
