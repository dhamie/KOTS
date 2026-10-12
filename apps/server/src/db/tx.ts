import type { Database } from "./db";

/** A Drizzle transaction handle. Services that take part in a caller's transaction accept `DbOrTx`. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;
