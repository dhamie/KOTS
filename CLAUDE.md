# CLAUDE.md

## Project: King of the Streets
Browser-based, persistent multiplayer mafia strategy game set in a stylised Lagos. Players run families: henchmen, territory with upkeep, a player-driven economy, diplomacy and chat, and turn-based battles resolved on the server.
- Brief: `docs/BRIEF.md`. Approved architecture, data model and phases: `docs/ARCHITECTURE.md`. The owner's original master prompt is the full statement of intent.
- Stack: TypeScript 6 (strict), npm workspaces, Vite + React + Phaser 4 (client), NestJS modular monolith with api and worker processes, PostgreSQL 16 + Drizzle (Docker Compose), pg-boss jobs, Socket.IO, Zod, Vitest. Redis only when a second instance or a measured need appears.
- Layout: `apps/client`, `apps/server`, `packages/shared` (Zod/DTOs), `packages/rules` (pure deterministic rules), `packages/content` (game data and tuning).
- Commands (from repo root): `npm run db:up`, `npm run db:migrate`, `npm run dev:api` (:4100), `npm run dev:worker`, `npm run dev:client` (:5180), `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:db`, `npm run build`. Details: `docs/DEVELOPMENT.md`.
- Git: local repo. The owner pushes it themselves. Don't commit unless asked.

## Phase gate (most important rule)
- Build phase by phase (see the phases table in `docs/ARCHITECTURE.md`). Never start the next phase on my own.
- Before any meaningful step, give: objective, exact scope, files and modules touched, dependencies, expected result, tests to run, risks and trade-offs. Then wait for explicit approval. Approval for one step doesn't carry over to the next. Silence, questions or discussion are not approval.
- Small fixes inside an approved step are fine. Expanding scope is not. Stop and ask before any architectural change (new datastore, framework swap, restructure, new service).
- Explain any new dependency before adding it.
- If you disagree with an approach: give the problem, the alternative, the trade-off and a recommendation, then ask.
- End every step with a checkpoint: what was completed, files changed, the commands that actually ran and their results, known limitations, risks, follow-ups, and the proposed next step. Never claim a test passed if it didn't run.

## Server authority and integrity rules
- The server is authoritative for money, inventory, ownership, permissions, prices, battle outcomes and the passage of time. The client sends intents only. The acting player and family are always derived from the session.
- Only the ledger module changes balances. Every money movement is a double-entry ledger transaction with a unique idempotency key. Debits are conditional updates (`WHERE balance >= n`), never read-modify-write.
- Multi-record operations (trades, transfers, rewards, recruitment, proposals) run in one DB transaction. Lock rows in a deterministic order. State transitions are conditional (`WHERE status = ...`) so they can't happen twice.
- Every background job is retry-safe through unique keys or conditional transitions. Schedule with timestamps and sweeps. Never tick every entity.
- `packages/rules` must never import Nest, Drizzle, Phaser, the DOM, `Date` or `Math.random`. Use the seeded RNG. Battles must replay identically from initial state, seed and orders.
- Content and tuning (archetypes, goods, events, role permissions, grace periods) are data in `packages/content`. Use explicit code where that is simpler and safer.
- A module touches only its own tables. Other modules go through its service. No circular module imports.
- Queries are bounded: keyset pagination, viewport and district map loading, no N+1 queries.
- Chat never changes game state. Only signed, server-validated proposals do.
- Influence, bribery and crime are abstract, fictional mechanics. Never write real-world operational detail.

## Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## Simplicity First
Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## Surgical Changes
Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## Goal-Driven Execution
Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

For gameplay feel and balance (map interaction, battle pacing, economy tuning), tests aren't enough: verify by playing the build as well.
