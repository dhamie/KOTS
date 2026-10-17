# NPC officials (Phase 8b)

Who the officials are, what they do so far, and where to tune them. Every official, office and story is fictional and abstract: no real person, office or procedure is modelled.

## Where things live
| What | Where |
|---|---|
| Offices, officials, traits, bios, tuning | `packages/content/src/officials.ts` (`OFFICE_DEFS`, `OFFICIALS`, `OFFICIALS_TUNING`) |
| Which official sways which event | `swayedBy` in `EVENT_DEFS` (`packages/content/src/events.ts`) |
| How sway picks a district (pure, deterministic) | `eventPlaceWeight` in `packages/rules/src/events.ts` |
| Officials named in event stories | `story()` in `apps/server/src/modules/events/events.service.ts` |
| Screen | "Officials" in the Districts drawer (`ui/map/OfficialsList.tsx`) |

## The officials
Each district has one of each office:

| Office | Covers |
|---|---|
| Area Chairman | Civic life: markets, permits and celebrations |
| Area Commander | Order on the streets |

Every official has an invented name, a short bio and four traits from 0 to 100: integrity, ambition, loyalty and self-interest. Officials with integrity of at least `OFFICIALS_TUNING.unbuyableIntegrity` (80) are marked "Can't be bought". No mechanic uses that yet; it's there for influence, which comes after the MVP.

## What they do
When the hourly roll picks a street festival or a police sweep without a fixed district, the district is picked with these weights:

- **Street festival:** `baseSway` + the Area Chairman's ambition.
- **Police sweep:** `baseSway` + the Area Commander's ambition + integrity.

`baseSway` (50) keeps every district possible. With the current officials:

| District | Festival weight | Sweep weight |
|---|---|---|
| Yaba & Ebute Metta | 105 (31%) | 130 (27%) |
| Lagos Island | 140 (42%) | 218 (45%) |
| Apapa | 90 (27%) | 135 (28%) |

The pick uses one draw of the event's seeded RNG, as the uniform pick did, so the same seed still gives the same event. A district given explicitly (`npm run event:trigger police_sweep apapa`) is used as is. Markets and city-wide events aren't swayed.

The festival and sweep stories name the official: "Area Commander Ngozi Eze ordered a sweep through the district…".

## Tests
- Content (`packages/content/test/officials.test.ts`): unique ids; exactly one official per office in every district; traits are whole numbers from 0 to 100; only district events are swayed, through offices every district has.
- Rules (`packages/rules/test/events.test.ts`): over 6,000 seeds, each district's share of festivals and sweeps is within 3 points of its weight, and none is ruled out; markets are weighed equally.
- Server (`apps/server/test/events.test.ts`): the festival story names Apapa's Area Chairman.
- Browser (`e2e/map.spec.ts`): the drawer shows a district's officials, their office, traits and the "Can't be bought" mark.

## Limits and follow-ups
- Officials are fixed content: no elections, replacements or traits that change over time.
- Players can't act on officials. Influence (favours, relationships, who can be bought) comes after the MVP and will need its own proposal and tables.
- The weights are first guesses.
