// Deterministic synthetic product dataset generator for stress-testing the
// FuzzySearch component (search, prefix, typo, filtering, faceting, weighted/
// personalized sort) at ~5k documents. Pure + reproducible: no Math.random,
// every product is a function of its index, so re-seeding is identical.

// --- seeded PRNG (mulberry32) ---------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];
const intIn = (r: () => number, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));

// --- vocabulary ------------------------------------------------------------
const ADJECTIVES = [
  "lightweight", "rugged", "premium", "compact", "wireless", "waterproof",
  "ergonomic", "classic", "modern", "eco", "insulated", "foldable",
  "portable", "heavy-duty", "sleek", "vintage", "smart", "quiet",
];
const MATERIALS = [
  "aluminum", "leather", "cotton", "stainless steel", "bamboo", "carbon",
  "merino wool", "silicone", "ceramic", "recycled plastic",
];
const FEATURES = [
  "fast charging", "noise cancellation", "all-day comfort", "a lifetime warranty",
  "machine-washable fabric", "a non-slip grip", "rapid heat-up", "low power draw",
  "trail-ready traction", "a waterproof seal",
];
const USE_CASES = [
  "everyday carry", "outdoor adventures", "home workouts", "the daily commute",
  "long hikes", "the office", "weekend trips", "the kitchen",
];

// category -> { subcategories, product nouns }
const CATEGORIES: Record<string, { subs: string[]; nouns: string[] }> = {
  Electronics: { subs: ["Audio", "Wearables", "Cameras", "Accessories"], nouns: ["headphones", "speaker", "smartwatch", "camera", "charger", "earbuds", "drone"] },
  Outdoors: { subs: ["Camping", "Hiking", "Cycling"], nouns: ["tent", "backpack", "jacket", "water bottle", "lantern", "sleeping bag", "trekking poles"] },
  Footwear: { subs: ["Running", "Trail", "Casual"], nouns: ["running shoe", "trail shoe", "sneaker", "boot", "sandal"] },
  Apparel: { subs: ["Tops", "Outerwear", "Base Layers"], nouns: ["t-shirt", "hoodie", "rain jacket", "leggings", "vest"] },
  Home: { subs: ["Lighting", "Decor", "Storage"], nouns: ["lamp", "rug", "shelf", "throw blanket", "organizer"] },
  Kitchen: { subs: ["Cookware", "Appliances", "Tools"], nouns: ["skillet", "kettle", "blender", "knife set", "cutting board"] },
  Fitness: { subs: ["Strength", "Cardio", "Recovery"], nouns: ["yoga mat", "dumbbell", "resistance band", "foam roller", "jump rope"] },
  Beauty: { subs: ["Skincare", "Haircare", "Tools"], nouns: ["moisturizer", "shampoo", "hair dryer", "razor", "serum"] },
  Toys: { subs: ["Building", "Puzzles", "Outdoor"], nouns: ["building set", "puzzle", "kite", "board game", "remote car"] },
  Books: { subs: ["Fiction", "Cooking", "Tech"], nouns: ["novel", "cookbook", "guidebook", "notebook", "planner"] },
  Garden: { subs: ["Tools", "Planters", "Decor"], nouns: ["pruner", "planter", "hose", "watering can", "trowel"] },
  Office: { subs: ["Desk", "Storage", "Tech"], nouns: ["desk lamp", "monitor stand", "keyboard", "mouse", "notebook"] },
};
const CATEGORY_NAMES = Object.keys(CATEGORIES);

// 40 deterministic brand names
const BRAND_PREFIX = ["Aur", "Nim", "Ver", "Pol", "Kor", "Zen", "Lum", "Tor", "Vel", "Hax"];
const BRAND_SUFFIX = ["ora", "bus", "tex", "aris", "vex", "ity"];
const BRANDS: string[] = [];
for (const p of BRAND_PREFIX) for (const s of BRAND_SUFFIX) BRANDS.push(p + s);
// -> 60 unique brands; keep first 40
BRANDS.length = 40;

export type Product = {
  id: string;
  name: string;
  description: string;
  brand: string;
  category: string;
  subcategory: string;
  price: number;
  rating: number;
  popularity: number;
  views: number;
  purchases: number;
  releasedDaysAgo: number;
  inStock: string; // "true" | "false"
  affinity: number; // precomputed match to USER_PROFILE
  image: string;
};

// Demo user preference profile — what "personalization" is scored against.
export const USER_PROFILE = {
  preferredCategories: ["Electronics", "Outdoors"],
  preferredBrands: ["Aurora", "Vertex"], // may or may not exist in BRANDS; matched by string
  pastSearchTerms: ["wireless", "trail", "waterproof"],
  viewsEveryNth: 137, // product ids where index % N === 0 count as "previously viewed"
};

function computeAffinity(p: {
  category: string;
  brand: string;
  name: string;
  description: string;
  index: number;
}): number {
  let a = 0;
  if (USER_PROFILE.preferredCategories.includes(p.category)) a += 3;
  if (USER_PROFILE.preferredBrands.includes(p.brand)) a += 2;
  const hay = (p.name + " " + p.description).toLowerCase();
  if (USER_PROFILE.pastSearchTerms.some((t) => hay.includes(t))) a += 2;
  if (p.index % USER_PROFILE.viewsEveryNth === 0) a += 1;
  return a;
}

// Generate the product at a given index (0-based). Deterministic.
export function generateProduct(index: number): Product {
  const r = rng(index + 1);
  const category = pick(r, CATEGORY_NAMES);
  const { subs, nouns } = CATEGORIES[category];
  const subcategory = pick(r, subs);
  const brand = pick(r, BRANDS);
  const adj = pick(r, ADJECTIVES);
  const material = pick(r, MATERIALS);
  const noun = pick(r, nouns);
  const model = "M" + intIn(r, 100, 999);

  const name = `${adj} ${noun} ${model}`;
  const description = `A ${adj} ${material} ${noun} with ${pick(r, FEATURES)} and ${pick(r, FEATURES)}, ideal for ${pick(r, USE_CASES)}.`;

  const id = "p" + String(index + 1).padStart(5, "0");
  const affinity = computeAffinity({ category, brand, name, description, index });

  return {
    id,
    name,
    description,
    brand,
    category,
    subcategory,
    price: intIn(r, 5, 500),
    rating: Math.round((1 + r() * 4) * 10) / 10,
    popularity: intIn(r, 0, 1000),
    views: intIn(r, 0, 10000),
    purchases: intIn(r, 0, 2000),
    releasedDaysAgo: intIn(r, 0, 1000),
    inStock: r() < 0.85 ? "true" : "false",
    affinity,
    image: `https://picsum.photos/seed/${id}/300`,
  };
}

// Generate a contiguous range of products as { id, doc } upsert entries.
export function generateRange(start: number, count: number) {
  const out: { id: string; doc: Record<string, unknown> }[] = [];
  for (let i = start; i < start + count; i++) {
    const p = generateProduct(i);
    out.push({ id: p.id, doc: p as unknown as Record<string, unknown> });
  }
  return out;
}
