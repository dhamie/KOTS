import { z } from "zod";

/** Response of `GET /api/health`. */
export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["ok", "down"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
