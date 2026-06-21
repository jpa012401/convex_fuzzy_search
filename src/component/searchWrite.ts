import { tokenize } from "./tokenizer";
import { indexRelevantFields } from "./storedFields";
import { assignSlots } from "./slotMap";
import type { SlotMap } from "./slotMap";

type Doc = Record<string, unknown>;

type SlotKey =
  | "text0" | "text1" | "text2" | "text3" | "text4"
  | "text5" | "text6" | "text7" | "text8"
  | "filt0" | "filt1" | "filt2" | "filt3"
  | "filt4" | "filt5" | "filt6" | "filt7"
  | "numF0" | "numF1" | "numF2" | "numF3";

export type SearchDocRow = {
  collection: string;
  docId: string;
  stored: Record<string, unknown>;
} & Partial<Record<SlotKey, string | number>>;

// Minimal shape projectToSlots needs from a collection row (a Convex Doc<"collections">
// is assignable to this).
type Col = {
  searchFields: string[];
  storedFields: "all" | "derived" | string[];
  filterFields?: { field: string; type: "string" | "number" }[];
  facetFields?: string[];
  sortSpecs?: { field: string; order: "asc" | "desc" }[][];
  rankProfiles?: Record<string, unknown>;
  slotMap?: SlotMap;
};

// Stored projection — identical semantics to project() in write.ts (kept).
function projectStored(doc: Doc, col: Col): Doc {
  const storedFields = col.storedFields;
  if (storedFields === "all") return doc;
  const keep = storedFields === "derived"
    ? indexRelevantFields(col as Parameters<typeof indexRelevantFields>[0])
    : storedFields;
  const out: Doc = {};
  for (const f of keep) {
    if (f in doc) out[f] = doc[f];
  }
  return out;
}

// Project a raw input doc onto the searchDocs slot columns + stored projection.
// Pure: no DB access. Requires col.slotMap (per F9 the create/apply step persists
// it before any upsert); falls back to assignSlots(col) as belt-and-suspenders.
export function projectToSlots(
  doc: Doc,
  col: Col,
): Omit<SearchDocRow, "collection" | "docId"> {
  const slotMap = col.slotMap ?? assignSlots(col);
  const row: Record<string, string | number> = {};

  // text0 = tokenized + space-joined concatenation of ALL searchFields (in order).
  const allTokens: string[] = [];
  for (const field of col.searchFields) {
    const value = doc[field];
    if (typeof value === "string") allTokens.push(...tokenize(value));
  }
  row.text0 = allTokens.join(" ");

  // textN = raw text of each mapped searchField.
  for (const [field, slot] of Object.entries(slotMap.search)) {
    const value = doc[field];
    if (typeof value === "string") row[slot] = value;
  }

  // filtN = String() of each mapped string-filter value.
  for (const [field, slot] of Object.entries(slotMap.strFilter)) {
    const value = doc[field];
    if (value === undefined || value === null) continue;
    row[slot] = String(value);
  }

  // numFN = Number() of each mapped numeric-filter value; skip NaN.
  for (const [field, slot] of Object.entries(slotMap.numFilter)) {
    const value = doc[field];
    if (value === undefined || value === null) continue;
    const num = Number(value);
    if (Number.isNaN(num)) continue;
    row[slot] = num;
  }

  return { ...(row as Partial<Record<SlotKey, string | number>>), stored: projectStored(doc, col) };
}
