/* Stands in for src/data/profiles.ts in the customer build. The real one globs every prospect
   this platform has ever generated into the bundle; a customer must receive exactly one demo,
   after signing in, and nothing else. `audit:customer` greps the built output for that. */
import type { CustomerProfile } from "../data/schema";
export const PROFILES: Record<string, CustomerProfile> = {};
export const PROFILE_LIST: CustomerProfile[] = [];
export const DEFAULT_PROFILE_ID = "";
export const SEED_IDS = new Set<string>();
