# King of the Streets — Brief

Condensed from the master project prompt (2026-10-09). The master prompt is still the full statement of intent. This file is the working summary. Architecture lives in `docs/ARCHITECTURE.md`.

## Vision
King of the Streets is a browser-based, persistent, multiplayer mafia strategy game set in a stylised Lagos. The view is top-down isometric (2.5D). Players run criminal families and grow them from a street crew into an underworld empire by:
- recruiting NPC henchmen
- holding territory
- trading in a player-driven economy
- building relationships with NPC officials
- doing deals with other families
- fighting battles that the server resolves round by round

It is **not** a life simulator: there are no hunger, dating, job or domestic needs. The world is driven by player decisions and keeps moving, within fair limits, while players are offline.

## Design pillars
1. Family building and organisational progression.
2. Territorial control and expansion.
3. A player-driven trading and resource economy.
4. Recruitable NPC henchmen with individual attributes and personalities.
5. Dynamic NPC politicians, officials and security organisations.
6. Alliances, diplomacy, family chat and rivalries.
7. Tactical, simulated battles involving multiple families.
8. A persistent world with unexpected events.
9. Authentic Lagos-inspired geography, culture and atmosphere.
10. Secure, scalable multiplayer architecture.

## Core rules of the world
- **Families** are the player organisations. Roles are Don, Underboss, Consigliere, Capo, Enforcer, Fixer, Quartermaster and Associate. Each role grants real permissions, and the server checks them.
- **Progression stages** (initial concept, not final rules): Street crew → Local family → District syndicate → City-wide organisation → Underworld empire. There is no forced path. Economic, territorial, political, defensive and alliance strategies are all valid.
- **New families** get help that shrinks as they grow: neutral starter territory, lower upkeep and a protection window. This help never takes anything away from established families.
- **Growth costs something.** More territory and activity bring higher upkeep and more attention from authorities and rivals. There are no class locks.
- **Territory** brings strategic benefits, not just income. Neglect causes gradual decline: arrears, falling stability, contested status. Being offline never causes instant loss; there are warnings and grace periods.
- **NPC henchmen** have their own attributes, upkeep, morale, fatigue and loyalty. Archetypes are defined as data.
- **NPC officials** have real profiles: integrity, ambition, loyalty, self-interest and so on. Some can't be bought. Influence is an abstract, fictional mechanic. It never serves as real-world instructions.
- **Chat is never a contract.** Formal deals are structured proposals with terms, signatories and an expiry time. The server checks a proposal and carries it out only after every party has accepted.
- **Battles** are turn-based. Players submit orders, and the server resolves rounds on a schedule. Results are deterministic from the stored state and seed, and each battle produces a replayable report. One defeat never wipes out a family.

## Setting and content
- Real Lagos geography is inspiration only. The map is stylised and hand-authored: Mainland, Island, VI/Lekki-like areas, bridges, waterways, markets, the port and civic districts.
- All organisations, politicians, officials and events are fictional.
- Goods use abstract names such as "contraband", "imported goods", "fuel" and "electronics", not real drug or weapon specifics.

## MVP (first playable)
One complete, reliable loop. Two families start in neutral territory. They:
- recruit henchmen
- claim territory that costs upkeep
- trade goods through an NPC market and directly with each other
- talk in chat and send a formal proposal
- fight a single territory battle

**Included:**
- Accounts and auth, player profiles, families with roles and permissions, activity history.
- A limited isometric map: about 3 districts and 20–30 territories, clickable markers and a contextual panel.
- Persistent territory ownership and time-based upkeep.
- A family treasury backed by a ledger.
- 3–5 henchman archetypes.
- 4–6 goods, inventory, an NPC market and secure player-to-player trades.
- Family, public and private chat. Diplomacy rooms with ceasefire and territory-transfer proposals.
- Territory battles: turn-based and resolved on the server.
- 3–5 random event types.
- Basic admin tools: inspect, adjust and ban.
- Automated tests for every critical game operation, including concurrency tests.

**After the MVP:** base assaults, multi-family wars and coalitions, NPC politicians and influence, the full event catalogue, seasons, and the wider map.

## Defaults decided in Phase 0 (2026-10-09)
These are defaults, chosen by following Claude's recommendations. Any of them can be revisited at a phase checkpoint.

| Question | Default |
|---|---|
| World structure | Permanent world for the MVP. The schema leaves room for a `season_id` later. |
| Art | Placeholder isometric art for the MVP, for example Kenney packs (CC0). The final art direction is decided later and recorded in `docs/ART.md`. |
| Monetisation | None in the MVP. The ledger is designed so that a premium currency could be added later without redesign. |
| Time scale | Real time, with no compressed game clock. Upkeep is due daily. Upkeep and contest grace periods are 48 h. Battle rounds resolve every 2 h. All of these values are configurable data. |
| Goods tone | Abstract names (see "Setting and content" above). |
| Team and scale | One developer working with Claude. There are no capacity claims until the Phase 10 load tests. Hosting is chosen at Phase 10. Players in Nigeria make latency a real criterion. |
| Repository | `~/projects/KOTS`, pushed to `github.com/dhamie/KOTS`. |
