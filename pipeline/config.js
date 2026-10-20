// Everything race-specific lives here, so a new cycle or a renamed market only needs edits in one place.

export const ELECTION = {
  year: 2026,
  date: "2026-11-03",
  // Election-night loop window (UTC). 6 PM CST Nov 3 = 00:00 UTC Nov 4; 2 AM CST = 08:00 UTC.
  nightStart: "2026-11-03T23:45:00Z",
  nightEnd: "2026-11-04T08:15:00Z",
  // Election week: high-frequency cron runs are honored only inside this window.
  weekStart: "2026-10-31T00:00:00Z",
  weekEnd: "2026-11-07T06:00:00Z",
};

export const RACES = {
  senate: {
    title: "U.S. Senate",
    candidates: { D: "James Talarico", R: "Ken Paxton" },
    // Texas SOS office name, e.g. "U. S. SENATOR ".
    sosOffice: /^\s*U\.?\s*S\.?\s*SENATOR\b/i,
    wikipedia: { page: "2026_United_States_Senate_election_in_Texas", section: /^General election$/i },
    kalshi: { query: "texas senate", title: /^texas senate winner/i },
    polymarket: { query: "texas senate", title: /^texas senate election winner$/i },
  },
  governor: {
    title: "Governor",
    candidates: { D: "Gina Hinojosa", R: "Greg Abbott" },
    sosOffice: /^\s*GOVERNOR\s*$/i,
    wikipedia: { page: "2026_Texas_gubernatorial_election", section: /^General election$/i },
    kalshi: { query: "texas governor", title: /^texas governor winner/i },
    polymarket: { query: "texas governor", title: /^texas governor election winner$/i },
  },
};

// Pollsters (or sponsors) whose polls count toward the average. Matched case-insensitively against
// the "Poll source" cell, which on Wikipedia includes the sponsor in parentheses.
export const TRUSTED_POLLSTERS = [
  { name: "Texas Politics Project (UT Austin)", match: /texas politics project|university of texas(?! at tyler)|\bUT[\s/-]*austin\b/i },
  { name: "UT Tyler", match: /\bUT[\s-]*Tyler\b|university of texas at tyler/i },
  { name: "UH Hobby School", match: /hobby school|university of houston/i },
  { name: "Texas Tribune & partners", match: /texas tribune/i },
  { name: "Texas Southern University (Texas Tribune partner)", match: /texas southern university|\bTSU\b/i },
  { name: "Emerson College", match: /emerson/i },
  { name: "TPOR", match: /\bTPOR\b|texas public opinion research/i },
  { name: "Quinnipiac", match: /quinnipiac/i },
  { name: "Marist", match: /marist/i },
  { name: "NYT/Siena", match: /siena|new york times|\bNYT\b/i },
];

// Polling average parameters (documented in README).
export const AVERAGE = {
  halfLifeDays: 14,      // recency: a poll's weight halves every 14 days
  maxAgeDays: 120,       // ignore polls older than this
  baseSample: 800,       // sample-size weight = sqrt(n / baseSample), capped below
  maxSampleWeight: 1.6,
  // Registered-voter and adult samples have tended to run more Democratic than likely-voter
  // samples in Texas midterms; shift them toward R and trust them a little less.
  population: {
    LV: { shift: 0, weight: 1 },
    RV: { shift: 1.5, weight: 0.8 },
    A: { shift: 2.5, weight: 0.5 },
  },
};
