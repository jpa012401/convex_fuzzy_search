// Deterministic synthetic "places" dataset (geo-located venues) for demoing
// geoDistance / recencyDecay. Pure + reproducible like dataset.ts.

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];
const intIn = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const CUISINES = ["Italian", "Japanese", "Mexican", "Thai", "Indian", "French", "Greek", "Korean", "Vietnamese", "American"];
export const CUISINE_OPTIONS = CUISINES;
const ADJ = ["Cozy", "Golden", "Urban", "Rustic", "Little", "Blue", "Corner", "Garden", "Old", "Sunny"];
const NOUN = ["Kitchen", "Bistro", "House", "Table", "Grill", "Den", "Spoon", "Garden", "Room", "Pantry"];

export const CITY_PRESETS: { name: string; lat: number; lng: number }[] = [
  { name: "San Francisco", lat: 37.7749, lng: -122.4194 },
  { name: "New York", lat: 40.7128, lng: -74.006 },
  { name: "London", lat: 51.5074, lng: -0.1278 },
];

export type Place = {
  id: string; name: string; cuisine: string; description: string;
  lat: number; lng: number; rating: number; priceLevel: number;
  openedAt: number; popularity: number; image: string;
};

export function generatePlace(index: number, now: number): { id: string; doc: Place } {
  const r = rng(index + 1);
  const city = CITY_PRESETS[Math.floor(r() * CITY_PRESETS.length)];
  const lat = city.lat + (r() - 0.5) * 0.3;
  const lng = city.lng + (r() - 0.5) * 0.3;
  const cuisine = pick(r, CUISINES);
  const name = `${pick(r, ADJ)} ${pick(r, NOUN)}`;
  const description = `A ${cuisine.toLowerCase()} spot near ${city.name} known for fresh plates and a warm room.`;
  const id = "pl" + String(index + 1).padStart(5, "0");
  const openedDaysAgo = intIn(r, 0, 720);
  return {
    id,
    doc: {
      id, name, cuisine, description, lat, lng,
      rating: Math.round((1 + r() * 4) * 10) / 10,
      priceLevel: intIn(r, 1, 4),
      openedAt: now - openedDaysAgo * 86_400_000,
      popularity: intIn(r, 0, 1000),
      image: `https://picsum.photos/seed/${id}/300`,
    },
  };
}

export function generatePlaceRange(start: number, count: number, now: number): { id: string; doc: Place }[] {
  const out: { id: string; doc: Place }[] = [];
  for (let i = 0; i < count; i++) out.push(generatePlace(start + i, now));
  return out;
}
