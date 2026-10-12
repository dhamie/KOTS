/**
 * Henchman archetypes and recruitment tuning. Adding an archetype here needs no code change.
 * Attributes are 1–100. In Phase 4b they are shown and stored; battles (Phase 7) are what will use them.
 */
export const HENCHMAN_ATTRIBUTES = ["combat", "leadership", "discipline", "negotiation", "logistics", "reliability", "loyalty"] as const;
export type HenchmanAttribute = (typeof HENCHMAN_ATTRIBUTES)[number];

export interface ArchetypeDef {
  key: string;
  label: string;
  blurb: string;
  /** Inclusive range each attribute is rolled from. */
  ranges: Record<HenchmanAttribute, readonly [min: number, max: number]>;
  /** One-off price and daily wage for an average roll; a better roll costs up to 20% more, a worse one up to 20% less. */
  hireCost: number;
  wage: number;
  /** Relative chance of appearing on the recruitment board. */
  weight: number;
}

export const ARCHETYPES: readonly ArchetypeDef[] = [
  {
    key: "agbero",
    label: "Agbero",
    blurb: "Motor-park muscle. Loud, tough, and not always where you left him.",
    ranges: { combat: [55, 85], leadership: [20, 50], discipline: [15, 45], negotiation: [20, 50], logistics: [20, 45], reliability: [30, 60], loyalty: [30, 70] },
    hireCost: 1500,
    wage: 150,
    weight: 30,
  },
  {
    key: "driver",
    label: "Driver",
    blurb: "Knows every back road from Oshodi to the Marina, and how long each one takes at rush hour.",
    ranges: { combat: [20, 45], leadership: [15, 40], discipline: [35, 65], negotiation: [20, 45], logistics: [60, 90], reliability: [45, 75], loyalty: [40, 70] },
    hireCost: 1200,
    wage: 120,
    weight: 25,
  },
  {
    key: "fixer",
    label: "Fixer",
    blurb: "Talks to everyone, owes nobody. Smooths over what muscle would only make worse.",
    ranges: { combat: [10, 35], leadership: [35, 65], discipline: [35, 65], negotiation: [60, 90], logistics: [30, 60], reliability: [35, 70], loyalty: [25, 65] },
    hireCost: 2000,
    wage: 200,
    weight: 15,
  },
  {
    key: "bookkeeper",
    label: "Bookkeeper",
    blurb: "Keeps two sets of ledgers and remembers which is which.",
    ranges: { combat: [5, 25], leadership: [20, 45], discipline: [55, 85], negotiation: [45, 75], logistics: [50, 80], reliability: [60, 90], loyalty: [45, 80] },
    hireCost: 1800,
    wage: 180,
    weight: 15,
  },
  {
    key: "ex_soldier",
    label: "Ex-soldier",
    blurb: "Disciplined and dangerous. Expensive, and knows it.",
    ranges: { combat: [70, 95], leadership: [45, 75], discipline: [65, 95], negotiation: [15, 40], logistics: [35, 60], reliability: [55, 85], loyalty: [35, 75] },
    hireCost: 3500,
    wage: 350,
    weight: 15,
  },
];

/** Personality traits: flavour now, hooks for events and battles later. Each candidate gets one or two. */
export const TRAITS = ["hot-headed", "quiet", "ambitious", "steady", "greedy", "loyal to a fault", "superstitious", "talkative", "patient", "proud"] as const;

export const FIRST_NAMES = [
  "Tunde", "Chidi", "Musa", "Segun", "Emeka", "Bayo", "Ifeanyi", "Sani", "Kunle", "Obinna",
  "Femi", "Yusuf", "Dayo", "Nnamdi", "Gbenga", "Aliyu", "Tobi", "Uche", "Wale", "Ibrahim",
  "Kemi", "Ngozi", "Aisha", "Funke", "Chioma", "Bisi", "Halima", "Yemi", "Adaeze", "Zainab",
] as const;

export const NICKNAMES = [
  "Scatter", "Long Leg", "Small Money", "Iron", "Calculator", "Professor", "Danfo", "Quiet Storm", "Sharp Sharp", "Lagos",
  "No Wahala", "Ojoro", "Big Boy", "Shadow", "Correct", "Area", "Waka", "Pepper", "Gbedu", "Eko",
] as const;

export const RECRUITMENT = {
  /** Candidates on each family's board per day. */
  boardSize: 4,
  /** The board resets at midnight Lagos time (UTC+1, no daylight saving). */
  boardUtcOffsetHours: 1,
  /** Morale a new hire starts with, and its bounds. */
  startingMorale: 70,
  /** Lost once when a wage goes unpaid. */
  unpaidMoralePenalty: 25,
  /** Gained each day a wage is paid. */
  paidMoraleGain: 5,
} as const;
