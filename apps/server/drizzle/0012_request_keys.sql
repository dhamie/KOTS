ALTER TABLE "proposals" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "request_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_request_unique" ON "proposals" USING btree ("from_family_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_request_unique" ON "trades" USING btree ("from_family_id","request_key");