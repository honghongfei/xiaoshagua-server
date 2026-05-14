export interface TokenBucket {
  take(n?: number): boolean;
}

export function createBucket(ratePerSec: number, burst?: number): TokenBucket {
  const cap = burst ?? Math.max(1, Math.ceil(ratePerSec));
  let tokens = cap;
  let last = Date.now();

  return {
    take(n = 1): boolean {
      const now = Date.now();
      const elapsed = (now - last) / 1000;
      last = now;
      tokens = Math.min(cap, tokens + elapsed * ratePerSec);
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
  };
}
