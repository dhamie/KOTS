import { hash, verify } from "@node-rs/argon2";

/** argon2id (the library default) with the OWASP-recommended baseline: 19 MiB, 2 passes, 1 lane. */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password.normalize("NFKC"), OPTIONS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password.normalize("NFKC"));
  } catch {
    return false;
  }
}

/** Verified against when the email is unknown, so "no such account" takes as long as "wrong password". */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("not-a-real-password-just-for-timing");
  return dummyHash;
}
