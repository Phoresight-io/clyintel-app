import { REV_SHARE_BANDS, MIN_QUALIFYING_FACE } from './bands';

// Version of the fee engine + band calibration. Frozen onto each ledger row
// (rev_share_ledger.engine_version) so a recomputation can be traced back to
// the exact rate config that produced the fee. Bump when bands or fee logic change.
export const ENGINE_VERSION = 'revshare-v1';

export interface RevShareInput {
  invoiceFaceValue: number;
  dollarsRecovered: number;
}

export interface RevShareResult {
  qualifies: boolean;
  band: string | null;   // band id, or null if not qualifying
  rate: number;          // decimal; 0 if not qualifying
  feeAmount: number;     // dollars, floored to cents
}

const NOT_QUALIFYING: RevShareResult = {
  qualifies: false,
  band: null,
  rate: 0,
  feeAmount: 0,
};

// Round DOWN to whole cents so the fee never exceeds the true
// mathematical amount (rate * dollarsRecovered).
function floorToCents(x: number): number {
  return Math.floor(x * 100) / 100;
}

export function computeRevShareFee(input: RevShareInput): RevShareResult {
  const { invoiceFaceValue, dollarsRecovered } = input;

  // 1. Below the qualifying floor → no rev share.
  if (invoiceFaceValue < MIN_QUALIFYING_FACE) {
    return { ...NOT_QUALIFYING };
  }

  // 2. Find the band: minFace inclusive, maxFace exclusive.
  const band = REV_SHARE_BANDS.find(
    (b) => invoiceFaceValue >= b.minFace && invoiceFaceValue < b.maxFace,
  );

  // Defensive: bands cover [300, Infinity), so a qualifying face value
  // always matches. If config is ever mis-calibrated, fail closed.
  if (!band) {
    return { ...NOT_QUALIFYING };
  }

  // 3. Fee is rate * dollarsRecovered (NOT face value), floored to cents.
  return {
    qualifies: true,
    band: band.id,
    rate: band.rate,
    feeAmount: floorToCents(band.rate * dollarsRecovered),
  };
}
