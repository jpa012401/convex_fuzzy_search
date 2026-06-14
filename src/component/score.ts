import { numField } from "./ranking";

export type RankContext = {
  now?: number;
  origin?: { lat: number; lng: number };
  sets?: Record<string, string[]>;
};

export type RankTerm =
  | { id: string; type: "field"; weight: number; field: string }
  | { id: string; type: "flag"; weight: number; field: string; equals?: string }
  | { id: string; type: "setBoost"; weight: number; field: string; setKey: string }
  | { id: string; type: "recencyDecay"; weight: number; field: string; halfLifeMs: number }
  | { id: string; type: "geoDistance"; weight: number; latField: string; lngField: string; maxKm: number }
  | { id: string; type: "relevance"; weight: number };

const EARTH_KM = 6371;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 2^(-age/halfLife); future (negative age) clamps to 1.
export function recencyDecay(ageMs: number, halfLifeMs: number): number {
  return Math.pow(2, -Math.max(0, ageMs) / halfLifeMs);
}

function coord(stored: Record<string, unknown>, field: string): number | null {
  const raw = stored[field];
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function contribution(
  term: RankTerm,
  weight: number,
  stored: Record<string, unknown>,
  textMatch: number,
  context: RankContext,
): number {
  switch (term.type) {
    case "field":
      return weight * numField(stored, term.field);
    case "flag": {
      const v = stored[term.field];
      const on =
        term.equals !== undefined
          ? String(v) === String(term.equals)
          : v === true || v === 1 || v === "true";
      return on ? weight : 0;
    }
    case "setBoost": {
      const set = context.sets?.[term.setKey];
      if (!set) return 0;
      return set.includes(String(stored[term.field])) ? weight : 0;
    }
    case "recencyDecay": {
      if (context.now === undefined) return 0;
      return weight * recencyDecay(context.now - numField(stored, term.field), term.halfLifeMs);
    }
    case "geoDistance": {
      if (!context.origin) return 0;
      const lat = coord(stored, term.latField);
      const lng = coord(stored, term.lngField);
      if (lat === null || lng === null) return 0;
      const d = haversineKm(context.origin.lat, context.origin.lng, lat, lng);
      return weight * Math.max(0, 1 - d / term.maxKm);
    }
    case "relevance":
      return weight * textMatch;
  }
}

// Weighted blend of terms for one document. `weights` overrides a term's weight
// by id; `textMatch` is the doc's raw relevance score (0 in browse).
export function evalTerms(
  stored: Record<string, unknown>,
  terms: RankTerm[],
  weights: Record<string, number> | undefined,
  textMatch: number,
  context: RankContext,
): number {
  let sum = 0;
  for (const term of terms) {
    const w = weights?.[term.id];
    sum += contribution(term, w === undefined ? term.weight : w, stored, textMatch, context);
  }
  return sum;
}
