CREATE TABLE "currency_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"family_id" uuid,
	"code" text,
	"balance" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "currency_accounts_family_unique" UNIQUE("family_id"),
	CONSTRAINT "currency_accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "currency_accounts_kind_check" CHECK ("currency_accounts"."kind" in ('family_treasury', 'system')),
	CONSTRAINT "currency_accounts_owner_check" CHECK (("currency_accounts"."kind" = 'family_treasury' and "currency_accounts"."family_id" is not null and "currency_accounts"."code" is null) or ("currency_accounts"."kind" = 'system' and "currency_accounts"."code" is not null and "currency_accounts"."family_id" is null)),
	CONSTRAINT "currency_accounts_balance_check" CHECK ("currency_accounts"."balance" >= 0 or "currency_accounts"."kind" = 'system')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint,
	"reason" text NOT NULL,
	CONSTRAINT "ledger_entries_amount_check" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_player_id" uuid,
	"ref_type" text,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('grant', 'territory_claim', 'upkeep', 'disband'))
);
--> statement-breakpoint
CREATE TABLE "territory_ownership_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"territory_id" uuid NOT NULL,
	"from_family_id" uuid,
	"to_family_id" uuid,
	"cause" text NOT NULL,
	"actor_player_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "territory_ownership_history_cause_check" CHECK ("territory_ownership_history"."cause" in ('claim', 'abandon', 'lapsed', 'disband'))
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "territories" ADD COLUMN "owned_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "territories" ADD COLUMN "upkeep_paid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "territories" ADD COLUMN "state" text DEFAULT 'stable' NOT NULL;--> statement-breakpoint
ALTER TABLE "territories" ADD COLUMN "last_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "currency_accounts" ADD CONSTRAINT "currency_accounts_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_currency_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."currency_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_actor_player_id_players_id_fk" FOREIGN KEY ("actor_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territory_ownership_history" ADD CONSTRAINT "territory_ownership_history_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territory_ownership_history" ADD CONSTRAINT "territory_ownership_history_from_family_id_families_id_fk" FOREIGN KEY ("from_family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territory_ownership_history" ADD CONSTRAINT "territory_ownership_history_to_family_id_families_id_fk" FOREIGN KEY ("to_family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territory_ownership_history" ADD CONSTRAINT "territory_ownership_history_actor_player_id_players_id_fk" FOREIGN KEY ("actor_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "territory_ownership_history_territory_idx" ON "territory_ownership_history" USING btree ("territory_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "territories_upkeep_due_idx" ON "territories" USING btree ("upkeep_paid_until") WHERE "territories"."owner_family_id" is not null;--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_state_check" CHECK ("territories"."state" in ('stable', 'neglected'));--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_owner_fields_check" CHECK (("territories"."owner_family_id" is null) = ("territories"."upkeep_paid_until" is null) and ("territories"."owner_family_id" is null) = ("territories"."owned_since" is null));--> statement-breakpoint
-- System accounts: where money comes from and goes to. Codes match SYSTEM_ACCOUNTS in modules/ledger.
INSERT INTO "currency_accounts" ("id", "kind", "code") VALUES
	(gen_random_uuid(), 'system', 'grants'),
	(gen_random_uuid(), 'system', 'territory_income'),
	(gen_random_uuid(), 'system', 'territory_upkeep'),
	(gen_random_uuid(), 'system', 'claim_fees'),
	(gen_random_uuid(), 'system', 'disbanded');--> statement-breakpoint
-- Families founded before this migration get a treasury and the starting grant (₦20,000 at the time), through the ledger.
WITH "acc" AS (
	INSERT INTO "currency_accounts" ("id", "kind", "family_id", "balance")
	SELECT gen_random_uuid(), 'family_treasury', "id", 20000 FROM "families" WHERE "disbanded_at" IS NULL
	RETURNING "id", "family_id"
), "txn" AS (
	INSERT INTO "ledger_transactions" ("id", "kind", "idempotency_key", "ref_type", "ref_id")
	SELECT gen_random_uuid(), 'grant', 'grant:' || "family_id", 'family', "family_id"::text FROM "acc"
	RETURNING "id", "ref_id"
)
INSERT INTO "ledger_entries" ("transaction_id", "account_id", "amount", "balance_after", "reason")
SELECT "txn"."id", "acc"."id", 20000, 20000, 'starting_grant' FROM "txn" JOIN "acc" ON "acc"."family_id"::text = "txn"."ref_id"
UNION ALL
SELECT "txn"."id", (SELECT "id" FROM "currency_accounts" WHERE "code" = 'grants'), -20000, NULL, 'starting_grant' FROM "txn";
