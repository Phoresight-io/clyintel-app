/**
 * CaptureResult — the closed set of outcomes processCaptureEvent can return.
 * The core never throws on a business rejection; every non-exceptional path
 * resolves to one of these variants.
 */

export type RejectReason =
  | 'unknown_source'
  | 'inactive_source'
  | 'subscriber_not_found'
  | 'ambiguous_subscriber';

export type NoFeeReason =
  | 'not_past_due'
  | 'no_outreach'
  | 'subscriber_inactive'
  | 'below_minimum';

export type CaptureResult =
  | { status: 'written';   ledgerId: string; feeAmount: number; band: string; rate: number }
  | { status: 'duplicate'; ledgerId: string }
  | { status: 'no_fee';    reason: NoFeeReason }
  | { status: 'rejected';  reason: RejectReason };
