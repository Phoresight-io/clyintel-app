export const DEMO_RESET_KEY = 'clyintel_demo_reset';

export function isDemoReset(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(DEMO_RESET_KEY) === 'true';
}
