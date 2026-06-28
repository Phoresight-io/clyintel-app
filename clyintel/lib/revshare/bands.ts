// Rev Share band config — v1 hypothesis, config-driven so bands can be
// re-calibrated post-launch without touching engine logic.
// Boundary rule: lower bound INCLUSIVE, upper bound EXCLUSIVE.
// i.e. a band matches when minFace <= faceValue < maxFace.
// So $5,000.00 falls into band2 (17%), not band1.

export interface RevShareBand {
  id: string;
  minFace: number;   // inclusive
  maxFace: number;   // exclusive
  rate: number;      // decimal, e.g. 0.22
}

export const REV_SHARE_BANDS: readonly RevShareBand[] = [
  { id: 'band1', minFace: 300,   maxFace: 5000,     rate: 0.22 },
  { id: 'band2', minFace: 5000,  maxFace: 25000,    rate: 0.17 },
  { id: 'band3', minFace: 25000, maxFace: 50000,    rate: 0.12 },
  { id: 'band4', minFace: 50000, maxFace: Infinity, rate: 0.08 },
] as const;

export const MIN_QUALIFYING_FACE = 300;
