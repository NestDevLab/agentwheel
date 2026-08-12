import { z } from "zod";

export const immutableCacheIdentitySchema = z.string().regex(
  /^(?:[0-9a-f]{40}|content-[0-9a-f]{64})$/i,
  "Expected a Git commit or content-addressed SHA-256 cache identity",
);

export function normalizeImmutableCacheIdentity(value: string | undefined): string | undefined {
  return value === undefined ? undefined : immutableCacheIdentitySchema.parse(value).toLowerCase();
}
