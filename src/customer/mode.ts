/* True only in the separate customer build (vite.customer.config.ts defines it). The staff
   build never defines it, so every branch guarded by it is dead code there and the internal
   app is unchanged. A build-time constant rather than a runtime flag on purpose: a customer
   cannot flip it, and the staff bundle carries none of the customer wiring. */
/* ⚠️ OPTIONAL-CHAINED SO NODE CAN IMPORT THIS MODULE AT ALL. `import.meta.env` is a
   Vite-only builtin and is `undefined` under plain Node — see prospectPlace.ts's
   MAPBOX_TOKEN for the same wall. Without this, any audit script that transitively
   imports this module crashes outside a browser. */
export const CUSTOMER: boolean =
  (import.meta.env as Record<string, unknown> | undefined)?.VITE_CUSTOMER === "1";

/** The only workflows a customer sees: the standard Voice and SMS pair, each with a Sales and a
 *  Support path. Authored extra workflows and ones the SE created are internal. */
export const isCustomerWorkflowPath = (to: string) => /\/workflow\/(sms|voice)$/.test(to);
