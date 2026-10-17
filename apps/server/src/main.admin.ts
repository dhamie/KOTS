import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadConfig } from "./config";
import { AdminModule } from "./modules/admin/admin.module";
import { AdminService, type FamilyReport, type PlayerReport } from "./modules/admin/admin.service";

const USAGE = `Usage: npm run admin -- <command>
  inspect player <handle>
  inspect family <tag>
  adjust <tag> <amount> "<reason>"    amount in whole naira: +5000 credits the treasury, -5000 debits it
  ban <handle> "<reason>"
  unban <handle> ["<reason>"]`;

const naira = (n: number) => `${n < 0 ? "-" : ""}₦${Math.abs(n).toLocaleString("en-NG")}`;
const when = (d: Date | string) => new Date(d).toISOString().replace("T", " ").slice(0, 16);

function printPlayer({ account: a, membership: m, audit }: PlayerReport): void {
  console.log(`${a.handle}  (player ${a.playerId})`);
  console.log(`  email:        ${a.email}`);
  console.log(`  status:       ${a.status}${a.isModerator ? ", moderator" : ""}`);
  console.log(`  joined:       ${when(a.createdAt)}`);
  console.log(`  last active:  ${when(a.lastActiveAt)}`);
  console.log(`  family:       ${m ? `${m.family.name} [${m.family.tag}], ${m.role}` : "none"}`);
  printAudit(audit);
}

function printFamily(r: FamilyReport): void {
  console.log(`${r.family.name} [${r.family.tag}]  (family ${r.family.id})`);
  console.log(`  founded:      ${when(r.family.foundedAt)}, stage ${r.family.stage}`);
  console.log(`  treasury:     ${naira(r.balance)}`);
  console.log(`  members:      ${r.family.members.map((m) => `${m.handle} (${m.role})`).join(", ")}`);
  console.log(`  territories:  ${r.holdings.territories.map((t) => `${t.slug}${t.state === "stable" ? "" : ` (${t.state})`}`).join(", ") || "none"}`);
  console.log(`  henchmen:     ${r.henchmen.map((h) => `${h.name}${h.assignedTo ? ` on ${h.assignedTo}` : ""}`).join(", ") || "none"}`);
  console.log(`  goods:        ${r.inventory.items.map((i) => `${i.good} ×${i.quantity}`).join(", ") || "none"} (${r.inventory.used}/${r.inventory.capacity})`);
  console.log("  last ledger entries:");
  for (const e of r.ledger) console.log(`    ${when(e.createdAt)}  ${naira(e.amount).padStart(12)}  → ${naira(e.balanceAfter).padStart(12)}  ${e.kind}/${e.reason}`);
  printAudit(r.audit);
}

function printAudit(audit: PlayerReport["audit"]): void {
  if (audit.length === 0) return;
  console.log("  admin and moderation history:");
  for (const a of audit) console.log(`    ${when(a.createdAt)}  ${a.action}  ${JSON.stringify(a.details)}`);
}

/**
 * `npm run admin -- <command>`: the operator's tools (Phase 8c). Changes go through the game's services, the same
 * as the api's, and each is written to the moderation audit log. Live effects (a banned player's disconnect, a
 * family's refresh) reach browsers through the api process.
 */
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(AdminModule.forDatabase(loadConfig().databaseUrl), { logger: false });
  try {
    const admin = app.get(AdminService);
    if (command === "inspect" && args[0] === "player" && args[1]) printPlayer(await admin.inspectPlayer(args[1]));
    else if (command === "inspect" && args[0] === "family" && args[1]) printFamily(await admin.inspectFamily(args[1]));
    else if (command === "adjust" && args.length === 3 && /^[+-]?\d+$/.test(args[1]!)) {
      const balance = await admin.adjustTreasury(args[0]!, Number(args[1]), args[2]!);
      console.log(`Adjusted [${args[0]}] by ${naira(Number(args[1]))}; the treasury holds ${naira(balance)}.`);
    } else if (command === "ban" && args.length === 2) {
      const ended = await admin.ban(args[0]!, args[1]!);
      console.log(`${args[0]} is banned; ${ended} session${ended === 1 ? "" : "s"} ended.`);
    } else if (command === "unban" && (args.length === 1 || args.length === 2)) {
      await admin.unban(args[0]!, args[1] ?? "");
      console.log(`${args[0]} can log in again.`);
    } else throw new Error(USAGE);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
