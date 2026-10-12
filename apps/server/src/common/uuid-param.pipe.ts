import { type PipeTransform } from "@nestjs/common";
import { notFound } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id in the path can't match anything, so it's a 404 rather than a database error. */
export class UuidParam implements PipeTransform<string, string> {
  constructor(private readonly what: string) {}

  transform(value: string): string {
    if (!UUID.test(value)) throw notFound(this.what);
    return value.toLowerCase();
  }
}

/** A bigserial id (chat messages, notifications) in the path; anything else is a 404. */
export class SerialParam implements PipeTransform<string, string> {
  constructor(private readonly what: string) {}

  transform(value: string): string {
    if (!/^\d{1,18}$/.test(value)) throw notFound(this.what);
    return value;
  }
}
