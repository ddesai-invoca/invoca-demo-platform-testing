/* Stands in for src/data/ProfileContext.tsx in the customer build (vite.customer.config.ts).
   Same exports the screens use, but it holds exactly ONE profile, handed in after sign-in, and
   never touches localStorage: a customer's browser must not keep a copy of the profile, and the
   staff context mirrors the active profile there for pages this build does not contain. */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { CustomerProfile } from "../data/schema";
import { renameMarketingSources } from "../data/marketingSources";

interface ProfileCtx {
  profile: CustomerProfile;
  profileId: string;
  setProfileId: (id: string) => void;
  profiles: CustomerProfile[];
  addProfile: (p: CustomerProfile) => void;
  removeProfile: (id: string) => void;
}
const Ctx = createContext<ProfileCtx | null>(null);
const noop = () => { /* a customer cannot switch, add or delete demos */ };

export function ProfileProvider({ profile, children }: { profile: CustomerProfile; children: ReactNode }) {
  const value = useMemo<ProfileCtx>(() => {
    const p = renameMarketingSources(profile);
    return { profile: p, profileId: p.id, setProfileId: noop, profiles: [p], addProfile: noop, removeProfile: noop };
  }, [profile]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProfile(): ProfileCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProfile must be used within ProfileProvider");
  return v;
}
