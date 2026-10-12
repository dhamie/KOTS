CREATE TABLE "chat_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"family_id" uuid,
	"player_a" uuid,
	"player_b" uuid,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_channels_kind_check" CHECK ("chat_channels"."kind" in ('family', 'public', 'direct')),
	CONSTRAINT "chat_channels_fields_check" CHECK (("chat_channels"."kind" = 'family' and "chat_channels"."family_id" is not null and "chat_channels"."player_a" is null and "chat_channels"."player_b" is null)
        or ("chat_channels"."kind" = 'direct' and "chat_channels"."family_id" is null and "chat_channels"."player_a" < "chat_channels"."player_b")
        or ("chat_channels"."kind" = 'public' and "chat_channels"."family_id" is null and "chat_channels"."player_a" is null and "chat_channels"."player_b" is null))
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "chat_messages_body_check" CHECK (char_length("chat_messages"."body") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "chat_reads" (
	"player_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"last_read_id" bigint NOT NULL,
	CONSTRAINT "chat_reads_player_id_channel_id_pk" PRIMARY KEY("player_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "message_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" bigint NOT NULL,
	"reporter_id" uuid,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "message_reports_reason_check" CHECK ("message_reports"."reason" in ('spam', 'abuse', 'cheating', 'other')),
	CONSTRAINT "message_reports_status_check" CHECK ("message_reports"."status" in ('open', 'actioned', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"moderator_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" in ('grant_moderator', 'revoke_moderator', 'delete_message', 'dismiss_report'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"type" text NOT NULL,
	"target" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "player_blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "player_blocks_self_check" CHECK ("player_blocks"."blocker_id" <> "player_blocks"."blocked_id")
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "is_moderator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_player_a_players_id_fk" FOREIGN KEY ("player_a") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_player_b_players_id_fk" FOREIGN KEY ("player_b") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_id_players_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_deleted_by_players_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_reporter_id_players_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_resolved_by_players_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_moderator_id_players_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_blocks" ADD CONSTRAINT "player_blocks_blocker_id_players_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_blocks" ADD CONSTRAINT "player_blocks_blocked_id_players_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channels_family_unique" ON "chat_channels" USING btree ("family_id") WHERE "chat_channels"."kind" = 'family';--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channels_direct_unique" ON "chat_channels" USING btree ("player_a","player_b") WHERE "chat_channels"."kind" = 'direct';--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channels_public_unique" ON "chat_channels" USING btree ("kind") WHERE "chat_channels"."kind" = 'public';--> statement-breakpoint
CREATE INDEX "chat_channels_player_b_idx" ON "chat_channels" USING btree ("player_b") WHERE "chat_channels"."kind" = 'direct';--> statement-breakpoint
CREATE INDEX "chat_messages_channel_idx" ON "chat_messages" USING btree ("channel_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "message_reports_once" ON "message_reports" USING btree ("message_id","reporter_id");--> statement-breakpoint
CREATE INDEX "message_reports_open_idx" ON "message_reports" USING btree ("created_at") WHERE "message_reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "notifications_player_idx" ON "notifications" USING btree ("player_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("player_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "player_blocks_blocked_idx" ON "player_blocks" USING btree ("blocked_id");--> statement-breakpoint
-- The one city-wide channel.
INSERT INTO "chat_channels" ("id", "kind") VALUES (gen_random_uuid(), 'public');
