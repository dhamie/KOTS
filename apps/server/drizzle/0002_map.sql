CREATE TABLE "districts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "districts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "territories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"district_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_income" integer NOT NULL,
	"base_upkeep" integer NOT NULL,
	"owner_family_id" uuid,
	CONSTRAINT "territories_slug_unique" UNIQUE("slug"),
	CONSTRAINT "territories_kind_check" CHECK ("territories"."kind" in ('commercial', 'residential', 'logistics', 'industrial', 'civic', 'waterfront')),
	CONSTRAINT "territories_base_values_check" CHECK ("territories"."base_income" >= 0 and "territories"."base_upkeep" >= 0)
);
--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_owner_family_id_families_id_fk" FOREIGN KEY ("owner_family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "territories_district_idx" ON "territories" USING btree ("district_id");--> statement-breakpoint
CREATE INDEX "territories_owner_idx" ON "territories" USING btree ("owner_family_id");