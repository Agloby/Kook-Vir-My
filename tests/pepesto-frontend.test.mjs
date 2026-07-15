import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cheapestCompleteDomain, createRequestGate, rankComparisonResults,
  settleRetailerComparisons, validHandoffUrl
} from '../netlify-site/pepesto-helpers.js';

const result = (domain, total, complete, unmatched = 0) => ({
  retailer:{domain}, estimatedTotal:total, completeBasket:complete, unmatchedCount:unmatched
});

test('ranks complete baskets before incomplete baskets', () => {
  const ranked = rankComparisonResults([result('cheap-incomplete', 5, false, 1), result('complete', 10, true)]);
  assert.equal(ranked[0].retailer.domain, 'complete');
});

test('selects the cheapest complete basket only', () => {
  assert.equal(cheapestCompleteDomain([
    result('incomplete', 1, false, 1), result('tesco.ie', 12, true), result('shop.supervalu.ie', 10, true)
  ]), 'shop.supervalu.ie');
});

test('preserves successful retailer results when one fails', async () => {
  const settled = await settleRetailerComparisons(['ok', 'bad', 'also-ok'], async value => {
    if(value === 'bad') throw new Error('failed');
    return value;
  });
  assert.deepEqual(settled.map(x => x.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('request gate prevents duplicate clicks and unlocks afterward', async () => {
  const gate = createRequestGate();
  let release;
  const first = gate.run(() => new Promise(resolve => { release = resolve; }));
  const duplicate = await gate.run(() => Promise.resolve('duplicate ran'));
  assert.deepEqual(duplicate, {skipped:true});
  release('done');
  assert.equal(await first, 'done');
  assert.equal(await gate.run(() => Promise.resolve('again')), 'again');
});

test('client validates checkout handoff URLs', () => {
  assert.equal(validHandoffUrl('https://buy.pepesto.com/cart/1'), 'https://buy.pepesto.com/cart/1');
  assert.equal(validHandoffUrl('https://buy.pepesto.com.evil.test/cart/1'), null);
});
