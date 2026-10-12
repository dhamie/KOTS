CREATE TABLE "goods" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_stacks" (
	"family_id" uuid NOT NULL,
	"good" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "inventory_stacks_family_id_good_pk" PRIMARY KEY("family_id","good"),
	CONSTRAINT "inventory_stacks_quantity_check" CHECK ("inventory_stacks"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "market_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"territory_id" uuid NOT NULL,
	"good" text NOT NULL,
	"side" text NOT NULL,
	"quantity" integer NOT NULL,
	"total" integer NOT NULL,
	"actor_player_id" uuid,
	"request_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_orders_side_check" CHECK ("market_orders"."side" in ('buy', 'sell')),
	CONSTRAINT "market_orders_amounts_check" CHECK ("market_orders"."quantity" > 0 and "market_orders"."total" > 0)
);
--> statement-breakpoint
CREATE TABLE "npc_market_state" (
	"territory_id" uuid NOT NULL,
	"good" text NOT NULL,
	"stock" integer NOT NULL,
	"drift_step" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npc_market_state_territory_id_good_pk" PRIMARY KEY("territory_id","good"),
	CONSTRAINT "npc_market_state_stock_check" CHECK ("npc_market_state"."stock" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "inventory_stacks" ADD CONSTRAINT "inventory_stacks_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stacks" ADD CONSTRAINT "inventory_stacks_good_goods_key_fk" FOREIGN KEY ("good") REFERENCES "public"."goods"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_good_goods_key_fk" FOREIGN KEY ("good") REFERENCES "public"."goods"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_actor_player_id_players_id_fk" FOREIGN KEY ("actor_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_market_state" ADD CONSTRAINT "npc_market_state_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_market_state" ADD CONSTRAINT "npc_market_state_good_goods_key_fk" FOREIGN KEY ("good") REFERENCES "public"."goods"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_orders_request_unique" ON "market_orders" USING btree ("family_id","request_key");--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('grant', 'territory_claim', 'upkeep', 'disband', 'recruitment', 'wage', 'purchase', 'sale'));--> statement-breakpoint
-- The market's money comes from and goes to this system account. Code matches SYSTEM_ACCOUNTS in modules/ledger.
INSERT INTO "currency_accounts" ("id", "kind", "code") VALUES (gen_random_uuid(), 'system', 'market');
