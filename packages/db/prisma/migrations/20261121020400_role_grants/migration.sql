-- Database roles (playbook Step 3). The roles themselves are created outside migrations:
-- by `pnpm db:roles` in dev and CI, and by Terraform in staging and production. This migration
-- runs as reef_migrator, which owns every object.
--   reef_migrator  DDL; runs migrations
--   reef_app       DML; what every app connects as; no UPDATE/DELETE on append-only tables
--   reef_readonly  SELECT only; analysts and reporting

GRANT USAGE ON SCHEMA public TO reef_app, reef_readonly;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reef_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reef_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reef_readonly;

-- Append-only tables: defence in depth on top of the triggers.
REVOKE UPDATE, DELETE, TRUNCATE ON "journals", "ledger_entries", "audit_logs" FROM reef_app;

-- Migration history belongs to the migrator alone.
REVOKE ALL ON "_prisma_migrations" FROM reef_app, reef_readonly;

-- Tables created by later migrations get the same grants. A later append-only table must
-- REVOKE UPDATE, DELETE, TRUNCATE from reef_app in its own migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reef_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO reef_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reef_readonly;
