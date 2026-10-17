ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_action_check";--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('grant', 'territory_claim', 'upkeep', 'disband', 'recruitment', 'wage', 'purchase', 'sale', 'trade', 'transfer', 'battle', 'event', 'admin_adjust'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" in ('grant_moderator', 'revoke_moderator', 'delete_message', 'dismiss_report', 'trigger_event', 'ban_player', 'unban_player', 'adjust_treasury'));--> statement-breakpoint
-- Operator adjustments (npm run admin -- adjust) come from and go to this system account. Code matches SYSTEM_ACCOUNTS in modules/ledger.
INSERT INTO "currency_accounts" ("id", "kind", "code") VALUES (gen_random_uuid(), 'system', 'admin');
