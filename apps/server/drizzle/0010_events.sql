CREATE TABLE "world_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"seed" bigint NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "world_events_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "world_events_type_check" CHECK ("world_events"."type" in ('port_congestion', 'fuel_scarcity', 'street_festival', 'police_sweep')),
	CONSTRAINT "world_events_scope_check" CHECK ("world_events"."scope" in ('market', 'district', 'city')),
	CONSTRAINT "world_events_state_check" CHECK ("world_events"."state" in ('scheduled', 'active', 'expired')),
	CONSTRAINT "world_events_period_check" CHECK ("world_events"."expires_at" > "world_events"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_action_check";--> statement-breakpoint
CREATE INDEX "world_events_due_idx" ON "world_events" USING btree ("starts_at") WHERE "world_events"."state" = 'scheduled';--> statement-breakpoint
CREATE INDEX "world_events_active_idx" ON "world_events" USING btree ("expires_at") WHERE "world_events"."state" = 'active';--> statement-breakpoint
CREATE INDEX "world_events_news_idx" ON "world_events" USING btree ("starts_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('grant', 'territory_claim', 'upkeep', 'disband', 'recruitment', 'wage', 'purchase', 'sale', 'trade', 'transfer', 'battle', 'event'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" in ('grant_moderator', 'revoke_moderator', 'delete_message', 'dismiss_report', 'trigger_event'));--> statement-breakpoint
-- Festival payouts come from this system account. Code matches SYSTEM_ACCOUNTS in modules/ledger.
INSERT INTO "currency_accounts" ("id", "kind", "code") VALUES (gen_random_uuid(), 'system', 'events');
