import { useRef } from "react";
import { ApiError } from "../api/http";

/** A fresh Idempotency-Key. getRandomValues works over plain http too (randomUUID needs a secure context). */
const freshKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Idempotency-Keys for one form (Phase 9b). The key is kept until the server gives a definite answer, so if a
 * response is lost (no reply, or a 5xx from the proxy) and the player submits again, the retry carries the same key
 * and the server returns what the first attempt did instead of doing it twice. Any other answer (success or a
 * refusal, which changes nothing) starts a new key for the next submission.
 */
export function useRequestKey() {
  const key = useRef(freshKey());
  return async <T>(send: (key: string) => Promise<T>): Promise<T> => {
    try {
      const result = await send(key.current);
      key.current = freshKey();
      return result;
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) key.current = freshKey();
      throw e;
    }
  };
}
