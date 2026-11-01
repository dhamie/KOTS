import { useRef } from "react";
import { ApiError } from "../api/http";

/** A fresh Idempotency-Key. getRandomValues works over plain http too (randomUUID needs a secure context). */
const freshKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

type Keyed = <T>(send: (key: string) => Promise<T>) => Promise<T>;

/**
 * Sends requests with an Idempotency-Key that is kept until the server gives a definite answer (Phase 9b). If there
 * was no answer (NoAnswerError: a timeout or no connection) or a 5xx from the proxy, the outcome is unknown, so the
 * player's retry carries the same key and the server returns what the first attempt did instead of doing it twice.
 * Any other answer (success, or a refusal, which changes nothing) starts a new key for the next submission.
 */
export function keyedSender(newKey: () => string = freshKey): Keyed {
  let key = newKey();
  return async (send) => {
    try {
      const result = await send(key);
      key = newKey();
      return result;
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) key = newKey();
      throw e;
    }
  };
}

/** keyedSender for one form, kept across renders. */
export function useRequestKey(): Keyed {
  const sender = useRef<Keyed>(null);
  sender.current ??= keyedSender();
  return sender.current;
}
