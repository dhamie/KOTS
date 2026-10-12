CREATE TABLE "battle_orders" (
	"battle_id" uuid NOT NULL,
	"round_no" integer NOT NULL,
	"side" text NOT NULL,
	"tactic" text NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "battle_orders_battle_id_round_no_side_pk" PRIMARY KEY("battle_id","round_no","side"),
	CONSTRAINT "battle_orders_side_check" CHECK ("battle_orders"."side" in ('attacker', 'defender')),
	CONSTRAINT "battle_orders_tactic_check" CHECK ("battle_orders"."tactic" in ('press', 'hold', 'flank'))
);
--> statement-breakpoint
CREATE TABLE "battle_rounds" (
	"battle_id" uuid NOT NULL,
	"round_no" integer NOT NULL,
	"result" jsonb NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "battle_rounds_battle_id_round_no_pk" PRIMARY KEY("battle_id","round_no")
);
--> statement-breakpoint
CREATE TABLE "battles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"territory_id" uuid NOT NULL,
	"attacker_family_id" uuid NOT NULL,
	"defender_family_id" uuid NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"seed" integer NOT NULL,
	"fee" integer NOT NULL,
	"declared_by" uuid,
	"declared_at" timestamp with time zone NOT NULL,
	"current_round" integer DEFAULT 0 NOT NULL,
	"next_round_at" timestamp with time zone,
	"initial_state" jsonb,
	"state" jsonb,
	"winner" text,
	"end_reason" text,
	"ended_at" timestamp with time zone,
	CONSTRAINT "battles_status_check" CHECK ("battles"."status" in ('preparing', 'active', 'resolved', 'cancelled')),
	CONSTRAINT "battles_families_check" CHECK ("battles"."attacker_family_id" <> "battles"."defender_family_id"),
	CONSTRAINT "battles_live_check" CHECK (("battles"."status" in ('preparing', 'active')) = ("battles"."next_round_at" is not null) and ("battles"."status" in ('preparing', 'active')) = ("battles"."ended_at" is null)),
	CONSTRAINT "battles_winner_check" CHECK (("battles"."status" = 'resolved') = ("battles"."winner" is not null) and ("battles"."winner" is null or "battles"."winner" in ('attacker', 'defender'))),
	CONSTRAINT "battles_fee_check" CHECK ("battles"."fee" >= 0 and "battles"."current_round" >= 0)
);
--> statement-breakpoint
ALTER TABLE "henchmen" DROP CONSTRAINT "henchmen_active_fields_check";--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "territory_ownership_history" DROP CONSTRAINT "territory_ownership_history_cause_check";--> statement-breakpoint
ALTER TABLE "henchmen" ADD COLUMN "injured_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "henchmen" ADD COLUMN "battle_id" uuid;--> statement-breakpoint
ALTER TABLE "territories" ADD COLUMN "contested_battle_id" uuid;--> statement-breakpoint
ALTER TABLE "battle_orders" ADD CONSTRAINT "battle_orders_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_orders" ADD CONSTRAINT "battle_orders_submitted_by_players_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_rounds" ADD CONSTRAINT "battle_rounds_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_attacker_family_id_families_id_fk" FOREIGN KEY ("attacker_family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_defender_family_id_families_id_fk" FOREIGN KEY ("defender_family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_declared_by_players_id_fk" FOREIGN KEY ("declared_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "battles_territory_live_unique" ON "battles" USING btree ("territory_id") WHERE "battles"."status" in ('preparing', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "battles_attacker_live_unique" ON "battles" USING btree ("attacker_family_id") WHERE "battles"."status" in ('preparing', 'active');--> statement-breakpoint
CREATE INDEX "battles_due_idx" ON "battles" USING btree ("next_round_at") WHERE "battles"."status" in ('preparing', 'active');--> statement-breakpoint
CREATE INDEX "battles_attacker_idx" ON "battles" USING btree ("attacker_family_id","declared_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "battles_defender_idx" ON "battles" USING btree ("defender_family_id","declared_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "henchmen" ADD CONSTRAINT "henchmen_battle_id_battles_id_fk" FOREIGN KEY ("battle_id") REFERENCES "public"."battles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_contested_battle_id_battles_id_fk" FOREIGN KEY ("contested_battle_id") REFERENCES "public"."battles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "henchmen_battle_idx" ON "henchmen" USING btree ("battle_id") WHERE "henchmen"."battle_id" is not null;--> statement-breakpoint
ALTER TABLE "henchmen" ADD CONSTRAINT "henchmen_active_fields_check" CHECK (("henchmen"."status" = 'active') = ("henchmen"."wage_paid_until" is not null) and ("henchmen"."status" = 'active' or ("henchmen"."assigned_territory_id" is null and "henchmen"."battle_id" is null)));--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('grant', 'territory_claim', 'upkeep', 'disband', 'recruitment', 'wage', 'purchase', 'sale', 'trade', 'transfer', 'battle'));--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_contested_check" CHECK ("territories"."contested_battle_id" is null or "territories"."owner_family_id" is not null);--> statement-breakpoint
ALTER TABLE "territory_ownership_history" ADD CONSTRAINT "territory_ownership_history_cause_check" CHECK ("territory_ownership_history"."cause" in ('claim', 'abandon', 'lapsed', 'disband', 'transfer', 'battle'));--> statement-breakpoint
-- Declaration fees go to this system account. Code matches SYSTEM_ACCOUNTS in modules/ledger.
INSERT INTO "currency_accounts" ("id", "kind", "code") VALUES (gen_random_uuid(), 'system', 'battle_fees');
