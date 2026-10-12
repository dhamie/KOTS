CREATE TABLE "trade_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trade_id" uuid NOT NULL,
	"side" text NOT NULL,
	"good" text,
	"quantity" integer,
	"cash" bigint,
	CONSTRAINT "trade_lines_side_check" CHECK ("trade_lines"."side" in ('gives', 'wants')),
	CONSTRAINT "trade_lines_item_check" CHECK (("trade_lines"."good" is not null and "trade_lines"."quantity" > 0 and "trade_lines"."cash" is null) or ("trade_lines"."good" is null and "trade_lines"."quantity" is null and "trade_lines"."cash" > 0))
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_family_id" uuid NOT NULL,
	"to_family_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "trades_status_check" CHECK ("trades"."status" in ('open', 'executed', 'declined', 'cancelled', 'expired')),
	CONSTRAINT "trades_families_check" CHECK ("trades"."from_family_id" <> "trades"."to_family_id"),
	CONSTRAINT "trades_closed_check" CHECK (("trades"."status" = 'open') = ("trades"."closed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "trade_lines" ADD CONSTRAINT "trade_lines_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_lines" ADD CONSTRAINT "trade_lines_good_goods_key_fk" FOREIGN KEY ("good") REFERENCES "public"."goods"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_from_family_id_families_id_fk" FOREIGN KEY ("from_family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_to_family_id_families_id_fk" FOREIGN KEY ("to_family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_created_by_players_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_closed_by_players_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trade_lines_trade_idx" ON "trade_lines" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "trades_from_idx" ON "trades" USING btree ("from_family_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trades_to_idx" ON "trades" USING btree ("to_family_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trades_expiry_idx" ON "trades" USING btree ("expires_at") WHERE "trades"."status" = 'open';--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('grant', 'territory_claim', 'upkeep', 'disband', 'recruitment', 'wage', 'purchase', 'sale', 'trade'));