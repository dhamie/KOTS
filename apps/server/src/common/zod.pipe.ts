import { type PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { badRequest } from "./errors";

/** Parses a request body/query with a shared Zod schema. Unknown keys are rejected by the strict schemas. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw badRequest(
        "Invalid request.",
        result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    return result.data;
  }
}
