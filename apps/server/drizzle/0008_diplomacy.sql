CREATE TABLE "ceasefires" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_a" uuid NOT NULL,
	"family_b" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ceasefires_proposal_unique" UNIQUE("proposal_id"),
	CONSTRAINT "ceasefires_families_check" CHECK ("ceasefires"."family_a" < "ceasefires"."family_b"),
	CONSTRAINT "ceasefires_period_check" CHECK ("ceasefires"."starts_at" < "ceasefires"."ends_at")
);
--> statement-breakpoint
CREATE TABLE "proposal_signatures" (
	"proposal_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"signed_by" uuid,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_signatures_proposal_id_family_id_pk" PRIMARY KEY("proposal_id","family_id")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"from_family_id" uuid NOT NULL,
	"to_family_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"terms" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "proposals_kind_check" CHECK ("proposals"."kind" in ('territory_transfer', 'ceasefire')),
	CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('open', 'executed', 'declined', 'withdrawn', 'expired')),
	CONSTRAINT "proposals_families_check" CHECK ("proposals"."from_family_id" <> "proposals"."to_family_id"),
	CONSTRAINT "proposals_closed_check" CHECK (("proposals"."status" = 'open') = ("proposals"."closed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "chat_channels" DROP CONSTRAINT "chat_channels_kind_check";--> statement-breakpoint
ALTER TABLE "chat_channels" DROP CONSTRAINT "chat_channels_fields_check";--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "territory_ownership_history" DROP CONSTRAINT "territory_ownership_history_cause_check";--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "family_a" uuid;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "family_b" uuid;--> statement-breakpoint
ALTER TABLE "ceasefires" ADD CONSTRAINT "ceasefires_family_a_families_id_fk" FOREIGN KEY ("family_a") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceasefires" ADD CONSTRAINT "ceasefires_family_b_families_id_fk" FOREIGN KEY ("family_b") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceasefires" ADD CONSTRAINT "ceasefires_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_signatures" ADD CONSTRAINT "proposal_signatures_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_signatures" ADD CONSTRAINT "proposal_signatures_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_signatures" ADD CONSTRAINT "proposal_signatures_signed_by_players_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_from_family_id_families_id_fk" FOREIGN KEY ("from_family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_to_family_id_families_id_fk" FOREIGN KEY ("to_family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_players_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_closed_by_players_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ceasefires_pair_idx" ON "ceasefires" USING btree ("family_a","family_b","ends_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proposals_channel_idx" ON "proposals" USING btree ("channel_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proposals_expiry_idx" ON "proposals" USING btree ("expires_at") WHERE "proposals"."status" = 'open';--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_family_a_families_id_fk" FOREIGN KEY ("family_a") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_family_b_families_id_fk" FOREIGN KEY ("family_b") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channels_diplomacy_unique" ON "chat_channels" USING btree ("family_a","family_b") WHERE "chat_channels"."kind" = 'diplomacy';--> statement-breakpoint
CREATE INDEX "chat_channels_family_b_idx" ON "chat_channels" USING btree ("family_b") WHERE "chat_channels"."kind" = 'diplomacy';--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_kind_check" CHECK ("chat_channels"."kind" in ('family', 'public', 'direct', 'diplomacy'));--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_fields_check" CHECK (("chat_channels"."family_a" is null) = ("chat_channels"."family_b" is null) and (
           ("chat_channels"."kind" = 'family' and "chat_channels"."family_id" is not null and "chat_channels"."player_a" is null and "chat_channels"."player_b" is null and "chat_channels"."family_a" is null)
        or ("chat_channels"."kind" = 'direct' and "chat_channels"."family_id" is null and "chat_channels"."player_a" < "chat_channels"."player_b" and "chat_channels"."family_a" is null)
        or ("chat_channels"."kind" = 'public' and "chat_channels"."family_id" is null and "chat_channels"."player_a" is null and "chat_channels"."player_b" is null and "chat_channels"."family_a" is null)
        or ("chat_channels"."kind" = 'diplomacy' and "chat_channels"."family_id" is null and "chat_channels"."player_a" is null and "chat_channels"."player_b" is null and "chat_channels"."family_a" < "chat_channels"."family_b")));--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('grant', 'territory_claim', 'upkeep', 'disband', 'recruitment', 'wage', 'purchase', 'sale', 'trade', 'transfer'));--> statement-breakpoint
ALTER TABLE "territory_ownership_history" ADD CONSTRAINT "territory_ownership_history_cause_check" CHECK ("territory_ownership_history"."cause" in ('claim', 'abandon', 'lapsed', 'disband', 'transfer'));