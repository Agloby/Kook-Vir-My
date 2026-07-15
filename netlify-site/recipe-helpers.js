// Pure ingredient/date/category logic shared across recipes, Koskas, meal plan and shopping
// lists - split out from index.html (matching the pepesto-helpers.js pattern) so it can be
// exercised with real unit tests instead of only ever running inside the browser.

// ---------------- SHOPPING LIST CATEGORIES (aisle-style grouping) ----------------
// Best-effort keyword grouping so a list reads the way a shop is laid out (produce
// together, meat/fish together, etc.) rather than in whatever order ingredients were
// listed. Order here also sets display/export order.
export const CATEGORY_ORDER = ['Fruit & Veg', 'Meat & Fish', 'Dairy & Eggs', 'Bakery', 'Pantry & Dry Goods', 'Tins & Jars', 'Frozen', 'Drinks', 'Household & Other'];
export const CATEGORY_KEYWORDS = {
  'Fruit & Veg': ['onion','garlic','tomato','potato','carrot','pepper','courgette','aubergine','cucumber','lettuce','spinach','kale','broccoli','cauliflower','mushroom','apple','banana','lemon','lime','orange','avocado','ginger','chilli','chili','herb','parsley','coriander','basil','mint','rocket','celery','leek','sweetcorn','scallion','spring onion'],
  'Meat & Fish': ['chicken','beef','pork','lamb','mince','minced beef','bacon','sausage','turkey','salmon','tuna','cod','prawn','shrimp','fish','anchovy','trout','mackerel','sardine','haddock','ham','chorizo','steak'],
  'Dairy & Eggs': ['milk','cheese','butter','cream','yogurt','yoghurt','egg','parmesan','mozzarella','feta','cheddar','crème fraîche','mascarpone'],
  'Bakery': ['bread','baguette','roll','bun','tortilla','wrap','pitta','naan','bagel'],
  'Frozen': ['frozen','ice cream','peas'],
  'Tins & Jars': ['tinned','canned','tin of','jar of','passata','tomato puree','tomato paste','chickpea','kidney bean','baked beans'],
  'Drinks': ['wine','beer','juice','soda','water','coffee','tea'],
  'Pantry & Dry Goods': ['flour','sugar','rice','pasta','spaghetti','penne','noodle','oil','olive oil','vinegar','stock','stock cube','herbs','spice','salt','pepper','pepper flakes','cumin','paprika','oregano','cinnamon','honey','soy sauce','yeast','baking powder','couscous','lentil','oat']
};
export function categorizeIngredient(name){
  const lower = (name||'').toLowerCase();
  for(const cat of CATEGORY_ORDER){
    const keywords = CATEGORY_KEYWORDS[cat];
    if(keywords && keywords.some(k => lower.includes(k))) return cat;
  }
  return 'Household & Other';
}
export function getItemCategory(item){
  return item.category || categorizeIngredient(item.item_name);
}

// ---------------- INGREDIENT NAME / UNIT NORMALIZATION ----------------
// Conservative on purpose: a wrong match silently corrupts the stock register,
// a missed match just means the user adjusts by hand.
export const INGREDIENT_SYNONYMS = {
  'scallion':'spring onion', 'scallions':'spring onion', 'green onion':'spring onion',
  'cilantro':'coriander', 'zucchini':'courgette', 'eggplant':'aubergine',
  'garbanzo bean':'chickpea', 'garbanzo':'chickpea',
  'bell pepper':'pepper', 'capsicum':'pepper',
  'mince':'minced beef', 'ground beef':'minced beef',
  'rocket':'rocket', 'arugula':'rocket',
  'corn':'sweetcorn', 'maize':'sweetcorn',
  'tinned tomato':'tinned tomatoes', 'canned tomato':'tinned tomatoes', 'canned tomatoes':'tinned tomatoes'
};
export function singularize(word){
  if(word.length <= 3) return word;
  if(word.endsWith('ies')) return word.slice(0,-3) + 'y';
  if(word.endsWith('oes')) return word.slice(0,-2);
  if(word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes') || word.endsWith('ches') || word.endsWith('shes')) return word.slice(0,-2);
  if(word.endsWith('ss')) return word;
  if(word.endsWith('s')) return word.slice(0,-1);
  return word;
}
export function normalizeIngredientName(name){
  let s = (name||'').toLowerCase()
    .replace(/\(.*?\)/g, ' ')                 // "(optional)", "(diced)"
    .replace(/[.,;:!?"'’·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if(INGREDIENT_SYNONYMS[s]) s = INGREDIENT_SYNONYMS[s];
  const words = s.split(' ').map(singularize);
  let joined = words.join(' ');
  if(INGREDIENT_SYNONYMS[joined]) joined = INGREDIENT_SYNONYMS[joined];
  return joined;
}
export function namesMatch(a, b){
  const na = normalizeIngredientName(a), nb = normalizeIngredientName(b);
  if(!na || !nb) return false;
  if(na === nb) return true;
  // whole-word containment only ("onion" must not match "spring onion" one-way surprises;
  // require the shorter name to appear as a whole-word phrase inside the longer)
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return new RegExp('(^| )' + shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(longer);
}
// Convert an amount between unit families where it is safe to do so. Returns null
// when the conversion isn't safe to guess.
export function unitToBase(amount, unit){
  const u = (unit||'').toLowerCase().replace(/\./g,'').trim();
  if(['g','gram','grams'].includes(u)) return { qty: amount, base:'g' };
  if(['kg','kilogram','kilograms'].includes(u)) return { qty: amount*1000, base:'g' };
  if(['ml','millilitre','millilitres','milliliter','milliliters'].includes(u)) return { qty: amount, base:'ml' };
  if(['l','litre','litres','liter','liters'].includes(u)) return { qty: amount*1000, base:'ml' };
  if(['tsp','teaspoon','teaspoons'].includes(u)) return { qty: amount*5, base:'ml' };
  if(['tbsp','tablespoon','tablespoons'].includes(u)) return { qty: amount*15, base:'ml' };
  if(['','x','piece','pieces','pc','pcs','count','item','items','unit','units','tin','tins','can','cans','pack','packs','clove','cloves','egg','eggs'].includes(u)) return { qty: amount, base:'count:'+u };
  return null;
}
export function convertUnits(amount, fromUnit, toUnit){
  const f = (fromUnit||'').toLowerCase().trim(), t = (toUnit||'').toLowerCase().trim();
  if(f === t) return amount;
  const from = unitToBase(amount, fromUnit), to = unitToBase(1, toUnit);
  if(!from || !to) return null;
  if(from.base.startsWith('count:') && to.base.startsWith('count:')){
    // pieces/count only convert when they are literally the same unit word
    return f === t ? amount : null;
  }
  if(from.base !== to.base) return null;
  return from.qty / to.qty; // to.qty is the base-size of 1 target unit
}

// ---------------- SHOPPING LIST INGREDIENT MERGING ----------------
// Recipes phrase the same shop item differently ("2 lemons", "zest of 1 lemon", "juice of 1
// lemon") - a shopping list that keeps those as three separate lines is not a proper list.
// These helpers fold matching lines together when items are added, whether they come from the
// same batch or a separate recipe added later.
export const PLAIN_COUNT_UNITS = new Set(['', 'x', 'whole', 'each', 'piece', 'pieces', 'unit', 'units']);
export function mergeUnitKey(unit){
  const u = (unit||'').toLowerCase().trim();
  return PLAIN_COUNT_UNITS.has(u) ? '' : u; // fold plain-count wordings into one bucket
}
// Only strips prep phrasing for MATCHING (aggressive is fine here); display name is cleaned
// separately and more conservatively so it stays readable.
export function baseIngredientKey(name){
  let s = (name||'').toLowerCase().trim();
  s = s.replace(/^(zest of|juice of|a handful of|a pinch of|a splash of|a drizzle of)\s+/, '');
  s = s.replace(/,?\s*\b(zested|grated|peeled|chopped|sliced|crushed|minced|diced|juiced)\b\s*$/, '');
  return normalizeIngredientName(s);
}
export function cleanIngredientDisplayName(name){
  let s = (name||'').trim();
  s = s.replace(/^(zest of|juice of|a handful of|a pinch of|a splash of|a drizzle of)\s+/i, '');
  s = s.replace(/\s*,?\s*\b(zested|grated|peeled|chopped|sliced|crushed|minced|diced|juiced)\b\s*$/i, '');
  return s.trim() || name;
}
// Tries to combine two quantities into one real number; returns null when that isn't safe
// (different, unconvertible units, or either side is a vague amount like "to taste").
export function mergeCompatibleQuantity(existingQty, existingUnit, newQty, newUnit){
  if(existingQty == null || newQty == null) return null;
  if(mergeUnitKey(existingUnit) === mergeUnitKey(newUnit)) return { quantity: Number((existingQty + newQty).toFixed(2)), unit: existingUnit || newUnit };
  const converted = convertUnits(newQty, newUnit, existingUnit);
  if(converted !== null) return { quantity: Number((existingQty + converted).toFixed(2)), unit: existingUnit };
  return null;
}

// ---------------- DATE / WEEK MATH ----------------
export function mondayOf(d){
  const date = new Date(d); date.setHours(0,0,0,0);
  const day = (date.getDay() + 6) % 7; // Monday = 0
  date.setDate(date.getDate() - day);
  return date;
}
// local-date formatting on purpose: toISOString() is UTC and would shift
// local-midnight dates back a day during Irish summer time
export function isoDate(d){ return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }

// Diffing two local-midnight Date objects by raw milliseconds breaks on the specific nights
// Ireland's clocks change (that local day is 23 or 25 real hours, not 24), which can shift the
// result by a day right around a DST transition. Date.UTC on the same Y/M/D numbers sidesteps
// that entirely, since every UTC calendar day is exactly 86400000ms regardless of local DST.
export function daysUntil(dateStr, today = new Date()){
  if(!dateStr) return null;
  const [y, m, day] = dateStr.split('-').map(Number);
  const target = Date.UTC(y, m - 1, day);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - now) / 86400000);
}
