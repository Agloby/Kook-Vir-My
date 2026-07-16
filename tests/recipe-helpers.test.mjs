import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIngredientName, namesMatch, unitToBase, convertUnits,
  mergeUnitKey, baseIngredientKey, cleanIngredientDisplayName, mergeCompatibleQuantity,
  categorizeIngredient, getItemCategory, mondayOf, isoDate, daysUntil
} from '../netlify-site/recipe-helpers.js';

test('normalizeIngredientName singularizes and applies synonyms', () => {
  assert.equal(normalizeIngredientName('Onions'), 'onion');
  assert.equal(normalizeIngredientName('Tomatoes'), 'tomato');
  assert.equal(normalizeIngredientName('scallions'), 'spring onion');
  assert.equal(normalizeIngredientName('Bell Peppers (diced)'), 'pepper');
});

test('namesMatch requires whole-word containment, not any substring', () => {
  assert.ok(namesMatch('onion', 'onions'));
  assert.ok(namesMatch('spring onion', 'spring onions'));
  assert.ok(!namesMatch('on', 'onion')); // "on" is not a whole word inside "onion"
  assert.ok(!namesMatch('onion', 'garlic'));
});

test('unitToBase/convertUnits convert within a family but refuse across incompatible ones', () => {
  assert.equal(convertUnits(1, 'kg', 'g'), 1000);
  assert.equal(convertUnits(2, 'tbsp', 'ml'), 30);
  assert.equal(convertUnits(2, 'g', 'ml'), null);
  assert.equal(convertUnits(3, 'clove', 'clove'), 3);
  assert.equal(convertUnits(3, 'clove', 'egg'), null);
});

test('mergeUnitKey folds plain-count wordings into one bucket', () => {
  assert.equal(mergeUnitKey(''), mergeUnitKey('x'));
  assert.equal(mergeUnitKey('whole'), mergeUnitKey('each'));
  assert.notEqual(mergeUnitKey('g'), mergeUnitKey(''));
});

test('baseIngredientKey strips prep phrasing so different phrasings of the same item collide', () => {
  assert.equal(baseIngredientKey('lemon'), baseIngredientKey('zest of lemon'));
  assert.equal(baseIngredientKey('lemon'), baseIngredientKey('juice of lemon'));
  assert.equal(baseIngredientKey('garlic, minced'), baseIngredientKey('garlic'));
});

test('cleanIngredientDisplayName keeps a readable name, not the matching key', () => {
  assert.equal(cleanIngredientDisplayName('zest of 1 lemon'), '1 lemon');
  assert.equal(cleanIngredientDisplayName('garlic, minced'), 'garlic');
});

test('mergeCompatibleQuantity sums same-unit or convertible amounts', () => {
  assert.deepEqual(mergeCompatibleQuantity(1, 'kg', 500, 'g'), { quantity: 1.5, unit: 'kg' });
  assert.deepEqual(mergeCompatibleQuantity(2, '', 1, 'x'), { quantity: 3, unit: 'x' });
});

test('mergeCompatibleQuantity refuses to invent a number across incompatible units', () => {
  assert.equal(mergeCompatibleQuantity(1, 'zest', 1, 'juice'), null);
  assert.equal(mergeCompatibleQuantity(null, 'g', 1, 'g'), null);
});

test('categorizeIngredient groups the way a shop is laid out', () => {
  assert.equal(categorizeIngredient('Chicken breast'), 'Meat & Fish');
  assert.equal(categorizeIngredient('Tinned chickpeas'), 'Tins & Jars');
  assert.equal(categorizeIngredient('Something unrecognised'), 'Household & Other');
});

test('getItemCategory prefers a stored category over recomputing one', () => {
  assert.equal(getItemCategory({ category: 'Frozen', item_name: 'chicken' }), 'Frozen');
  assert.equal(getItemCategory({ item_name: 'chicken' }), 'Meat & Fish');
});

test('mondayOf always returns the Monday of that week, Sunday included', () => {
  assert.equal(isoDate(mondayOf(new Date('2026-07-15T12:00:00'))), '2026-07-13'); // Wednesday
  assert.equal(isoDate(mondayOf(new Date('2026-07-19T12:00:00'))), '2026-07-13'); // Sunday
  assert.equal(isoDate(mondayOf(new Date('2026-07-13T12:00:00'))), '2026-07-13'); // Monday itself
});

test('daysUntil is exact across a DST transition night, not off by one', () => {
  // Ireland's clocks went forward on 2026-03-29 (that local day is only 23 hours).
  const beforeSpringForward = new Date('2026-03-28T00:00:00');
  assert.equal(daysUntil('2026-03-30', beforeSpringForward), 2);
  // Clocks went back on 2026-10-25 (that local day is 25 hours).
  const beforeFallBack = new Date('2026-10-24T00:00:00');
  assert.equal(daysUntil('2026-10-26', beforeFallBack), 2);
});

test('daysUntil handles the ordinary case', () => {
  assert.equal(daysUntil('2026-07-20', new Date('2026-07-15T09:00:00')), 5);
  assert.equal(daysUntil(null), null);
});
