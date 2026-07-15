export const PEPESTO_RETAILERS = [
  { domain: 'tesco.ie', name: 'Tesco Ireland' },
  { domain: 'dunnesstoresgrocery.com', name: 'Dunnes Stores Grocery' },
  { domain: 'shop.supervalu.ie', name: 'SuperValu Ireland' }
];
export const PEPESTO_ESTIMATED_PRICES_EUR = { products: 0.04 };

export function rankComparisonResults(results) {
  return [...results].sort((a, b) => {
    if(Boolean(a.completeBasket) !== Boolean(b.completeBasket)) return a.completeBasket ? -1 : 1;
    const aTotal = Number.isFinite(a.estimatedTotal) ? a.estimatedTotal : Infinity;
    const bTotal = Number.isFinite(b.estimatedTotal) ? b.estimatedTotal : Infinity;
    if(a.completeBasket && b.completeBasket && aTotal !== bTotal) return aTotal - bTotal;
    return (a.unmatchedCount ?? Infinity) - (b.unmatchedCount ?? Infinity);
  });
}

export function cheapestCompleteDomain(results) {
  const candidates = results.filter(r => r.completeBasket && Number.isFinite(r.estimatedTotal));
  if(!candidates.length) return null;
  return candidates.reduce((best, value) => value.estimatedTotal < best.estimatedTotal ? value : best).retailer.domain;
}

export function createRequestGate() {
  let running = false;
  return {
    get running(){ return running; },
    async run(task) {
      if(running) return { skipped: true };
      running = true;
      try { return await task(); }
      finally { running = false; }
    }
  };
}

const HANDOFF_HOSTS = new Set([
  'buy.pepesto.com', 'app.pepesto.com', 's.pepesto.com',
  'tesco.ie', 'www.tesco.ie', 'shop.supervalu.ie',
  'dunnesstoresgrocery.com', 'www.dunnesstoresgrocery.com'
]);

export function validHandoffUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && HANDOFF_HOSTS.has(url.hostname.toLowerCase()) ? url.toString() : null;
  } catch { return null; }
}

export async function settleRetailerComparisons(retailers, invoke) {
  return Promise.allSettled(retailers.map(retailer => invoke(retailer)));
}
