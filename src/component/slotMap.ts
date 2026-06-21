// Pure, deterministic field-name -> generic-slot assignment for the searchDocs
// table. First-declared field gets the lowest free slot, so re-running sync with
// the same (or appended) config is idempotent and stable. Caps mirror the FINAL
// slot pool baked into schema.ts; exceeding a cap throws a clear, cap-naming error.

export type SlotMap = {
  search: Record<string, string>; // fieldName -> "textN" (text1..text8; text0 = concat, unmapped)
  strFilter: Record<string, string>; // fieldName -> "filtN" (filt0..filt7)
  numFilter: Record<string, string>; // fieldName -> "numFN" (numF0..numF6)
};

export type SlotConfig = {
  searchFields: string[];
  filterFields?: { field: string; type: "string" | "number" }[];
};

// FINAL caps. search = 8 named searchFields -> text1..text8 (text0 is the
// always-on concatenation slot and is NOT a named-field slot, so not counted).
// numFilter capped at 7 (not 8): a search index allows <=16 filterFields, and
// collection(1) + strFilter(8) + numFilter(7) = 16 is the hard ceiling.
export const SLOT_LIMITS = { search: 8, strFilter: 8, numFilter: 7 } as const;

function assignCategory(
  fields: string[],
  prefix: string,
  startIndex: number,
  cap: number,
  label: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  let next = startIndex;
  for (const field of fields) {
    if (field in out) continue; // dedup: a field declared twice keeps its first slot
    if (next - startIndex >= cap) {
      throw new Error(
        `${label} cap exceeded: at most ${cap} ${label.toLowerCase()}s are supported ` +
          `(slot pool ${prefix}${startIndex}..${prefix}${startIndex + cap - 1})`,
      );
    }
    out[field] = `${prefix}${next}`;
    next += 1;
  }
  return out;
}

export function assignSlots(config: SlotConfig): SlotMap {
  // text0 is reserved for the all-searchFields concatenation, so named search
  // fields start at text1.
  const search = assignCategory(
    config.searchFields,
    "text",
    1,
    SLOT_LIMITS.search,
    "Search field",
  );

  const strFields = (config.filterFields ?? [])
    .filter((f) => f.type === "string")
    .map((f) => f.field);
  const numFields = (config.filterFields ?? [])
    .filter((f) => f.type === "number")
    .map((f) => f.field);

  const strFilter = assignCategory(
    strFields,
    "filt",
    0,
    SLOT_LIMITS.strFilter,
    "String filter",
  );
  const numFilter = assignCategory(
    numFields,
    "numF",
    0,
    SLOT_LIMITS.numFilter,
    "Numeric filter",
  );

  return { search, strFilter, numFilter };
}
