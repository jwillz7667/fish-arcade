-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('GC', 'SC');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high', 'severe');

-- CreateEnum
CREATE TYPE "BitcoinNetwork" AS ENUM ('regtest', 'signet', 'mainnet');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'closed', 'self_excluded');

-- CreateEnum
CREATE TYPE "KycLevel" AS ENUM ('light', 'full');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('pending', 'passed', 'failed', 'review', 'sanctions_hit');

-- CreateEnum
CREATE TYPE "GeoContext" AS ENUM ('signup', 'login', 'purchase', 'play_sc', 'redeem');

-- CreateEnum
CREATE TYPE "GeoResult" AS ENUM ('allowed', 'blocked', 'error');

-- CreateEnum
CREATE TYPE "JurisdictionMode" AS ENUM ('S', 'P', 'X');

-- CreateEnum
CREATE TYPE "LedgerOwnerType" AS ENUM ('player', 'session', 'house', 'jackpot', 'redemption');

-- CreateEnum
CREATE TYPE "LedgerAccountKind" AS ENUM ('GC', 'SC_bonus', 'SC_redeemable', 'session_escrow', 'GC_issued', 'SC_promo', 'game_result', 'jackpot_pool', 'redemption_pending', 'redemption_paid');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('pending', 'paid', 'expired', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "RedemptionMethod" AS ENUM ('btc');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('requested', 'review', 'approved', 'rejected', 'processing', 'paid', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AmoeChannel" AS ENUM ('mail', 'online');

-- CreateEnum
CREATE TYPE "AmoeStatus" AS ENUM ('received', 'granted', 'rejected');

-- CreateEnum
CREATE TYPE "BonusGrantStatus" AS ENUM ('active', 'completed', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "GameType" AS ENUM ('fish', 'slot', 'keno');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('draft', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('open', 'maintenance', 'closed');

-- CreateEnum
CREATE TYPE "JackpotStatus" AS ENUM ('active', 'hit', 'paused');

-- CreateEnum
CREATE TYPE "AffiliateStatus" AS ENUM ('pending', 'active', 'suspended', 'closed');

-- CreateEnum
CREATE TYPE "AffiliateDealType" AS ENUM ('cpa', 'revshare', 'hybrid');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('pending', 'approved', 'paid', 'void');

-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired', 'executed');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('player', 'admin', 'system');

-- CreateEnum
CREATE TYPE "RgLimitType" AS ENUM ('deposit', 'loss', 'wager', 'session_time');

-- CreateEnum
CREATE TYPE "RgLimitPeriod" AS ENUM ('day', 'week', 'month');

-- CreateEnum
CREATE TYPE "ExclusionType" AS ENUM ('timeout', 'self_exclusion');

-- CreateEnum
CREATE TYPE "AmlSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "AmlAlertStatus" AS ENUM ('open', 'investigating', 'escalated', 'closed');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('open', 'pending', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "BtcInvoiceStatus" AS ENUM ('new', 'processing', 'settled', 'expired', 'invalid');

-- CreateEnum
CREATE TYPE "BtcDepositStatus" AS ENUM ('seen', 'confirmed', 'credited', 'held', 'frozen');

-- CreateEnum
CREATE TYPE "PayoutAddressType" AS ENUM ('p2wpkh', 'p2tr', 'p2wsh', 'p2sh', 'p2pkh');

-- CreateEnum
CREATE TYPE "PayoutAddressStatus" AS ENUM ('pending', 'active', 'rejected', 'disabled');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('queued', 'held', 'batched', 'broadcast', 'confirmed', 'failed');

-- CreateEnum
CREATE TYPE "PayoutBatchStatus" AS ENUM ('building', 'signed', 'broadcast', 'confirmed', 'failed');

-- CreateEnum
CREATE TYPE "ScreeningSubjectType" AS ENUM ('address', 'tx');

-- CreateEnum
CREATE TYPE "TreasuryEventType" AS ENUM ('refill_request', 'refill_done', 'sweep_to_cold');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email_enc" TEXT,
    "email_bidx" TEXT,
    "phone_enc" TEXT,
    "phone_bidx" TEXT,
    "password_hash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "user_id" UUID NOT NULL,
    "display_name" VARCHAR(32) NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "dob_enc" TEXT,
    "address_line1_enc" TEXT,
    "city_enc" TEXT,
    "state_code" CHAR(2),
    "zip_enc" TEXT,
    "vip_level" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fingerprint_hash" TEXT NOT NULL,
    "first_seen" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_devices" (
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("user_id","device_id")
);

-- CreateTable
CREATE TABLE "kyc_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "level" "KycLevel" NOT NULL,
    "vendor" TEXT NOT NULL,
    "vendor_ref" TEXT NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'pending',
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geo_checks" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID,
    "context" "GeoContext" NOT NULL,
    "ip" INET NOT NULL,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "state_code" CHAR(2),
    "vpn_flag" BOOLEAN NOT NULL,
    "result" "GeoResult" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "geo_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jurisdictions" (
    "state_code" CHAR(2) NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "mode" "JurisdictionMode" NOT NULL,
    "min_age" INTEGER NOT NULL,
    "sc_redemption_enabled" BOOLEAN NOT NULL,
    "fish_games_enabled" BOOLEAN NOT NULL,
    "legal_memo_ref" TEXT NOT NULL,

    CONSTRAINT "jurisdictions_pkey" PRIMARY KEY ("state_code","effective_from")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "owner_type" "LedgerOwnerType" NOT NULL,
    "owner_id" UUID,
    "currency" "Currency" NOT NULL,
    "kind" "LedgerAccountKind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" VARCHAR(64) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "ref_type" VARCHAR(64),
    "ref_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "journal_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balances" (
    "account_id" UUID NOT NULL,
    "owner_type" "LedgerOwnerType" NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "price_cents" BIGINT NOT NULL,
    "gc_amount" BIGINT NOT NULL,
    "sc_bonus" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "sc_amount" BIGINT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "method" "RedemptionMethod" NOT NULL,
    "payout_ref" TEXT,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'requested',
    "reviewer_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amoe_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "channel" "AmoeChannel" NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "sc_granted" BIGINT,
    "status" "AmoeStatus" NOT NULL DEFAULT 'received',
    "envelope_ref" TEXT,

    CONSTRAINT "amoe_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "budget" BIGINT,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bonus_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "promotion_id" UUID,
    "currency" "Currency" NOT NULL,
    "amount" BIGINT NOT NULL,
    "playthrough_multiple" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3),
    "status" "BonusGrantStatus" NOT NULL DEFAULT 'active',

    CONSTRAINT "bonus_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "type" "GameType" NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'draft',

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "math_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "game_type" "GameType" NOT NULL,
    "base_rtp_bp" INTEGER NOT NULL,
    "jackpot_bp" INTEGER NOT NULL,
    "params" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "cert_ref" TEXT,

    CONSTRAINT "math_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "game_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "math_config_id" UUID NOT NULL,
    "bundle_url" TEXT NOT NULL,
    "asset_hash" TEXT NOT NULL,

    CONSTRAINT "game_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "game_id" UUID NOT NULL,
    "tier" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "bet_levels" BIGINT[],
    "math_config_id" UUID NOT NULL,
    "seats" INTEGER NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'open',

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "buy_in" BIGINT NOT NULL,
    "bets_total" BIGINT NOT NULL DEFAULT 0,
    "wins_total" BIGINT NOT NULL DEFAULT 0,
    "final_balance" BIGINT,
    "last_checkpoint_seq" BIGINT NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_archive_index" (
    "session_id" UUID NOT NULL,
    "seq_start" BIGINT NOT NULL,
    "seq_end" BIGINT NOT NULL,
    "object_key" TEXT NOT NULL,

    CONSTRAINT "round_archive_index_pkey" PRIMARY KEY ("session_id","seq_start")
);

-- CreateTable
CREATE TABLE "jackpots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tier" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "seed" BIGINT NOT NULL,
    "cap" BIGINT NOT NULL,
    "current" BIGINT NOT NULL,
    "hit_point_hash" TEXT NOT NULL,
    "hit_point" BIGINT,
    "status" "JackpotStatus" NOT NULL DEFAULT 'active',
    "reset_at" TIMESTAMPTZ(3),

    CONSTRAINT "jackpots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jackpot_wins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "jackpot_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jackpot_wins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_id" UUID,
    "code" TEXT NOT NULL,
    "status" "AffiliateStatus" NOT NULL DEFAULT 'pending',
    "deal_type" "AffiliateDealType" NOT NULL,
    "revshare_bp" INTEGER,
    "cpa_cents" BIGINT,

    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "user_id" UUID NOT NULL,
    "affiliate_id" UUID NOT NULL,
    "click_id" TEXT,
    "attributed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "commissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "affiliate_id" UUID NOT NULL,
    "period" CHAR(7) NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'pending',

    CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "AdminUserStatus" NOT NULL DEFAULT 'active',

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_user_roles" (
    "admin_user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "admin_user_roles_pkey" PRIMARY KEY ("admin_user_id","role_id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requested_by" UUID NOT NULL,
    "approved_by" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rg_limits" (
    "user_id" UUID NOT NULL,
    "type" "RgLimitType" NOT NULL,
    "period" "RgLimitPeriod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "pending_increase_at" TIMESTAMPTZ(3),

    CONSTRAINT "rg_limits_pkey" PRIMARY KEY ("user_id","type","period")
);

-- CreateTable
CREATE TABLE "exclusions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "ExclusionType" NOT NULL,
    "until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aml_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" "AmlSeverity" NOT NULL,
    "status" "AmlAlertStatus" NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aml_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rules_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doc_type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rules_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "user_id" UUID NOT NULL,
    "rules_version_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" INET NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("user_id","rules_version_id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'open',
    "assignee_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "btc_invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purchase_id" UUID NOT NULL,
    "btcpay_invoice_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "rate_cents_per_btc" BIGINT NOT NULL,
    "btc_due_sats" BIGINT NOT NULL,
    "status" "BtcInvoiceStatus" NOT NULL DEFAULT 'new',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "settled_at" TIMESTAMPTZ(3),

    CONSTRAINT "btc_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "btc_deposits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "txid" CHAR(64) NOT NULL,
    "vout" INTEGER NOT NULL,
    "sats" BIGINT NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "risk_level" "RiskLevel",
    "status" "BtcDepositStatus" NOT NULL DEFAULT 'seen',

    CONSTRAINT "btc_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_addresses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "address_enc" TEXT NOT NULL,
    "address_bidx" TEXT NOT NULL,
    "address_type" "PayoutAddressType" NOT NULL,
    "network" "BitcoinNetwork" NOT NULL,
    "status" "PayoutAddressStatus" NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMPTZ(3),
    "usable_after" TIMESTAMPTZ(3),
    "last_screened_at" TIMESTAMPTZ(3),
    "risk_level" "RiskLevel",

    CONSTRAINT "payout_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "redemption_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "rate_cents_per_btc" BIGINT,
    "sats" BIGINT,
    "batch_id" UUID,
    "status" "PayoutStatus" NOT NULL DEFAULT 'queued',

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "txid" CHAR(64),
    "fee_sats" BIGINT,
    "fee_rate_sat_vb" DECIMAL(12,3),
    "status" "PayoutBatchStatus" NOT NULL DEFAULT 'building',
    "broadcast_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "rbf_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "cents_per_btc" BIGINT NOT NULL,
    "sources" JSONB NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_screenings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_type" "ScreeningSubjectType" NOT NULL,
    "subject" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "risk_level" "RiskLevel" NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sanctioned" BOOLEAN NOT NULL,
    "screened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_screenings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ofac_addresses" (
    "address" TEXT NOT NULL,
    "list_version" TEXT NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ofac_addresses_pkey" PRIMARY KEY ("address","list_version")
);

-- CreateTable
CREATE TABLE "treasury_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "TreasuryEventType" NOT NULL,
    "sats" BIGINT NOT NULL,
    "txid" CHAR(64),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_flags" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_flags_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_bidx_key" ON "users"("email_bidx");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_bidx_key" ON "users"("phone_bidx");

-- CreateIndex
CREATE UNIQUE INDEX "devices_fingerprint_hash_key" ON "devices"("fingerprint_hash");

-- CreateIndex
CREATE INDEX "user_devices_device_id_idx" ON "user_devices"("device_id");

-- CreateIndex
CREATE INDEX "kyc_checks_user_id_created_at_idx" ON "kyc_checks"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_checks_vendor_vendor_ref_key" ON "kyc_checks"("vendor", "vendor_ref");

-- CreateIndex
CREATE INDEX "geo_checks_user_id_created_at_idx" ON "geo_checks"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE INDEX "ledger_accounts_owner_type_owner_id_idx" ON "ledger_accounts"("owner_type", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_id_owner_type_key" ON "ledger_accounts"("id", "owner_type");

-- CreateIndex
CREATE UNIQUE INDEX "journals_idempotency_key_key" ON "journals"("idempotency_key");

-- CreateIndex
CREATE INDEX "journals_ref_type_ref_id_idx" ON "journals"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "ledger_entries_journal_id_idx" ON "ledger_entries"("journal_id");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_id_idx" ON "ledger_entries"("account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "balances_account_id_owner_type_key" ON "balances"("account_id", "owner_type");

-- CreateIndex
CREATE INDEX "purchases_user_id_created_at_idx" ON "purchases"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "redemptions_user_id_created_at_idx" ON "redemptions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "redemptions_status_created_at_idx" ON "redemptions"("status", "created_at");

-- CreateIndex
CREATE INDEX "amoe_requests_user_id_received_at_idx" ON "amoe_requests"("user_id", "received_at");

-- CreateIndex
CREATE INDEX "bonus_grants_user_id_status_idx" ON "bonus_grants"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "games_slug_key" ON "games"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "math_configs_hash_key" ON "math_configs"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "game_versions_game_id_version_key" ON "game_versions"("game_id", "version");

-- CreateIndex
CREATE INDEX "rooms_game_id_status_idx" ON "rooms"("game_id", "status");

-- CreateIndex
CREATE INDEX "table_sessions_user_id_started_at_idx" ON "table_sessions"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "table_sessions_room_id_ended_at_idx" ON "table_sessions"("room_id", "ended_at");

-- CreateIndex
CREATE UNIQUE INDEX "jackpots_tier_currency_key" ON "jackpots"("tier", "currency");

-- CreateIndex
CREATE INDEX "jackpot_wins_jackpot_id_created_at_idx" ON "jackpot_wins"("jackpot_id", "created_at");

-- CreateIndex
CREATE INDEX "jackpot_wins_user_id_idx" ON "jackpot_wins"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_code_key" ON "affiliates"("code");

-- CreateIndex
CREATE INDEX "affiliates_parent_id_idx" ON "affiliates"("parent_id");

-- CreateIndex
CREATE INDEX "referrals_affiliate_id_idx" ON "referrals"("affiliate_id");

-- CreateIndex
CREATE UNIQUE INDEX "commissions_affiliate_id_period_key" ON "commissions"("affiliate_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "admin_user_roles_role_id_idx" ON "admin_user_roles"("role_id");

-- CreateIndex
CREATE INDEX "approvals_status_expires_at_idx" ON "approvals"("status", "expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_created_at_idx" ON "audit_logs"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_actor_id_created_at_idx" ON "audit_logs"("actor_type", "actor_id", "created_at");

-- CreateIndex
CREATE INDEX "exclusions_user_id_until_idx" ON "exclusions"("user_id", "until");

-- CreateIndex
CREATE INDEX "aml_alerts_status_severity_created_at_idx" ON "aml_alerts"("status", "severity", "created_at");

-- CreateIndex
CREATE INDEX "aml_alerts_user_id_idx" ON "aml_alerts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "rules_versions_doc_type_version_key" ON "rules_versions"("doc_type", "version");

-- CreateIndex
CREATE INDEX "support_tickets_status_created_at_idx" ON "support_tickets"("status", "created_at");

-- CreateIndex
CREATE INDEX "support_tickets_user_id_idx" ON "support_tickets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "btc_invoices_purchase_id_key" ON "btc_invoices"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "btc_invoices_btcpay_invoice_id_key" ON "btc_invoices"("btcpay_invoice_id");

-- CreateIndex
CREATE INDEX "btc_invoices_status_expires_at_idx" ON "btc_invoices"("status", "expires_at");

-- CreateIndex
CREATE INDEX "btc_deposits_invoice_id_idx" ON "btc_deposits"("invoice_id");

-- CreateIndex
CREATE INDEX "btc_deposits_status_idx" ON "btc_deposits"("status");

-- CreateIndex
CREATE UNIQUE INDEX "btc_deposits_txid_vout_key" ON "btc_deposits"("txid", "vout");

-- CreateIndex
CREATE INDEX "payout_addresses_address_bidx_idx" ON "payout_addresses"("address_bidx");

-- CreateIndex
CREATE UNIQUE INDEX "payout_addresses_user_id_address_bidx_key" ON "payout_addresses"("user_id", "address_bidx");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_redemption_id_key" ON "payouts"("redemption_id");

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payouts"("status");

-- CreateIndex
CREATE INDEX "payouts_batch_id_idx" ON "payouts"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_batches_txid_key" ON "payout_batches"("txid");

-- CreateIndex
CREATE INDEX "payout_batches_status_idx" ON "payout_batches"("status");

-- CreateIndex
CREATE INDEX "price_snapshots_taken_at_idx" ON "price_snapshots"("taken_at");

-- CreateIndex
CREATE INDEX "chain_screenings_subject_type_subject_screened_at_idx" ON "chain_screenings"("subject_type", "subject", "screened_at");

-- CreateIndex
CREATE INDEX "ofac_addresses_address_idx" ON "ofac_addresses"("address");

-- CreateIndex
CREATE INDEX "treasury_events_type_created_at_idx" ON "treasury_events"("type", "created_at");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_checks" ADD CONSTRAINT "kyc_checks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_checks" ADD CONSTRAINT "geo_checks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_account_id_owner_type_fkey" FOREIGN KEY ("account_id", "owner_type") REFERENCES "ledger_accounts"("id", "owner_type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amoe_requests" ADD CONSTRAINT "amoe_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_grants" ADD CONSTRAINT "bonus_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_grants" ADD CONSTRAINT "bonus_grants_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_versions" ADD CONSTRAINT "game_versions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_versions" ADD CONSTRAINT "game_versions_math_config_id_fkey" FOREIGN KEY ("math_config_id") REFERENCES "math_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_math_config_id_fkey" FOREIGN KEY ("math_config_id") REFERENCES "math_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_archive_index" ADD CONSTRAINT "round_archive_index_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jackpot_wins" ADD CONSTRAINT "jackpot_wins_jackpot_id_fkey" FOREIGN KEY ("jackpot_id") REFERENCES "jackpots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jackpot_wins" ADD CONSTRAINT "jackpot_wins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jackpot_wins" ADD CONSTRAINT "jackpot_wins_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "affiliates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rg_limits" ADD CONSTRAINT "rg_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exclusions" ADD CONSTRAINT "exclusions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_alerts" ADD CONSTRAINT "aml_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_rules_version_id_fkey" FOREIGN KEY ("rules_version_id") REFERENCES "rules_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "btc_invoices" ADD CONSTRAINT "btc_invoices_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "btc_deposits" ADD CONSTRAINT "btc_deposits_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "btc_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_addresses" ADD CONSTRAINT "payout_addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_redemption_id_fkey" FOREIGN KEY ("redemption_id") REFERENCES "redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "payout_addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
