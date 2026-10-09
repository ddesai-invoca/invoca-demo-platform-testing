import type { DigitalInsightsReport, InteractionRow } from "./schema";

/* "Calling Page" on the Digital Journey & Call Attribution report: the page the
   caller was on when they dialled.

   DERIVED at render, never stored, so all demos already on disk get the column
   (bundled, library and event seeds) with no migration and no engine phase, and
   generation time is unchanged. It sits directly after "Website Journey" because
   the journey is the path and this is where that path ended.

   The value comes from the row's OWN data so it cannot contradict its neighbours:
   - the landing page's path, with the tracking query removed, when that path is a
     real page (a calling page is a clean URL, not the tagged entry link);
   - otherwise (a landing page that is only the site root, as on several demos) the
     path is rebuilt from the journey's own breadcrumb, minus the leading "Home".
   Both agree with the journey column by construction. */
export const CALLING_PAGE_HEADER = "Calling Page";

const JOURNEY_HEADER = /journey/i;
const CALLING_HEADER = /calling\s*page/i;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function callingPageFor(row: Pick<InteractionRow, "landingPageUrl" | "websiteJourney">): string {
  let url: URL | null = null;
  try {
    url = new URL(row.landingPageUrl);
  } catch {
    return "";
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path) return `${url.origin}${url.pathname}`;
  const segs = row.websiteJourney
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && !/^home$/i.test(s))
    .map(slug)
    .filter(Boolean);
  return segs.length ? `${url.origin}/${segs.join("/")}` : `${url.origin}/`;
}

/* Returns the report with a "Calling Page" column inserted straight after the
   journey column. A report that already has one is returned untouched (idempotent,
   and it leaves an SE's own edits alone), as is one with no journey column to sit
   beside, because a column placed at a guessed position is worse than none. */
export function withCallingPage(r: DigitalInsightsReport): DigitalInsightsReport {
  if (r.dimensionColumns.some((h) => CALLING_HEADER.test(h))) return r;
  const at = r.dimensionColumns.findIndex((h) => JOURNEY_HEADER.test(h));
  if (at < 0) return r;
  const insertAt = at + 1;
  return {
    ...r,
    dimensionColumns: [
      ...r.dimensionColumns.slice(0, insertAt),
      CALLING_PAGE_HEADER,
      ...r.dimensionColumns.slice(insertAt),
    ],
    rows: r.rows.map((row) => {
      /* `cells` is only trustworthy while it lines up with the OLD headers; a
         mismatched array is damage and the renderer already ignores it. */
      if (row.cells?.length === r.dimensionColumns.length) {
        return {
          ...row,
          cells: [...row.cells.slice(0, insertAt), callingPageFor(row), ...row.cells.slice(insertAt)],
        };
      }
      return row;
    }),
  };
}
