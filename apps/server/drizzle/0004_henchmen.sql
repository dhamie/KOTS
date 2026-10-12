CREATE TABLE "henchmen" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"recruit_key" text NOT NULL,
	"archetype" text NOT NULL,
	"name" text NOT NULL,
	"combat" integer NOT NULL,
	"leadership" integer NOT NULL,
	"discipline" integer NOT NULL,
	"negotiation" integer NOT NULL,
	"logistics" integer NOT NULL,
	"reliability" integer NOT NULL,
	"loyalty" integer NOT NULL,
	"morale" integer NOT NULL,
	"traits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"assigned_territory_id" uuid,
	"hire_cost" integer NOT NULL,
	"wage" integer NOT NULL,
	"wage_paid_until" timestamp with time zone,
	"wage_overdue" boolean DEFAULT false NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"hired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "henchmen_recruit_key_unique" UNIQUE("recruit_key"),
	CONSTRAINT "henchmen_status_check" CHECK ("henchmen"."status" in ('active', 'deserted', 'dismissed')),
	CONSTRAINT "henchmen_attributes_check" CHECK (least("henchmen"."combat", "henchmen"."leadership", "henchmen"."discipline", "henchmen"."negotiation", "henchmen"."logistics", "henchmen"."reliability", "henchmen"."loyalty") >= 1 and greatest("henchmen"."combat", "henchmen"."leadership", "henchmen"."discipline", "henchmen"."negotiation", "henchmen"."logistics", "henchmen"."reliability", "henchmen"."loyalty") <= 100),
	CONSTRAINT "henchmen_morale_check" CHECK ("henchmen"."morale" between 0 and 100),
	CONSTRAINT "henchmen_money_check" CHECK ("henchmen"."hire_cost" >= 0 and "henchmen"."wage" >= 0),
	CONSTRAINT "henchmen_active_fields_check" CHECK (("henchmen"."status" = 'active') = ("henchmen"."wage_paid_until" is not null) and ("henchmen"."status" = 'active' or "henchmen"."assigned_territory_id" is null))
);
--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "henchmen" ADD CONSTRAINT "henchmen_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "henchmen" ADD CONSTRAINT "henchmen_assigned_territory_id_territories_id_fk" FOREIGN KEY ("assigned_territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "henchmen_family_idx" ON "henchmen" USING btree ("family_id","status");--> statement-breakpoint
CREATE INDEX "henchmen_territory_idx" ON "henchmen" USING btree ("assigned_territory_id");--> statement-breakpoint
CREATE INDEX "henchmen_wage_due_idx" ON "henchmen" USING btree ("wage_paid_until") WHERE "henchmen"."status" = 'active';--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('grant', 'territory_claim', 'upkeep', 'disband', 'recruitment', 'wage'));--> statement-breakpoint
-- System accounts for recruitment fees and wages. Codes match SYSTEM_ACCOUNTS in modules/ledger.
INSERT INTO "currency_accounts" ("id", "kind", "code") VALUES
	(gen_random_uuid(), 'system', 'recruitment'),
	(gen_random_uuid(), 'system', 'wages');
