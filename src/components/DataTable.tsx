import type { InteractionRow, SignalColumn } from "../data/schema";
import { callingPageFor } from "../data/callingPage";

interface Props {
  dimensionColumns: string[];
  signalColumns: SignalColumn[];
  rows: InteractionRow[];
}

/* Columns the live report renders as non-sortable (no sort caret). */
const NO_SORT = new Set(["Full Landing Page URL"]);

/* Which named field a canonical header holds. Order matters only in that these
   patterns must not overlap — "Marketing Search Term" must not match the Source or
   Medium pattern. */
const HEADER_FIELD: [RegExp, keyof InteractionRow][] = [
  [/marketing\s*source/i, "marketingSource"],
  [/marketing\s*medium/i, "marketingMedium"],
  [/marketing\s*campaign/i, "marketingCampaign"],
  [/search\s*term/i, "marketingSearchTerm"],
  [/landing\s*page|url/i, "landingPageUrl"],
  [/journey/i, "websiteJourney"],
];

/* The leading text cells for one row, ALWAYS exactly headers.length long.

   ⚠️ TWO BUGS LIVE HERE, both found by actually running the assistant against a real
   demo rather than trusting the prompt.

   1. This was `FIELD_ORDER.map(...)`, hard-coding the body at six columns while the
      header rendered `dimensionColumns`. Add a column and you got N+1 headers over 6
      cells.

   2. Padding the FALLBACK at the end was worse than useless. Asked to add a Location
      column, the model wrote `cells` for only 7 of 21 rows; the other 14 fell back to
      the six named fields, so "Paid Search" rendered under the new "Location" heading
      and every value in those rows sat one column to the left of its own header — a
      table that reads as data rather than as a bug.

   So the fallback is HEADER-DRIVEN: each header takes the field it actually names,
   and a header with no matching field (a newly added "Location") renders EMPTY. A row
   the model skipped is then visibly incomplete instead of quietly misaligned, and
   every value that IS shown is under the right column. */
export function leadingCells(row: InteractionRow, headers: string[]): string[] {
  /* `cells` is an EDIT-TIME field: columnEdits writes one value per header when a
     column is added, removed or moved. It is only trustworthy when it still lines up
     with the headers.

     A mismatched array is not data, it is damage, and rendering it silently is how
     this broke in the field: generation was forcing a 2-entry `cells` onto every row
     (see engine/core.ts, DIGITAL_INSIGHTS_GEN) while dimensionColumns had 6, so the
     table showed an interaction count under "Marketing Source", revenue under
     "Marketing Medium", and four empty columns, with the six real values sitting
     untouched in the row the whole time. Falling back to the named fields renders
     those instead, which is right for every demo already saved with the bad array. */
  if (row.cells?.length === headers.length) return row.cells.slice();
  return headers.map((h) => {
    if (/calling\s*page/i.test(h)) return callingPageFor(row);
    const hit = HEADER_FIELD.find(([re]) => re.test(h));
    return hit ? String(row[hit[1]] ?? "") : "";
  });
}

/* Which cell gets the truncating .landing treatment, decided from the HEADER rather
   than from a field name — once a column can move, "the 5th field" is no longer a
   reliable way to find the URL. */
const isUrlColumn = (header: string) => /landing page|calling page|url/i.test(header);

export function DataTable({ dimensionColumns, signalColumns, rows }: Props) {
  return (
    <div className="table-scroll">
      <table className="report">
        <thead>
          <tr>
            <th className="no-sort col-details">Details</th>
            {/* keyed by INDEX: two columns may briefly share a name mid-edit, and a
                duplicate React key would silently drop one of them */}
            {dimensionColumns.map((c, i) => (
              <th key={i} className={NO_SORT.has(c) ? "no-sort" : undefined}>
                {c}
              </th>
            ))}
            {signalColumns.map((c, i) => (
              /* the first signal column is the sorted (desc) column in the live report */
              <th key={c.label} className={`col-signal${i === 0 ? " sorted-desc" : ""}`}>
                <span className="signal-head">
                  <span className="signal-head-label">{c.label}</span>
                  {c.badges.map((b) => (
                    <span key={b} className="badge-secondary">{b}</span>
                  ))}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              <td className="details">
                <span className="material-icons detail-icon">find_in_page</span>
              </td>
              {leadingCells(row, dimensionColumns).map((cell, ci) => {
                const url = isUrlColumn(dimensionColumns[ci] ?? "");
                return (
                  <td key={ci} className={url ? "landing" : undefined} title={url ? cell : undefined}>
                    {cell}
                  </td>
                );
              })}
              {signalColumns.map((c, ci) => (
                <td key={c.label} className="signal-cell">
                  {row.signals[ci] ? (
                    <i className="material-icons signal-yes">check_circle</i>
                  ) : (
                    <i className="material-icons signal-no">cancel</i>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
