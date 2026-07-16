import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.5';
import { PEPESTO_RETAILERS, PEPESTO_ESTIMATED_PRICES_EUR, rankComparisonResults, cheapestCompleteDomain, createRequestGate, settleRetailerComparisons, validHandoffUrl } from './pepesto-helpers.js';
import { exportAccountData, leaveHousehold } from './account-tools.js';
import { installClientMonitoring, loadUsageSummary } from './monitoring.js';
import { subscribeToHousehold } from './realtime.js';
import {
  CATEGORY_ORDER, categorizeIngredient, getItemCategory,
  normalizeIngredientName, namesMatch, unitToBase, convertUnits,
  mergeUnitKey, baseIngredientKey, cleanIngredientDisplayName, mergeCompatibleQuantity,
  mondayOf, isoDate, daysUntil
} from './recipe-helpers.js';

const SUPABASE_URL = "https://iwncoqufcivqgjvlynaz.supabase.co";
const SUPABASE_KEY = "sb_publishable_g0dydQ6d0xLcYMoViBFzzw_w1QAXtpp";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CUISINES = ["Quick weeknight","Comfort food","High-protein","Vegetarian","Italian","Asian","Mediterranean","Indian","Mexican","Baking","One-pot","Batch cook / meal prep","Budget-friendly","Slow cooker"];
const ALLERGENS = ["Gluten","Dairy","Shellfish","Fish","Tree nuts","Peanuts","Eggs","Soy","Sesame"];
const DIETS = ["Coeliac","Vegetarian","Vegan","Pescatarian","Low-carb"];
const DEFAULT_SHOPS = ["Tesco Ireland","Dunnes Stores","SuperValu","Lidl Ireland","Aldi Ireland","SPAR","Centra","M&S Food"];
const SHOP_HOMEPAGES = {
  "Tesco Ireland":"https://www.tesco.ie/groceries/", "Dunnes Stores":"https://www.dunnesstoresgrocery.com/",
  "SuperValu":"https://shop.supervalu.ie/", "Lidl Ireland":"https://www.lidl.ie/", "Aldi Ireland":"https://groceries.aldi.ie/",
  "SPAR":"https://www.spar.ie/", "Centra":"https://www.centra.ie/", "M&S Food":"https://www.marksandspencer.ie/"
};

function el(tag, attrs, children){
  const e = document.createElement(tag);
  if(attrs) for(const k in attrs){
    if(k === 'class') e.className = attrs[k];
    else if(k === 'text') e.textContent = attrs[k];
    else if(k === 'style') e.setAttribute('style', attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (children||[]).forEach(c => e.appendChild(c));
  return e;
}

let session = null, profile = null, household = null, shops = [], ingredientPrices = {}, pantryItems = [], leftovers = [];
let unsubscribeRealtime = null;
const reportClientError = installClientMonitoring(supabase, () => !!session?.user);
let lastDeduction = [];
let shoppingLists = [], currentList = null, currentListItems = [];
const pepestoResultsByList = new Map();
const pepestoRequestGate = createRequestGate();
document.getElementById('pepestoCostEstimate').textContent = `Estimated comparison cost: €${(PEPESTO_RETAILERS.length * PEPESTO_ESTIMATED_PRICES_EUR.products).toFixed(2)}. Creating one retailer basket costs approximately €${PEPESTO_ESTIMATED_PRICES_EUR.oneshot.toFixed(2)} extra.`;
let mpWeekStart = null, mpPlan = null, mpItems = [], mpSelected = new Set();
let recipeTagsCache = {}; // recipe_id -> Set of this user's tags
const state = {
  cuisines: new Set(), cuisineFree:"", onHand:[], recipeCount:3, servings:2, units:"metric",
  currentResults: null
};

// Shared accessible-dialog behavior for all modal overlays.
const dialogCloseButtons = {leftoverModal:'skipLeftoverBtn',deductModal:'deductCancelBtn',mealModal:'mealCancelBtn',ratingModal:'cancelRatingBtn'};
let dialogReturnFocus = null;
Object.keys(dialogCloseButtons).forEach(id => {
  const dialog=document.getElementById(id);
  new MutationObserver(() => {
    if(!dialog.classList.contains('hidden')){
      dialogReturnFocus=document.activeElement;
      requestAnimationFrame(() => dialog.querySelector('button,input,select,textarea,[tabindex]:not([tabindex="-1"])')?.focus());
    } else if(dialogReturnFocus instanceof HTMLElement){ dialogReturnFocus.focus(); dialogReturnFocus=null; }
  }).observe(dialog,{attributes:true,attributeFilter:['class']});
  dialog.addEventListener('keydown', e => {
    if(e.key==='Escape'){ document.getElementById(dialogCloseButtons[id])?.click(); return; }
    if(e.key!=='Tab') return;
    const focusable=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')];
    if(!focusable.length) return; const first=focusable[0],last=focusable.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  });
});

// ---------------- AUTH ----------------
supabase.auth.onAuthStateChange((event, sess) => {
  const previousUserId = session?.user?.id;
  session = sess;
  if(sess){
    if(!previousUserId || previousUserId !== sess.user.id || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') showApp();
  } else { showAuth(); }
});

document.getElementById('signInBtn').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const box = document.getElementById('authError'); box.innerHTML = '';
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if(error) box.appendChild(el('div', {class:'error-box', text: error.message}));
});
document.getElementById('signUpBtn').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const box = document.getElementById('authError'); box.innerHTML = '';
  const { error } = await supabase.auth.signUp({ email, password, options:{ emailRedirectTo: window.location.origin } });
  if(error) box.appendChild(el('div', {class:'error-box', text: error.message}));
  else box.appendChild(el('div', {class:'ok-box', text:'Account created. If email confirmation is on, check your inbox, then sign in.'}));
});
document.getElementById('forgotPasswordBtn').addEventListener('click', async () => {
  const email=document.getElementById('authEmail').value.trim(),box=document.getElementById('authError'); box.innerHTML='';
  if(!email){box.appendChild(el('div',{class:'error-box',text:'Enter your email address first.'}));return;}
  const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin});
  box.appendChild(el('div',{class:error?'error-box':'ok-box',text:error?error.message:'Password-reset instructions have been sent if that account exists.'}));
});
document.getElementById('signOutBtn').addEventListener('click', async () => { unsubscribeRealtime?.(); unsubscribeRealtime=null; await supabase.auth.signOut(); });
document.getElementById('exportAccountBtn').addEventListener('click', async () => {
  const status=document.getElementById('accountActionStatus'); status.textContent='Preparing your export…';
  try{await exportAccountData(supabase);status.textContent='Export downloaded.';}catch(err){status.textContent=err.message;reportClientError('account.export',err.message);}
});
document.getElementById('leaveHouseholdBtn').addEventListener('click', async () => {
  if(!confirm('Leave this household? Shared data stays with its other members. You will be moved to a new private household.')) return;
  const status=document.getElementById('accountActionStatus'); status.textContent='Leaving household…';
  try{await leaveHousehold(supabase);location.reload();}catch(err){status.textContent=err.message;reportClientError('household.leave',err.message);}
});
document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
  if(!confirm('Permanently delete your account? Shared household data may remain for other members. This cannot be undone.')) return;
  const typed=prompt('Type DELETE MY ACCOUNT to confirm permanent deletion.'); if(typed!=='DELETE MY ACCOUNT') return;
  const status=document.getElementById('deleteAccountStatus'); status.textContent='Deleting account…';
  const {data,error}=await supabase.functions.invoke('delete-account',{body:{confirmation:typed}});
  if(error||!data?.deleted){status.textContent=data?.error||'Account deletion failed.';return;}
  await supabase.auth.signOut(); location.reload();
});

function showAuth(){
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('appShell').classList.add('hidden');
}
async function showApp(){
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  document.getElementById('userEmail').textContent = session.user.email;
  try {
    await loadProfile();
    await loadHousehold();
    await loadShops();
    await loadIngredientPrices();
    await loadPantry();
    await loadFavourites();
    await refreshUsageSummary();
    unsubscribeRealtime?.();
    unsubscribeRealtime=subscribeToHousehold(supabase,household.id,handleRealtimeChange);
    renderProfileTab();
    renderHouseholdTab();
    renderShopChips();
    updateRemindersStatus();
    maybeShowExpiryNotification();
  } catch(err){
    console.error('Startup failed:', err);
    // Built via el()/textContent rather than innerHTML - err.message ends up here unescaped otherwise.
    const shell = document.getElementById('appShell');
    shell.innerHTML = '';
    const retryBtn = el('button', {class:'btn ghost small', type:'button', text:'Retry'});
    retryBtn.addEventListener('click', () => location.reload());
    shell.appendChild(el('div', {class:'wrap'}, [
      el('div', {class:'panel'}, [
        el('div', {class:'error-box', text: "Setup isn't finished yet: " + err.message}),
        retryBtn
      ])
    ]));
  }
}

async function refreshUsageSummary(){
  const target=document.getElementById('usageSummary');
  try{
    const usage=await loadUsageSummary(supabase);
    const counts=usage.events.reduce((a,e)=>(a[e.category]=(a[e.category]||0)+1,a),{});
    const detail=Object.entries(counts).map(([k,v])=>`${k.replaceAll('_',' ')}: ${v}`).join(', ');
    target.textContent=`Today: €${usage.total.toFixed(2)} estimated third-party usage${detail?` (${detail})`:''}.${usage.alerts.length?` ${usage.alerts.length} unacknowledged cost alert(s).`:''}`;
  }catch{target.textContent='Usage summary is temporarily unavailable.';}
}

async function handleRealtimeChange(table){
  if(table==='shopping_lists'||table==='shopping_list_items') await loadShoppingLists();
  else if(table==='meal_plans'||table==='meal_plan_items') await loadMealPlan();
  else if(table==='pantry_items'){await loadPantry();renderPantryList();}
  else if(table==='leftovers') await loadLeftovers();
  else if(table==='usage_alerts') await refreshUsageSummary();
}

// ---------------- PROFILE ----------------
async function loadProfile(){
  let { data, error } = await supabase.from('profiles').select('id,units_preference,goals').eq('id', session.user.id).maybeSingle();
  if(error) throw new Error('Your profile could not be loaded.');
  if(!data){
    // trigger may not have fired yet on brand-new signup, retry once
    await new Promise(r => setTimeout(r, 1200));
    ({ data, error } = await supabase.from('profiles').select('id,units_preference,goals').eq('id', session.user.id).maybeSingle());
    if(error) throw new Error('Your profile could not be loaded.');
  }
  profile = data || { id: session.user.id, units_preference:'metric', goals:{} };
  state.units = profile.units_preference || 'metric';
  document.querySelectorAll('#unitsToggle .chip').forEach(c => { const sel = c.dataset.unit === state.units; c.classList.toggle('selected', sel); c.setAttribute('aria-pressed', String(sel)); });
  const g = profile.goals || {};
  document.getElementById('goalWeightInput').value = g.weight || '';
  document.getElementById('goalTrainingInput').value = g.training || '';
  document.getElementById('goalNotesInput').value = g.notes || '';
}

document.getElementById('saveGoalsBtn').addEventListener('click', async () => {
  const goals = {
    weight: document.getElementById('goalWeightInput').value.trim(),
    training: document.getElementById('goalTrainingInput').value.trim(),
    notes: document.getElementById('goalNotesInput').value.trim()
  };
  const { error } = await supabase.from('profiles').update({ goals }).eq('id', session.user.id);
  if(error){ showToast('Could not save goals: ' + error.message, true); return; }
  profile.goals = goals;
  showToast('Goals saved');
});

// ---------------- HOUSEHOLD (shared between everyone who joins with the invite code) ----------------
async function loadHousehold(){
  let { data: membership, error: membershipError } = await supabase.from('household_members').select('household_id, role').eq('user_id', session.user.id).maybeSingle();
  if(membershipError) throw new Error('Your household membership could not be loaded.');
  if(!membership){
    await new Promise(r => setTimeout(r, 1500));
    ({ data: membership, error: membershipError } = await supabase.from('household_members').select('household_id, role').eq('user_id', session.user.id).maybeSingle());
    if(membershipError) throw new Error('Your household membership could not be loaded.');
  }
  if(!membership){
    await new Promise(r => setTimeout(r, 2500));
    ({ data: membership, error: membershipError } = await supabase.from('household_members').select('household_id, role').eq('user_id', session.user.id).maybeSingle());
    if(membershipError) throw new Error('Your household membership could not be loaded.');
  }
  if(!membership){
    document.getElementById('profileHint').innerHTML = '';
    document.getElementById('profileHint').appendChild(el('div', {class:'error-box', text:'Your household record hasn\'t appeared yet, this can happen right after signing up. Try refreshing the page in a moment.'}));
    throw new Error('No household membership found for this account yet.');
  }
  const { data: h, error: householdError } = await supabase.from('households')
    .select('id,invite_code,allergies,diets,delivery_address,delivery_eircode,delivery_lat,delivery_lon')
    .eq('id', membership.household_id).single();
  if(householdError || !h) throw new Error('Your household could not be loaded.');
  household = h;
  document.getElementById('addrInput').value = household.delivery_address || '';
  document.getElementById('eircodeInput').value = household.delivery_eircode || '';
  const hint = document.getElementById('profileHint');
  hint.textContent = (household.allergies||[]).length || (household.diets||[]).length
    ? `Applying from your household: avoiding ${[...(household.allergies||[]), ...(household.diets||[])].join(', ')}. Change this under Profile & shops.`
    : 'No allergies or diet set for your household yet — add them under Profile & shops so every recipe respects them automatically.';
}

function renderHouseholdTab(){
  document.getElementById('inviteCodeText').textContent = household.invite_code;
}

document.getElementById('copyInviteBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(household.invite_code);
  document.getElementById('inviteStatus').textContent = 'Copied. Send it to whoever should share this household.';
});

document.getElementById('joinHouseholdBtn').addEventListener('click', async () => {
  const code = document.getElementById('joinCodeInput').value.trim();
  const status = document.getElementById('joinStatus');
  if(!code) return;
  // Joining another household reassigns your own membership row away from this one - make
  // sure that's really intended before it happens, since there's no undo without the old code.
  if(!confirm('Joining this code will move your account to that household, and you\'ll stop seeing this household\'s recipes, pantry and lists (unless you still have its invite code to switch back). Continue?')) return;
  const { error } = await supabase.rpc('join_household', { p_code: code });
  if(error){ status.textContent = 'Could not join: ' + error.message; return; }
  status.textContent = 'Joined. Reloading your household…';
  await loadHousehold();
  await loadShops();
  await loadIngredientPrices();
  await loadFavourites();
  renderProfileTab();
  renderHouseholdTab();
  renderShopChips();
  status.textContent = 'You now share this household.';
});

function renderProfileTab(){
  const allergyWrap = document.getElementById('profAllergyChips'); allergyWrap.innerHTML = '';
  ALLERGENS.forEach(a => {
    const isSelected = (household.allergies||[]).includes(a);
    const chip = el('button', {type:'button', class:'chip warn' + (isSelected ? ' selected':''), 'aria-pressed': String(isSelected), text:a});
    chip.addEventListener('click', () => {
      household.allergies = household.allergies || [];
      const i = household.allergies.indexOf(a);
      if(i>-1) household.allergies.splice(i,1); else household.allergies.push(a);
      chip.classList.toggle('selected');
      chip.setAttribute('aria-pressed', String(chip.classList.contains('selected')));
    });
    allergyWrap.appendChild(chip);
  });
  const dietWrap = document.getElementById('profDietChips'); dietWrap.innerHTML = '';
  DIETS.forEach(d => {
    const isSelected = (household.diets||[]).includes(d);
    const chip = el('button', {type:'button', class:'chip' + (isSelected ? ' selected':''), 'aria-pressed': String(isSelected), text:d});
    chip.addEventListener('click', () => {
      household.diets = household.diets || [];
      const i = household.diets.indexOf(d);
      if(i>-1) household.diets.splice(i,1); else household.diets.push(d);
      chip.classList.toggle('selected');
      chip.setAttribute('aria-pressed', String(chip.classList.contains('selected')));
    });
    dietWrap.appendChild(chip);
  });
}

document.getElementById('saveDietBtn').addEventListener('click', async () => {
  const { error } = await supabase.from('households').update({ allergies: household.allergies||[], diets: household.diets||[] }).eq('id', household.id);
  if(error){ showToast('Could not save: ' + error.message, true); return; }
  showToast('Saved');
  await loadHousehold();
});

document.querySelectorAll('#unitsToggle .chip').forEach(chip => {
  chip.addEventListener('click', async () => {
    const previous = state.units;
    document.querySelectorAll('#unitsToggle .chip').forEach(c => { c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
    chip.classList.add('selected'); chip.setAttribute('aria-pressed', 'true');
    state.units = chip.dataset.unit;
    const { error } = await safeDb(supabase.from('profiles').update({ units_preference: state.units }).eq('id', session.user.id), 'Could not save units preference');
    if(error){
      state.units = previous;
      document.querySelectorAll('#unitsToggle .chip').forEach(c => { const sel = c.dataset.unit === previous; c.classList.toggle('selected', sel); c.setAttribute('aria-pressed', String(sel)); });
    }
  });
});

document.getElementById('saveAddrBtn').addEventListener('click', async () => {
  const address = document.getElementById('addrInput').value.trim();
  const eircode = document.getElementById('eircodeInput').value.trim();
  const status = document.getElementById('geocodeStatus');
  status.textContent = 'Saving…';
  let lat = household.delivery_lat, lon = household.delivery_lon;
  if(address){
    try {
      const { data, error } = await supabase.functions.invoke('maps-proxy', {body:{action:'geocode', address:[address,eircode].filter(Boolean).join(' ')}});
      if(!error && Number.isFinite(data?.lat) && Number.isFinite(data?.lon)){
        lat = data.lat;
        lon = data.lon;
        status.textContent = 'Address saved and located on the map.';
      } else {
        status.textContent = 'Address saved, but it could not be located. Shop search by distance will not work until this resolves.';
      }
    } catch(e){
      status.textContent = 'Address saved, but the geocoding request failed: ' + e.message;
    }
  }
  const { error } = await safeDb(supabase.from('households').update({ delivery_address: address, delivery_eircode: eircode, delivery_lat: lat, delivery_lon: lon }).eq('id', household.id), 'Could not save the address');
  if(error){ status.textContent = 'The address did not save — try again.'; return; }
  household.delivery_address = address; household.delivery_eircode = eircode;
  household.delivery_lat = lat; household.delivery_lon = lon;
  if(status.textContent === 'Saving…') status.textContent = 'Address saved.';
});

// ---------------- SHOPS ----------------
async function loadShops(){
  const { data, error } = await safeDb(supabase.from('shops').select('*').eq('household_id', household.id).order('pinned', {ascending:false}).order('name'), 'Could not load your shops');
  if(error){ shops = shops || []; return; }
  if(data && data.length){ shops = data; }
  else {
    // seed defaults for a brand-new household
    const seed = DEFAULT_SHOPS.map(name => ({ household_id: household.id, name, source:'manual', selected:true }));
    const { data: inserted } = await safeDb(supabase.from('shops').insert(seed).select(), 'Could not set up your default shops');
    shops = inserted || [];
  }
}

function renderShopChips(){
  const wrap = document.getElementById('shopChips'); wrap.innerHTML = '';
  shops.forEach(shop => {
    const chip = el('div', {class:'shop-chip' + (shop.selected ? ' selected':'') + (shop.pinned ? ' pinned':'')});
    const label = el('span', {text: shop.name});
    label.addEventListener('click', async () => {
      shop.selected = !shop.selected;
      const { error } = await safeDb(supabase.from('shops').update({selected:shop.selected}).eq('id', shop.id), 'Could not update the shop');
      if(error) shop.selected = !shop.selected;
      renderShopChips();
    });
    chip.appendChild(label);
    if(shop.distance_km) chip.appendChild(el('span', {class:'shop-meta', text: shop.distance_km.toFixed(1)+'km'}));
    const pinBtn = el('button', {class:'icon-btn', type:'button', title:'Pin'});
    pinBtn.textContent = shop.pinned ? '📌' : '📍';
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      shop.pinned = !shop.pinned;
      const { error } = await safeDb(supabase.from('shops').update({pinned:shop.pinned}).eq('id', shop.id), 'Could not pin the shop');
      if(error) shop.pinned = !shop.pinned;
      renderShopChips();
    });
    chip.appendChild(pinBtn);
    const rmBtn = el('button', {class:'icon-btn', type:'button', title:'Remove'}); rmBtn.textContent = '✕';
    rmBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { error } = await safeDb(supabase.from('shops').delete().eq('id', shop.id), 'Could not remove the shop');
      if(error) return;
      shops = shops.filter(s => s.id !== shop.id); renderShopChips();
    });
    chip.appendChild(rmBtn);
    wrap.appendChild(chip);
  });
}

document.getElementById('shopManualAdd').addEventListener('click', async () => {
  const input = document.getElementById('shopManualInput');
  const name = input.value.trim();
  if(!name) return;
  const { data, error } = await safeDb(supabase.from('shops').insert({ household_id: household.id, name, source:'manual', selected:true }).select().single(), 'Could not add the shop');
  if(error) return;
  if(data){ shops.push(data); renderShopChips(); }
  input.value = '';
});

document.getElementById('findShopsBtn').addEventListener('click', async () => {
  const status = document.getElementById('mapsStatus');
  if(!household.delivery_lat || !household.delivery_lon){ status.textContent = 'Save your address above first so it can be located.'; return; }
  status.textContent = 'Searching within 20km…';
  try {
    const { data, error } = await supabase.functions.invoke('maps-proxy', {body:{action:'nearby',lat:household.delivery_lat,lon:household.delivery_lon}});
    if(error || data?.error){ status.textContent = data?.error || 'Map search failed.'; return; }
    const found = data.places || [];
    let added = 0;
    for(const p of found){
      const name = p.name; if(!name) continue;
      const dLat = p.lat, dLon = p.lon;
      const distance_km = haversineKm(household.delivery_lat, household.delivery_lon, dLat, dLon);
      const existing = shops.find(s => s.name.toLowerCase() === name.toLowerCase());
      if(existing){
        const { error } = await safeDb(supabase.from('shops').update({ distance_km }).eq('id', existing.id), 'Could not update shop distance');
        if(!error) existing.distance_km = distance_km;
      } else {
        const { data: inserted } = await safeDb(supabase.from('shops').insert({ household_id: household.id, name, source:'detected', selected:true, distance_km }).select().single(), 'Could not save a found shop');
        if(inserted){ shops.push(inserted); added++; }
      }
    }
    status.textContent = `Found ${found.length} within 20km, added ${added} new.`;
    renderShopChips();
  } catch(e){
    status.textContent = 'Maps request failed: ' + e.message;
  }
});

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ---------------- INGREDIENT PRICES ----------------
// Keyed by normalizeIngredientName (not raw lowercase text) so a saved price for "onion"
// is found again for "onions" or "red onion" later, same normalization used for pantry matching.
async function loadIngredientPrices(){
  const { data } = await safeDb(supabase.from('ingredient_prices').select('*').eq('household_id', household.id), 'Could not load your saved prices');
  ingredientPrices = {};
  (data||[]).forEach(row => { ingredientPrices[normalizeIngredientName(row.ingredient_name)] = row; });
}
// Every caller passes unit=null, and Postgres treats NULL as never equal to NULL for
// ON CONFLICT matching - an upsert against (household_id,ingredient_name,unit) with a null
// unit therefore never finds the existing row, it just inserts a fresh duplicate every time.
// Look the row up ourselves and update by id when it already exists instead.
async function saveIngredientPrice(name, unit, price){
  const key = normalizeIngredientName(name);
  const existing = ingredientPrices[key];
  const { data, error } = existing
    ? await safeDb(supabase.from('ingredient_prices').update({ price, unit }).eq('id', existing.id).select().single(), 'Could not save the price')
    : await safeDb(supabase.from('ingredient_prices').insert({ household_id: household.id, ingredient_name: name, unit, price }).select().single(), 'Could not save the price');
  if(error) return false;
  if(data) ingredientPrices[key] = data;
  showToast('Price saved');
  return true;
}

// ---------------- TABS ----------------
document.querySelectorAll('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected','true');
    ['recipes','favourites','koskas','plan','shopping','profile'].forEach(t => document.getElementById('tab'+t[0].toUpperCase()+t.slice(1)).classList.toggle('hidden', t !== btn.dataset.tab));
    if(btn.dataset.tab === 'favourites') loadFavourites();
    if(btn.dataset.tab === 'koskas'){ loadPantry(); loadLeftovers(); }
    if(btn.dataset.tab === 'plan') loadMealPlan();
    if(btn.dataset.tab === 'shopping') loadShoppingLists();
  });
  btn.addEventListener('keydown', e => {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const tabs=[...document.querySelectorAll('.tabs button')], i=tabs.indexOf(btn);
    const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    tabs[next].focus(); tabs[next].click();
  });
});

// ---------------- WIZARD (cuisine / on-hand / details) ----------------
const cuisineChipsEl = document.getElementById('cuisineChips');
CUISINES.forEach(c => {
  const chip = el('button', {type:'button', class:'chip', 'aria-pressed':'false', text:c});
  chip.addEventListener('click', () => {
    state.cuisines.has(c) ? (state.cuisines.delete(c), chip.classList.remove('selected')) : (state.cuisines.add(c), chip.classList.add('selected'));
    chip.setAttribute('aria-pressed', String(chip.classList.contains('selected')));
  });
  cuisineChipsEl.appendChild(chip);
});
document.getElementById('cuisineFree').addEventListener('input', e => state.cuisineFree = e.target.value);

const onHandListEl = document.getElementById('onHandList');
function renderOnHand(){
  onHandListEl.innerHTML = '';
  state.onHand.forEach((item, idx) => {
    const tag = el('div', {class:'tag'}, [document.createTextNode(item)]);
    const rm = el('button', {type:'button', text:'✕'});
    rm.addEventListener('click', () => { state.onHand.splice(idx,1); renderOnHand(); });
    tag.appendChild(rm);
    onHandListEl.appendChild(tag);
  });
}
function addOnHand(){
  const input = document.getElementById('onHandInput');
  const val = input.value.trim(); if(!val) return;
  state.onHand.push(val); input.value=''; renderOnHand();
}
document.getElementById('onHandAdd').addEventListener('click', addOnHand);
document.getElementById('onHandInput').addEventListener('keydown', e => { if(e.key==='Enter'){ e.preventDefault(); addOnHand(); }});

function updateCounters(){
  document.getElementById('recipeCountVal').textContent = state.recipeCount;
  document.getElementById('servingsVal').textContent = state.servings;
}
document.getElementById('recipeMinus').addEventListener('click', () => { state.recipeCount = Math.max(1, state.recipeCount-1); updateCounters(); });
document.getElementById('recipePlus').addEventListener('click', () => { state.recipeCount = Math.min(6, state.recipeCount+1); updateCounters(); });
document.getElementById('servingsMinus').addEventListener('click', () => { state.servings = Math.max(1, state.servings-1); updateCounters(); });
document.getElementById('servingsPlus').addEventListener('click', () => { state.servings = Math.min(12, state.servings+1); updateCounters(); });
updateCounters();

// ---------------- AI PREFERENCE SUMMARY ----------------
const ALLERGEN_KEYWORDS = {
  'Gluten': ['wheat','flour','barley','rye','pasta','spaghetti','couscous','breadcrumb','bread','noodle','soy sauce','malt'],
  'Dairy': ['milk','cheese','butter','cream','yogurt','yoghurt','whey','ghee','parmesan','mozzarella','crème'],
  'Shellfish': ['shrimp','prawn','crab','lobster','mussel','clam','oyster','scallop','langoustine'],
  'Fish': ['salmon','tuna','cod','anchovy','trout','mackerel','sardine','haddock','fish sauce'],
  'Tree nuts': ['almond','walnut','cashew','pecan','hazelnut','pistachio','macadamia'],
  'Peanuts': ['peanut'],
  'Eggs': ['egg'],
  'Soy': ['soy','soya','tofu','edamame'],
  'Sesame': ['sesame','tahini']
};
// Best-effort keyword scan, a second safety layer on top of the AI prompt instruction, not a
// substitute for reading the label. Flags for review rather than silently blocking, since
// substring matching produces false positives (e.g. "coconut milk" under Dairy) as well as
// missed synonyms it doesn't know about.
function scanForAllergens(recipe, allergyList){
  const hits = [];
  const ingredientText = (recipe.ingredients||[]).map(i => (i.item||'').toLowerCase()).join(' | ');
  allergyList.forEach(a => {
    const keywords = ALLERGEN_KEYWORDS[a];
    if(!keywords) return;
    const matched = keywords.filter(k => ingredientText.includes(k));
    if(matched.length) hits.push({ allergen: a, matched });
  });
  return hits;
}

// One shared pattern for every Supabase read/write that matters: awaits the query,
// surfaces failures to the user (toast) and to the console, returns { data, error }.
// Call sites should bail out (and revert any optimistic UI change) when error is set.
async function safeDb(query, friendlyMessage){
  let res;
  try { res = await query; }
  catch(e){ res = { data: null, error: e }; }
  if(res.error){
    console.error(friendlyMessage, res.error);
    showToast(friendlyMessage + (res.error.message ? ': ' + res.error.message : ''), true);
  }
  return res;
}

function showToast(msg, isError){
  let t = document.getElementById('appToast');
  if(!t){
    t = el('div', {id:'appToast', role:'status', 'aria-live':'polite', style:'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:300; padding:10px 16px; border-radius:7px; font-size:13.5px; max-width:90vw;'});
    document.body.appendChild(t);
  }
  t.style.background = isError ? 'var(--warn)' : 'var(--ok)';
  t.style.color = '#1F2421';
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => { t.style.display = 'none'; }, 4000);
}

async function buildPreferenceSummary(){
  const { data } = await supabase.from('recipe_ratings')
    .select('taste,convenience,cost,serving_size,comment,recipes(title,cuisine,ingredients)')
    .order('created_at', {ascending:false}).limit(20);
  let summary = '';
  if(data && data.length){
    const liked = data.filter(r => (r.taste||0) >= 4).map(r => r.recipes?.title).filter(Boolean);
    const disliked = data.filter(r => (r.taste||0) <= 2).map(r => r.recipes?.title).filter(Boolean);
    const comments = data.filter(r => r.comment).map(r => `"${r.comment}" (on ${r.recipes?.title || 'a past recipe'})`);
    if(liked.length) summary += `This household rated highly in the past: ${liked.join(', ')}. `;
    if(disliked.length) summary += `Rated poorly, avoid similar: ${disliked.join(', ')}. `;
    if(comments.length) summary += `Specific feedback from either person to apply: ${comments.join('; ')}. `;
  }
  summary += await buildTagSummary();
  return summary.trim() || 'No rating history yet.';
}

// Aggregates quick-feedback tags (from both household members) into guidance for the prompt.
async function buildTagSummary(){
  const { data, error } = await safeDb(supabase.from('recipe_feedback_tags')
    .select('tag, recipes(title)')
    .order('created_at', {ascending:false}).limit(120), 'Could not load feedback tags');
  if(error || !data || !data.length) return '';
  const byTag = {};
  data.forEach(t => {
    if(!byTag[t.tag]) byTag[t.tag] = new Set();
    if(t.recipes?.title) byTag[t.tag].add(t.recipes.title);
  });
  const lines = Object.entries(byTag).map(([tag, titles]) => `"${tag}": ${[...titles].slice(0,6).join(', ')}`);
  let s = `Quick feedback tags this household applied to past recipes — ${lines.join(' | ')}. `;
  s += 'Steer by these tags: repeat the style of anything tagged "make again" or "great taste"; never suggest anything similar to recipes tagged "avoid next time"; ';
  if(byTag['too much effort']) s += 'keep effort and washing-up low (past complaints: "too much effort"/"too many dishes"); ';
  if(byTag['too expensive']) s += 'watch cost, especially if budget-friendly was requested (past complaints: "too expensive"); ';
  if(byTag['high protein win']) s += 'high-protein meals land well here; ';
  if(byTag['too bland']) s += 'season boldly, "too bland" has come up; ';
  return s;
}

// ---------------- GENERATE ----------------
document.getElementById('generateBtn').addEventListener('click', generateRecipes);

function buildPantrySummary(){
  const expiring = pantryItems.filter(i => { const d = daysUntil(i.expiry_date); return d !== null && d <= 5 && d >= 0; }).map(i => i.name);
  const low = pantryItems.filter(i => i.par_level != null && i.quantity <= i.par_level).map(i => i.name);
  let s = '';
  if(expiring.length) s += `Expiring within 5 days, prioritise using these: ${expiring.join(', ')}. `;
  if(low.length) s += `Running low: ${low.join(', ')}.`;
  return s || 'Nothing urgent in stock.';
}

function buildGoalsSummary(){
  const g = profile.goals || {};
  const parts = [];
  if(g.weight) parts.push(`weight goal: ${g.weight}`);
  if(g.training) parts.push(`training goal: ${g.training}`);
  if(g.notes) parts.push(g.notes);
  return parts.length ? parts.join('; ') : 'No personal goals set.';
}

function buildPrompt(preferenceSummary){
  const cuisineList = [...state.cuisines].concat(state.cuisineFree ? [state.cuisineFree] : []);
  const allergyList = household.allergies || [];
  const dietList = household.diets || [];
  const shopList = shops.filter(s => s.selected).map(s => s.name);

  return `You are a home cooking assistant with memory of this person's past ratings. Generate ${state.recipeCount} distinct recipe(s). Respond with ONLY valid JSON, no markdown fences, matching exactly this schema:

{
  "recipes": [
    {
      "title": string, "description": string, "cuisine": string,
      "totalTimeMinutes": number, "servings": number,
      "usesOnHand": [string],
      "ingredients": [{"item": string, "amount": string, "unit": string, "estimatedPriceEur": number}],
      "steps": [{"text": string, "timerSeconds": number|null}],
      "allergenNote": string, "shoppingNote": string,
      "estimatedCaloriesPerServing": number, "estimatedProteinGPerServing": number
    }
  ],
  "onHandAlternative": null OR { "title": string, "description": string, "ingredients":[{"item":string,"amount":string,"unit":string,"estimatedPriceEur":number}], "steps":[{"text":string,"timerSeconds":number|null}] }
}

Brief:
- What they want: ${cuisineList.length ? cuisineList.join(', ') : 'no specific type, use your judgement'}
- Must strictly avoid: ${allergyList.length ? allergyList.join(', ') : 'none stated'}
- Diet: ${dietList.length ? dietList.join(', ') : 'none stated'}
- Servings per recipe: ${state.servings}
- Units: ${state.units === 'metric' ? 'metric (grams, millilitres, Celsius)' : 'US customary (cups, ounces, Fahrenheit)'}
- Shops: ${shopList.length ? shopList.join(', ') : 'not specified, typical Irish supermarket'}
- Already in the kitchen: ${state.onHand.length ? state.onHand.join(', ') : 'none listed'}
- Household pantry status: ${buildPantrySummary()}
- This person's personal goals, weight toward recipe style without being preachy about it: ${buildGoalsSummary()}
- What this household has liked/disliked before, use this to steer choices without repeating exact past titles: ${preferenceSummary}

Rules:
- Never include an ingredient conflicting with the avoid-list or diet, under any name or derivative.
- Where reasonable, favour recipes that use pantry items expiring soon over buying new ones.
- estimatedPriceEur is a realistic current-ish typical Irish supermarket price in EUR for the amount specified in that line (not a unit price), your best estimate, it will be labelled as an estimate in the app.
- estimatedCaloriesPerServing and estimatedProteinGPerServing are your best estimate per serving, labelled as estimates in the app, adjust the recipe itself (protein sources, portion) to fit the stated personal goals where they exist.
- timerSeconds should be set on any step involving waiting, cooking, baking, resting, boiling, simmering, chilling; null otherwise.
- If "already in the kitchen" doesn't fit what they asked for, populate onHandAlternative with one recipe primarily using those items; otherwise null.
- Keep steps concise, no more than 8 per recipe. Output raw JSON only.`;
}

async function generateRecipes(){
  const errorBox = document.getElementById('genErrorBox'); errorBox.innerHTML = '';
  document.getElementById('loadingPanel').classList.remove('hidden');
  document.getElementById('generateBtn').disabled = true;
  document.getElementById('resultsBody').innerHTML = '';
  try {
    const preferenceSummary = await buildPreferenceSummary();
    const prompt = buildPrompt(preferenceSummary);
    const parsed = await callClaudeForRecipes(prompt);
    const savedRecipes = await persistRecipes(parsed);
    state.currentResults = savedRecipes;
    renderResults(savedRecipes, parsed.onHandAlternative);
  } catch(err){
    console.error(err);
    errorBox.appendChild(el('div', {class:'error-box', text:'Something went wrong: ' + err.message}));
  } finally {
    document.getElementById('loadingPanel').classList.add('hidden');
    document.getElementById('generateBtn').disabled = false;
  }
}

async function callClaudeForRecipes(prompt){
  let response;
  // Scale the token budget with how much output was actually requested, plus headroom for
  // the onHandAlternative recipe - a fixed budget truncated mid-JSON once a few recipes were asked for.
  const maxTokens = Math.min(8000, 1500 + state.recipeCount * 1300);
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/generate-recipes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + session.access_token
      },
      body: JSON.stringify({ prompt, max_tokens: maxTokens })
    });
  } catch(networkErr){
    throw new Error('Network error calling the recipe function (' + (networkErr.message || networkErr.name) + ').');
  }
  const data = await response.json();
  if(!response.ok){
    throw new Error('Recipe function returned an error: ' + (data.error || response.status));
  }
  let raw = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
  raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
  // Model output can carry stray preamble/trailing text around the fenced block even after
  // stripping the fences, and a truncated response (hit max_tokens) ends mid-object - trim to
  // the outermost braces so a parse failure reports the truncation, not incidental text around it.
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
  if(first !== -1 && last > first) raw = raw.slice(first, last + 1);
  try { return JSON.parse(raw); }
  catch(e){
    const truncated = data.stop_reason === 'max_tokens' || !raw.trim().endsWith('}');
    throw new Error(truncated
      ? 'The response was cut off before it finished (too many recipes requested at once). Try fewer recipes.'
      : 'Response was not valid JSON.');
  }
}

async function persistRecipes(parsed){
  if(!parsed || !Array.isArray(parsed.recipes) || parsed.recipes.length > 6) throw new Error('Recipe response has an invalid structure.');
  const recipes = parsed.recipes.map((r, index) => {
    if(!r || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 200 ||
      !Array.isArray(r.ingredients) || r.ingredients.length > 60 || !Array.isArray(r.steps) || r.steps.length > 12){
      throw new Error(`Recipe ${index + 1} has invalid fields.`);
    }
    r.ingredients.forEach(ing => { if(!ing || typeof ing.item !== 'string' || !ing.item.trim() || ing.item.length > 200) throw new Error(`Recipe ${index + 1} has an invalid ingredient.`); });
    r.steps.forEach(step => { if(!step || typeof step.text !== 'string' || !step.text.trim() || step.text.length > 2000) throw new Error(`Recipe ${index + 1} has an invalid step.`); });
    return r;
  });
  const rows = recipes.map(r => ({
    household_id: household.id, title:r.title, description:r.description, cuisine:r.cuisine,
    total_time_minutes:r.totalTimeMinutes, servings:r.servings, ingredients:r.ingredients||[],
    steps:r.steps||[], allergen_note:r.allergenNote, shopping_note:r.shoppingNote, cost_estimate:null, is_favourite:false,
    calories_per_serving: r.estimatedCaloriesPerServing || null, protein_g_per_serving: r.estimatedProteinGPerServing || null
  }));
  if(!rows.length) return [];
  const { data, error } = await supabase.from('recipes').insert(rows).select();
  if(error){ throw new Error('Could not save the recipes to your household: ' + error.message); }
  return data || [];
}

function computeCost(ingredients){
  let total = 0, savedCount = 0, estimatedCount = 0;
  ingredients.forEach(ing => {
    const stored = ingredientPrices[normalizeIngredientName(ing.item)];
    if(stored){ total += Number(stored.price); savedCount++; }
    else { total += Number(ing.estimatedPriceEur)||0; estimatedCount++; }
  });
  return { total, anyEstimated: estimatedCount > 0, savedCount, estimatedCount };
}
function costSourceNote(c){
  const parts = [];
  if(c.savedCount) parts.push(c.savedCount + ' from your saved prices');
  if(c.estimatedCount) parts.push(c.estimatedCount + ' AI estimates*');
  return parts.length ? parts.join(' · ') : 'no priced ingredients';
}

function renderResults(recipes, onHandAlternative){
  const body = document.getElementById('resultsBody'); body.innerHTML = '';
  if(!recipes.length && !onHandAlternative){
    body.appendChild(el('div', {class:'panel hint', text:'No recipes came back this time — try adjusting your filters and generating again.'}));
    return;
  }
  const onHandLower = state.onHand.map(x=>x.toLowerCase());
  recipes.forEach(r => body.appendChild(buildRecipeCard(r, onHandLower)));
  if(onHandAlternative){
    const card = buildRecipeCard({ ...onHandAlternative, id:null, cuisine:'', total_time_minutes:null, servings: state.servings, ingredients:onHandAlternative.ingredients, steps:onHandAlternative.steps }, onHandLower, true);
    body.appendChild(card);
  }
}

function buildRecipeCard(r, onHandLower, isAlt){
  const card = el('div', {class:'recipe-card'});
  const top = el('div', {class:'rc-top'});
  const allergyHits = household && household.allergies ? scanForAllergens(r, household.allergies) : [];
  if(allergyHits.length){
    const warnBox = el('div', {class:'error-box', style:'margin-bottom:10px;'});
    warnBox.textContent = 'Keyword allergy check: possible match for ' + allergyHits.map(h => h.allergen + ' (' + h.matched.join(', ') + ')').join('; ') + ' in the ingredients below. This is not a certified allergen check — it can miss hidden ingredients and flag harmless ones. Always check product labels, especially for Coeliac / gluten-free requirements.';
    top.appendChild(warnBox);
  }
  top.appendChild(el('h3', {text: (isAlt ? '↺ ' : '') + (r.title||'Untitled')}));
  if(r.description) top.appendChild(el('div', {class:'desc', text:r.description}));
  const meta = el('div', {class:'rc-meta'});
  if(r.total_time_minutes) meta.appendChild(el('span', {text:`⏱ ${r.total_time_minutes} min`}));
  if(r.servings) meta.appendChild(el('span', {text:`⚭ serves ${r.servings}`}));
  if(r.cuisine) meta.appendChild(el('span', {text:r.cuisine}));
  if(r.calories_per_serving) meta.appendChild(el('span', {text:`${Math.round(r.calories_per_serving)} kcal*`}));
  if(r.protein_g_per_serving) meta.appendChild(el('span', {text:`${Math.round(r.protein_g_per_serving)}g protein*`}));
  top.appendChild(meta);

  const actions = el('div', {class:'rc-actions'});
  if(r.id){
    const favBtn = el('button', {class:'btn ghost small', type:'button', text: r.is_favourite ? '★ Favourited' : '☆ Save to favourites'});
    favBtn.addEventListener('click', async () => {
      const newVal = !r.is_favourite;
      const { error } = await supabase.from('recipes').update({is_favourite:newVal}).eq('id', r.id);
      if(error){ showToast('Could not update favourites: ' + error.message, true); return; }
      r.is_favourite = newVal;
      favBtn.textContent = r.is_favourite ? '★ Favourited' : '☆ Save to favourites';
    });
    actions.appendChild(favBtn);
    const rateBtn = el('button', {class:'btn ghost small', type:'button', text:'Rate'});
    rateBtn.addEventListener('click', () => openRatingModal(r));
    actions.appendChild(rateBtn);
    const cookedBtn = el('button', {class:'btn ghost small', type:'button', text:'Mark as cooked'});
    cookedBtn.addEventListener('click', () => {
      // Review step: nothing is deducted until the user confirms in the modal.
      openDeductModal(r, (applied) => {
        cookedBtn.textContent = 'Marked as cooked';
        if(applied.length){
          const undoBtn = el('button', {class:'btn ghost small', type:'button', text:'Undo stock update'});
          undoBtn.addEventListener('click', async () => {
            const { error } = await safeDb(supabase.rpc('set_pantry_quantities', {p_changes:applied.map(d => ({id:d.id,quantity:d.previousQuantity}))}), 'Could not undo stock changes');
            if(!error){
              for(const d of applied){
              const item = pantryItems.find(p => p.id === d.id);
              if(item) item.quantity = d.previousQuantity;
              }
            }
            renderPantryList(); renderShoppingNeeded(); renderExpiringPanel();
            if(!error){ showToast('Stock changes undone'); undoBtn.remove(); }
          });
          actions.appendChild(undoBtn);
        }
        openLeftoverModal(r);
      });
    });
    actions.appendChild(cookedBtn);
    const shopListBtn = el('button', {class:'btn ghost small', type:'button', text:'Add to shopping list'});
    shopListBtn.addEventListener('click', () => addRecipeToShoppingList(r));
    actions.appendChild(shopListBtn);
  }
  const printBtn = el('button', {class:'btn ghost small', type:'button', text:'Print'});
  printBtn.addEventListener('click', () => printRecipe(r));
  actions.appendChild(printBtn);
  const cookBtn = el('button', {class:'btn ghost small', type:'button', text:'Start cooking'});
  cookBtn.addEventListener('click', () => startCooking(r));
  actions.appendChild(cookBtn);
  top.appendChild(actions);
  if(r.id) top.appendChild(buildQuickTagRow(r));
  card.appendChild(top);

  const bodyGrid = el('div', {class:'rc-body'});
  const ingCol = el('div'); ingCol.appendChild(el('h4', {text:'Ingredients'}));
  const ingList = el('ul', {class:'ing-list'});
  (r.ingredients||[]).forEach(ing => {
    // "Have" reflects either what was typed into the wizard's on-hand box, or actual
    // Koskas pantry stock (same matching used for pantry deduction) - not on-hand alone.
    const isOnHand = onHandLower.some(o => (ing.item||'').toLowerCase().includes(o))
      || pantryItems.some(p => p.quantity > 0 && namesMatch(ing.item, p.name));
    const li = el('li', isOnHand ? {class:'have'} : {});
    li.appendChild(el('span', {class:'item', text:ing.item||''}));
    const right = el('span', {class:'amt', text:[ing.amount, ing.unit].filter(Boolean).join(' ')});
    const stored = ingredientPrices[normalizeIngredientName(ing.item)];
    if(stored) right.title = '€' + Number(stored.price).toFixed(2) + ' — your saved household price';
    else if(ing.estimatedPriceEur != null) right.title = '€' + Number(ing.estimatedPriceEur).toFixed(2) + ' — AI estimate, not a real price';
    ingList.appendChild(li);
    li.appendChild(right);
  });
  ingCol.appendChild(ingList);
  bodyGrid.appendChild(ingCol);

  const stepCol = el('div'); stepCol.appendChild(el('h4', {text:'Method'}));
  const stepsList = el('ol', {class:'steps-list'});
  (r.steps||[]).forEach(s => stepsList.appendChild(el('li', {text: typeof s === 'string' ? s : s.text})));
  stepCol.appendChild(stepsList);
  bodyGrid.appendChild(stepCol);

  if(r.allergen_note || r.shoppingNote || r.shopping_note){
    const note = el('div', {class:'rc-note'});
    if(r.allergen_note) note.appendChild(el('div', {}, [el('b',{text:'Allergen check: '}), document.createTextNode(r.allergen_note)]));
    bodyGrid.appendChild(note);
  }

  const cost = computeCost(r.ingredients||[]);
  const costRow = el('div', {class:'rc-cost'});
  costRow.appendChild(el('div', {class:'total', text:'Total: €' + cost.total.toFixed(2) + (cost.anyEstimated ? '*' : '')}));
  costRow.appendChild(el('div', {class:'note', text: costSourceNote(cost)}));
  bodyGrid.appendChild(costRow);

  const priceEditWrap = el('div', {class:'rc-note', style:'grid-column:1/-1;'});
  priceEditWrap.appendChild(el('div', {text:'Adjust a price (remembered for next time):'}));
  const priceRow = el('div', {class:'row', style:'margin-top:8px;'});
  const priceSelect = el('select');
  (r.ingredients||[]).forEach(ing => priceSelect.appendChild(el('option', {value:ing.item, text:ing.item})));
  const priceInput = el('input', {type:'number', step:'0.01', min:'0', placeholder:'€', style:'width:90px;'});
  const priceSaveBtn = el('button', {class:'btn ghost small', type:'button', text:'Save price'});
  priceSaveBtn.addEventListener('click', async () => {
    const val = parseFloat(priceInput.value); if(isNaN(val)) return;
    const ok = await saveIngredientPrice(priceSelect.value, null, val);
    if(!ok) return;
    const c2 = computeCost(r.ingredients||[]);
    costRow.firstChild.textContent = 'Total: €' + c2.total.toFixed(2) + (c2.anyEstimated ? '*' : '');
    costRow.lastChild.textContent = costSourceNote(c2);
  });
  priceRow.appendChild(priceSelect); priceRow.appendChild(priceInput); priceRow.appendChild(priceSaveBtn);
  priceEditWrap.appendChild(priceRow);
  bodyGrid.appendChild(priceEditWrap);

  const shoppingNoteText = r.shopping_note || r.shoppingNote;
  if(shoppingNoteText){
    const shopNote = el('div', {class:'rc-note'});
    shopNote.appendChild(el('div', {}, [el('b',{text:'Shopping: '}), document.createTextNode(shoppingNoteText)]));
    const links = el('div', {class:'row', style:'margin-top:8px;'});
    shops.filter(s=>s.selected).forEach(s => {
      const url = SHOP_HOMEPAGES[s.name];
      if(url){ const a = el('a', {href:url, target:'_blank', rel:'noopener', text:'Search '+s.name, class:'btn ghost small', style:'text-decoration:none;'}); links.appendChild(a); }
    });
    shopNote.appendChild(links);
    bodyGrid.appendChild(shopNote);
  }

  card.appendChild(bodyGrid);
  return card;
}

// ---------------- KOSKAS: PANTRY / STOCK REGISTER ----------------
async function loadPantry(){
  const { data, error } = await safeDb(supabase.from('pantry_items').select('*').eq('household_id', household.id).order('expiry_date', {ascending:true, nullsFirst:false}), 'Could not load your pantry');
  if(!error) pantryItems = data || [];
  renderPantryList();
  renderShoppingNeeded();
  renderExpiringPanel();
}

function renderPantryList(){
  const wrap = document.getElementById('pantryList'); wrap.innerHTML = '';
  if(!pantryItems.length){ wrap.appendChild(el('div', {class:'hint', text:'Nothing logged yet, add by photo or manually above.'})); return; }
  pantryItems.forEach(item => {
    const row = el('div', {class:'panel', style:'padding:14px 16px; margin-bottom:10px;'});
    const top = el('div', {class:'row', style:'justify-content:space-between;'});
    const left = el('div');
    const dLeft = daysUntil(item.expiry_date);
    let badge = '';
    if(dLeft !== null){
      if(dLeft < 0) badge = ' — expired ' + Math.abs(dLeft) + 'd ago';
      else if(dLeft <= 3) badge = ' — expires in ' + dLeft + 'd';
      else badge = ' — use by ' + item.expiry_date;
    }
    const nameColor = dLeft !== null && dLeft < 0 ? 'var(--warn)' : (dLeft !== null && dLeft <= 3 ? 'var(--saffron)' : 'var(--text)');
    left.appendChild(el('div', {style:`font-weight:600; color:${nameColor};`, text: item.name + badge}));
    const meta = [item.quantity + ' ' + (item.unit||''), item.brand || null, item.par_level ? ('keep ≥ ' + item.par_level + ' ' + (item.unit||'')) : null, item.track_consumption ? 'tracked in recipes' : null].filter(Boolean).join(' · ');
    left.appendChild(el('div', {class:'hint', text: meta}));
    const n = item.nutrition_per_100g;
    if(n && (n['energy-kcal_100g'] != null || n.proteins_100g != null)){
      const bits = [];
      if(n['energy-kcal_100g'] != null) bits.push(Math.round(n['energy-kcal_100g']) + ' kcal');
      if(n.proteins_100g != null) bits.push(n.proteins_100g + 'g protein');
      left.appendChild(el('div', {class:'source-note', text:'Open Food Facts, per 100g: ' + bits.join(' · ')}));
    }
    if(item.allergen_text){
      left.appendChild(el('div', {class:'source-note', style:'color:var(--warn);', text:'Allergens on record (Open Food Facts): ' + item.allergen_text}));
    }
    if(item.par_level != null && item.quantity <= item.par_level){
      left.appendChild(el('div', {style:'color:var(--warn); font-size:12px; margin-top:2px;', text:'Low stock'}));
    }
    top.appendChild(left);
    const controls = el('div', {class:'row'});
    const setQty = async (newQty) => {
      const previous = item.quantity;
      item.quantity = newQty;
      const { error } = await safeDb(supabase.from('pantry_items').update({quantity:item.quantity, updated_at: new Date().toISOString()}).eq('id', item.id), 'Could not update the quantity');
      if(error) item.quantity = previous;
      renderPantryList(); renderShoppingNeeded(); renderExpiringPanel();
    };
    const minus = el('button', {class:'btn ghost small', type:'button', text:'−'});
    minus.addEventListener('click', () => setQty(Math.max(0, item.quantity - 1)));
    const plus = el('button', {class:'btn ghost small', type:'button', text:'+'});
    plus.addEventListener('click', () => setQty(item.quantity + 1));
    const trackBtn = el('button', {class:'btn ghost small', type:'button', text: item.track_consumption ? '★ tracked' : '☆ track'});
    trackBtn.addEventListener('click', async () => {
      item.track_consumption = !item.track_consumption;
      const { error } = await safeDb(supabase.from('pantry_items').update({track_consumption:item.track_consumption}).eq('id', item.id), 'Could not update tracking');
      if(error) item.track_consumption = !item.track_consumption;
      renderPantryList();
    });
    const delBtn = el('button', {class:'btn ghost small', type:'button', text:'✕'});
    delBtn.addEventListener('click', async () => {
      const { error } = await safeDb(supabase.from('pantry_items').delete().eq('id', item.id), 'Could not delete the item');
      if(error) return;
      pantryItems = pantryItems.filter(p=>p.id!==item.id); renderPantryList(); renderShoppingNeeded(); renderExpiringPanel();
    });
    controls.appendChild(minus); controls.appendChild(plus); controls.appendChild(trackBtn); controls.appendChild(delBtn);
    top.appendChild(controls);
    row.appendChild(top);
    wrap.appendChild(row);
  });
}

const SHOP_FULFILMENT = {
  // Verified directly against each retailer's own site, July 2026. Re-check periodically, this can change.
  "Tesco Ireland": { delivery: true, collect: true, note: "Delivery and Click+Collect nationwide. Click+Collect free with orders over €30 (a small charge applies below that). Source: tesco.ie, checked Jul 2026.", url: "https://www.tesco.ie/groceries/" },
  "Dunnes Stores": { delivery: true, collect: true, note: "Free next-day delivery or Click & Collect if ordered by 10pm. Same-day delivery via Buymie in some stores. Source: dunnesstoresgrocery.com, checked Jul 2026.", url: "https://www.dunnesstoresgrocery.com/" },
  "SuperValu": { delivery: true, collect: true, note: "Home delivery or free Click & Collect, same-day available if ordered before 12 noon (store and slot dependent). Source: shop.supervalu.ie, checked Jul 2026.", url: "https://shop.supervalu.ie/" },
  "Lidl Ireland": { delivery: null, collect: null, note: "Lidl's online ordering and any Click & Collect availability varies by store and changes, I haven't verified current details, check lidl.ie before relying on it.", url: "https://www.lidl.ie/" },
  "Aldi Ireland": { delivery: null, collect: null, note: "Aldi Ireland's online grocery ordering setup isn't something I've verified recently, check groceries.aldi.ie directly.", url: "https://groceries.aldi.ie/" },
  "SPAR": { delivery: null, collect: null, note: "Delivery/collection varies by individual SPAR store, check spar.ie or the specific store.", url: "https://www.spar.ie/" },
  "Centra": { delivery: null, collect: null, note: "Delivery/collection varies by individual Centra store, check centra.ie or the specific store.", url: "https://www.centra.ie/" },
  "M&S Food": { delivery: null, collect: null, note: "Not verified recently, check marksandspencer.ie.", url: "https://www.marksandspencer.ie/" }
};

function lowStockItems(){
  return pantryItems.filter(i => i.par_level != null && i.quantity <= i.par_level);
}

function renderShoppingNeeded(){
  const panel = document.getElementById('shoppingNeededPanel');
  const list = document.getElementById('shoppingNeededList');
  const low = lowStockItems();
  if(!low.length){ panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  list.innerHTML = '';
  const ul = el('ul', {class:'ing-list'});
  low.forEach(i => {
    const li = el('li');
    li.appendChild(el('span', {text: i.name}));
    li.appendChild(el('span', {class:'amt', text: `have ${i.quantity}${i.unit?(' '+i.unit):''}, keep ≥ ${i.par_level}`}));
    ul.appendChild(li);
  });
  list.appendChild(ul);
}

document.getElementById('lowStockToListBtn').addEventListener('click', async () => {
  const low = lowStockItems();
  if(!low.length) return;
  const list = await ensureDraftList('Restock list', 'low_stock');
  if(!list) return;
  const added = await addItemsToList(list, low.map(i => ({
    item_name: i.name,
    quantity_text: `have ${i.quantity}${i.unit?(' '+i.unit):''}, keep ≥ ${i.par_level}`,
    pantry_item_id: i.id, source:'low_stock'
  })));
  if(added) openShoppingTab(list.id);
});

document.getElementById('manItemAdd').addEventListener('click', async () => {
  const name = document.getElementById('manItemName').value.trim();
  if(!name) return;
  const quantity = parseFloat(document.getElementById('manItemQty').value) || 0;
  const unit = document.getElementById('manItemUnit').value.trim() || null;
  const parRaw = document.getElementById('manItemPar').value;
  const par_level = parRaw ? parseFloat(parRaw) : null;
  const expiryRaw = document.getElementById('manItemExpiry').value.trim();
  const expiry_date = expiryRaw || null;
  const track_consumption = document.getElementById('manItemTrack').checked;
  const { data, error } = await safeDb(supabase.from('pantry_items').insert({ household_id: household.id, name, quantity, unit, par_level, expiry_date, track_consumption, source:'manual' }).select().single(), 'Could not add the item');
  if(error) return;
  if(data){ pantryItems.push(data); renderPantryList(); renderShoppingNeeded(); renderExpiringPanel(); }
  ['manItemName','manItemQty','manItemUnit','manItemPar','manItemExpiry'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('manItemTrack').checked = false;
});

async function preparePantryPhoto(file){
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG, or WebP photo.');
  if(file.size > 12_000_000) throw new Error('The original photo is too large. Choose one under 12 MB.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if(!blob || blob.size > 4_000_000) throw new Error('The compressed photo is still too large. Try a closer crop.');
  const dataUrl = await new Promise((resolve,reject) => { const reader=new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=reject; reader.readAsDataURL(blob); });
  return {base64:dataUrl.split(',')[1], mediaType:'image/jpeg'};
}

document.getElementById('pantryPhotoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const status = document.getElementById('pantryScanStatus');
  const resultsWrap = document.getElementById('pantryScanResults');
  resultsWrap.innerHTML = '';
  status.textContent = 'Reading the photo…';
  try {
    const prepared = await preparePantryPhoto(file);
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/scan-pantry-photo`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + session.access_token },
      body: JSON.stringify({ imageBase64: prepared.base64, mediaType: prepared.mediaType })
    });
    const data = await resp.json();
    if(!resp.ok){ status.textContent = 'Scan failed: ' + (data.error || resp.status); return; }
    let raw = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
    raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
    const parsed = JSON.parse(raw);
    if(!parsed || !Array.isArray(parsed.items)) throw new Error('The scan returned an invalid result.');
    const items = parsed.items.slice(0, 50).filter(it => it && typeof it.name === 'string' && it.name.trim() && it.name.length <= 200 && ['high','medium','low'].includes(it.confidence));
    if(!items.length){ status.textContent = "Couldn't make out any items in that photo, try a closer, better-lit shot."; return; }
    status.textContent = `Found ${items.length} possible item(s), review and confirm each before it saves:`;
    items.forEach(it => resultsWrap.appendChild(buildScanResultRow(it)));
  } catch(err){
    status.textContent = 'Scan failed: ' + err.message;
  } finally {
    e.target.value = '';
  }
});

function buildScanResultRow(it){
  const row = el('div', {class:'panel', style:'padding:12px 14px; margin-bottom:8px;'});
  const conf = el('span', {class:'hint', text:' (' + it.confidence + ' confidence)'});
  row.appendChild(el('div', {style:'font-weight:600;'}, [document.createTextNode(it.name), conf]));
  row.appendChild(el('div', {class:'hint', text: `AI's guess: ${it.estimatedQuantity || 'not given'}${it.unit ? ' '+it.unit : ''}, confirm a number below`}));
  const inputRow = el('div', {class:'row', style:'margin-top:8px;'});
  const nameInput = el('input', {type:'text', 'aria-label':'Scanned item name', style:'flex:2;'}); nameInput.value = it.name;
  const numericGuess = parseFloat(it.estimatedQuantity);
  const qtyInput = el('input', {type:'number', step:'0.1', min:'0', 'aria-label':'Scanned item quantity', placeholder:'qty', style:'width:80px;'});
  qtyInput.value = isNaN(numericGuess) ? '' : numericGuess;
  const unitInput = el('input', {type:'text', 'aria-label':'Scanned item unit', style:'width:70px;'}); unitInput.value = it.unit||'';
  const expInput = el('input', {type:'date', 'aria-label':'Scanned item expiry date', style:'width:150px;'}); expInput.value = /^\d{4}-\d{2}-\d{2}$/.test(it.expiryDateGuess||'') ? it.expiryDateGuess : '';
  inputRow.appendChild(nameInput); inputRow.appendChild(qtyInput); inputRow.appendChild(unitInput); inputRow.appendChild(expInput);
  row.appendChild(inputRow);
  const addBtn = el('button', {class:'btn ghost small', type:'button', text:'Add to pantry', style:'margin-top:8px;'});
  addBtn.addEventListener('click', async () => {
    if(!qtyInput.value.trim()){ qtyInput.focus(); qtyInput.style.borderColor = 'var(--warn)'; return; }
    const quantity = parseFloat(qtyInput.value);
    if(!Number.isFinite(quantity) || quantity < 0 || !nameInput.value.trim()){ showToast('Enter a valid item name and non-negative quantity', true); return; }
    const { data, error } = await supabase.from('pantry_items').insert({
      household_id: household.id, name: nameInput.value.trim(), quantity, unit: unitInput.value.trim()||null,
      expiry_date: expInput.value.trim()||null, source:'photo'
    }).select().single();
    if(error){ addBtn.textContent = 'Failed: ' + error.message; return; }
    if(data){ pantryItems.push(data); renderPantryList(); renderShoppingNeeded(); }
    row.remove();
  });
  row.appendChild(addBtn);
  return row;
}

// ---------------- LEFTOVERS ----------------
async function loadLeftovers(){
  const { data, error } = await safeDb(supabase.from('leftovers').select('*').eq('household_id', household.id).order('created_at', {ascending:false}).limit(30), 'Could not load leftovers');
  if(!error) leftovers = data || [];
  renderLeftovers();
}
function renderLeftovers(){
  const wrap = document.getElementById('leftoversList'); wrap.innerHTML = '';
  const active = leftovers.filter(l => !l.consumed_at);
  if(!active.length){ wrap.appendChild(el('div', {class:'hint', text:'No leftovers logged right now.'})); return; }
  active.forEach(l => {
    const ageDays = Math.floor((new Date() - new Date(l.created_at)) / 86400000);
    const row = el('div', {class:'row', style:'justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line);'});
    row.appendChild(el('div', {text: `${l.recipe_title||'Recipe'} — ${l.amount} (${ageDays}d old)`}));
    const eatBtn = el('button', {class:'btn ghost small', type:'button', text:'Mark eaten'});
    eatBtn.addEventListener('click', async () => {
      const { error } = await safeDb(supabase.from('leftovers').update({consumed_at:new Date().toISOString()}).eq('id', l.id), 'Could not mark the leftover as eaten');
      if(error) return;
      l.consumed_at = new Date().toISOString(); renderLeftovers();
    });
    row.appendChild(eatBtn);
    wrap.appendChild(row);
  });
}

// ---------------- MARK AS COOKED: reviewed pantry deduction + leftover prompt ----------------
function computePantryDeductions(recipe){
  const proposals = [];
  const trackedItems = pantryItems.filter(p => p.track_consumption);
  for(const ing of (recipe.ingredients||[])){
    const match = trackedItems.find(p => namesMatch(ing.item, p.name));
    if(!match) continue;
    const amt = parseFloat(ing.amount);
    if(isNaN(amt)) continue;
    const converted = convertUnits(amt, ing.unit, match.unit);
    if(converted === null) continue;
    if(proposals.some(pr => pr.item.id === match.id)){
      const existing = proposals.find(pr => pr.item.id === match.id);
      existing.deduct += converted;
      continue;
    }
    proposals.push({ item: match, ingredient: ing.item, deduct: converted });
  }
  return proposals;
}

let deductContext = null;
function openDeductModal(recipe, onDone){
  const proposals = computePantryDeductions(recipe);
  deductContext = { proposals, onDone };
  const rows = document.getElementById('deductRows'); rows.innerHTML = '';
  document.getElementById('deductNoneMsg').classList.toggle('hidden', proposals.length > 0);
  document.getElementById('deductApplyBtn').disabled = proposals.length === 0;
  proposals.forEach((p, idx) => {
    const newQty = Math.max(0, p.item.quantity - p.deduct);
    const row = el('label', {class:'row', style:'justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line); cursor:pointer;'});
    const cb = el('input', {type:'checkbox', 'data-idx':idx}); cb.checked = true;
    const left = el('div', {class:'row', style:'gap:8px; flex:1;'}, [cb]);
    left.appendChild(el('div', {}, [
      el('div', {text: p.item.name, style:'font-weight:600; font-size:13.5px;'}),
      el('div', {class:'hint', text: `${p.item.quantity} → ${Number(newQty.toFixed(2))} ${p.item.unit||''} (uses ${Number(p.deduct.toFixed(2))} ${p.item.unit||''} for "${p.ingredient}")`})
    ]));
    row.appendChild(left);
    rows.appendChild(row);
  });
  document.getElementById('deductModal').classList.remove('hidden');
}
document.getElementById('deductCancelBtn').addEventListener('click', () => {
  document.getElementById('deductModal').classList.add('hidden');
  if(deductContext){ const cb = deductContext.onDone; deductContext = null; cb([]); }
});
document.getElementById('deductApplyBtn').addEventListener('click', async () => {
  if(!deductContext) return;
  const ticked = [...document.querySelectorAll('#deductRows input[type=checkbox]')].filter(c => c.checked).map(c => deductContext.proposals[Number(c.dataset.idx)]);
  const applied = ticked.map(p => ({id:p.item.id, previousQuantity:p.item.quantity, quantity:Math.max(0,p.item.quantity-p.deduct)}));
  const { error } = await safeDb(supabase.rpc('set_pantry_quantities', {p_changes:applied.map(d => ({id:d.id,quantity:d.quantity}))}), 'Could not update pantry stock');
  if(error) return;
  applied.forEach(d => { const item=pantryItems.find(p=>p.id===d.id); if(item) item.quantity=d.quantity; });
  renderPantryList(); renderShoppingNeeded(); renderExpiringPanel();
  document.getElementById('deductModal').classList.add('hidden');
  if(applied.length) showToast(`Stock updated for ${applied.length} item(s)`);
  const cb = deductContext.onDone; deductContext = null; cb(applied);
});

let leftoverRecipeContext = null;
function openLeftoverModal(recipe){
  leftoverRecipeContext = recipe;
  document.getElementById('leftoverModal').classList.remove('hidden');
}
document.querySelectorAll('#leftoverChips .chip').forEach(chip => {
  chip.addEventListener('click', async () => {
    if(leftoverRecipeContext){
      await safeDb(supabase.from('leftovers').insert({
        household_id: household.id, recipe_id: leftoverRecipeContext.id || null,
        recipe_title: leftoverRecipeContext.title, amount: chip.dataset.amt
      }), 'Could not log the leftovers');
    }
    document.getElementById('leftoverModal').classList.add('hidden');
    loadLeftovers();
  });
});
document.getElementById('skipLeftoverBtn').addEventListener('click', () => document.getElementById('leftoverModal').classList.add('hidden'));


async function loadFavourites(){
  const body = document.getElementById('favouritesBody');
  const { data, error } = await safeDb(supabase.from('recipes').select('*').eq('household_id', household.id).eq('is_favourite', true).order('generated_at', {ascending:false}), 'Could not load favourites');
  if(error) return;
  body.innerHTML = '';
  if(!data || !data.length){ body.appendChild(el('div', {class:'panel', text:'No favourites saved yet.'})); return; }
  await preloadTagsForRecipes(data.map(r => r.id));
  data.forEach(r => body.appendChild(buildRecipeCard(r, [])));
}

// ---------------- RATING MODAL ----------------
let ratingTarget = null;
const RATING_CATS = [['taste','Taste'],['convenience','Convenience'],['cost','Cost'],['serving_size','Serving size']];
function openRatingModal(recipe){
  ratingTarget = recipe;
  const wrap = document.getElementById('starRows'); wrap.innerHTML = '';
  ratingTarget._ratings = {};
  RATING_CATS.forEach(([key,label]) => {
    const row = el('div', {class:'star-row'});
    row.appendChild(el('div', {class:'cat', text:label}));
    const stars = el('div', {class:'stars'});
    for(let i=1;i<=5;i++){
      const s = el('span', {text:'★', 'data-val':i});
      s.addEventListener('click', () => {
        ratingTarget._ratings[key] = i;
        [...stars.children].forEach((el2,idx) => el2.classList.toggle('on', idx < i));
      });
      stars.appendChild(s);
    }
    row.appendChild(stars);
    wrap.appendChild(row);
  });
  const tagWrap = document.getElementById('ratingQuickTags'); tagWrap.innerHTML = '';
  tagWrap.appendChild(buildQuickTagChips(recipe.id));
  document.getElementById('ratingComment').value = '';
  document.getElementById('ratingModal').classList.remove('hidden');
}
document.getElementById('cancelRatingBtn').addEventListener('click', () => document.getElementById('ratingModal').classList.add('hidden'));
document.getElementById('saveRatingBtn').addEventListener('click', async () => {
  const comment = document.getElementById('ratingComment').value.trim();
  const r = ratingTarget._ratings || {};
  const { error } = await supabase.from('recipe_ratings').upsert({
    recipe_id: ratingTarget.id, profile_id: session.user.id,
    taste:r.taste||null, convenience:r.convenience||null, cost:r.cost||null, serving_size:r.serving_size||null,
    comment: comment||null
  }, { onConflict:'recipe_id,profile_id' });
  document.getElementById('ratingModal').classList.add('hidden');
  if(error) showToast('Rating did not save: ' + error.message, true);
  else showToast('Rating saved');
});

// ---------------- PRINT ----------------
function printRecipe(r){
  const area = document.getElementById('printArea');
  area.innerHTML = '';
  area.appendChild(el('h1', {text: r.title || ''}));
  if(r.description) area.appendChild(el('p', {text: r.description}));
  area.appendChild(el('p', {text: `Serves ${r.servings||''} · ${r.total_time_minutes||'?'} min`}));
  area.appendChild(el('h2', {text:'Ingredients'}));
  const ul = el('ul');
  (r.ingredients||[]).forEach(i => ul.appendChild(el('li', {text: [i.amount, i.unit].filter(Boolean).join(' ') + ' ' + (i.item||'')})));
  area.appendChild(ul);
  area.appendChild(el('h2', {text:'Method'}));
  const ol = el('ol');
  (r.steps||[]).forEach(s => ol.appendChild(el('li', {text: typeof s==='string' ? s : s.text})));
  area.appendChild(ol);
  area.classList.remove('hidden');
  window.print();
  area.classList.add('hidden');
}

// ---------------- COOKING MODE ----------------
let wakeLock = null, ckSteps = [], ckIndex = 0, ckTimerInterval = null;
async function startCooking(r){
  ckSteps = (r.steps||[]).map(s => typeof s === 'string' ? {text:s, timerSeconds:null} : s);
  ckIndex = 0;
  document.getElementById('ckTitle').textContent = r.title||'';
  document.getElementById('cookingOverlay').classList.remove('hidden');
  try {
    if('wakeLock' in navigator){ wakeLock = await navigator.wakeLock.request('screen'); document.getElementById('wakeBadge').textContent = 'screen lock: on'; document.getElementById('wakeBadge').classList.remove('off'); }
    else { document.getElementById('wakeBadge').textContent = 'screen lock: unsupported in this browser'; document.getElementById('wakeBadge').classList.add('off'); }
  } catch(e){ document.getElementById('wakeBadge').textContent = 'screen lock: failed'; document.getElementById('wakeBadge').classList.add('off'); }
  renderCookingStep();
}
function renderCookingStep(){
  clearInterval(ckTimerInterval);
  const step = ckSteps[ckIndex];
  document.getElementById('ckStepNum').textContent = `Step ${ckIndex+1} of ${ckSteps.length}`;
  document.getElementById('ckText').textContent = step.text;
  const timerEl = document.getElementById('ckTimer');
  const controls = document.getElementById('ckTimerControls'); controls.innerHTML = '';
  if(step.timerSeconds){
    let remaining = step.timerSeconds;
    timerEl.classList.remove('hidden');
    const fmt = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    timerEl.textContent = fmt(remaining);
    const startBtn = el('button', {class:'btn ghost small', type:'button', text:'Start timer'});
    startBtn.addEventListener('click', () => {
      startBtn.disabled = true;
      ckTimerInterval = setInterval(() => {
        remaining--;
        timerEl.textContent = fmt(Math.max(remaining,0));
        if(remaining <= 0){ clearInterval(ckTimerInterval); timerEl.textContent = "Time's up"; if(navigator.vibrate) navigator.vibrate([200,100,200]); }
      }, 1000);
    });
    controls.appendChild(startBtn);
  } else {
    timerEl.classList.add('hidden');
  }
  document.getElementById('ckPrevBtn').disabled = ckIndex === 0;
  document.getElementById('ckNextBtn').textContent = ckIndex === ckSteps.length-1 ? 'Finish' : 'Next';
}
document.getElementById('ckPrevBtn').addEventListener('click', () => { if(ckIndex>0){ ckIndex--; renderCookingStep(); }});
document.getElementById('ckNextBtn').addEventListener('click', () => {
  if(ckIndex < ckSteps.length-1){ ckIndex++; renderCookingStep(); } else { exitCooking(); }
});
document.getElementById('exitCookingBtn').addEventListener('click', exitCooking);
async function exitCooking(){
  clearInterval(ckTimerInterval);
  if(wakeLock){ try{ await wakeLock.release(); }catch(e){} wakeLock = null; }
  document.getElementById('cookingOverlay').classList.add('hidden');
}
document.addEventListener('visibilitychange', async () => {
  if(document.visibilityState === 'visible' && !document.getElementById('cookingOverlay').classList.contains('hidden') && 'wakeLock' in navigator){
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e){}
  }
});

// ---------------- QUICK FEEDBACK TAGS ----------------
const QUICK_TAGS = ['great taste','make again','wife liked it','child liked it','high protein win','good for leftovers','too expensive','too much effort','too many dishes','too bland','avoid next time'];

async function preloadTagsForRecipes(ids){
  if(!ids.length) return;
  const { data, error } = await safeDb(supabase.from('recipe_feedback_tags').select('recipe_id,tag').eq('profile_id', session.user.id).in('recipe_id', ids), 'Could not load your feedback tags');
  if(error) return;
  ids.forEach(id => { recipeTagsCache[id] = recipeTagsCache[id] || new Set(); });
  (data||[]).forEach(t => {
    if(!recipeTagsCache[t.recipe_id]) recipeTagsCache[t.recipe_id] = new Set();
    recipeTagsCache[t.recipe_id].add(t.tag);
  });
}
function myTags(recipeId){
  if(!recipeTagsCache[recipeId]) recipeTagsCache[recipeId] = new Set();
  return recipeTagsCache[recipeId];
}
async function toggleTag(recipeId, tag, chipEl){
  const mine = myTags(recipeId);
  const had = mine.has(tag);
  if(had){
    const { error } = await safeDb(supabase.from('recipe_feedback_tags').delete().eq('recipe_id', recipeId).eq('profile_id', session.user.id).eq('tag', tag), 'Could not remove the tag');
    if(error) return;
    mine.delete(tag);
  } else {
    const { error } = await safeDb(supabase.from('recipe_feedback_tags').insert({ recipe_id: recipeId, profile_id: session.user.id, tag }), 'Could not save the tag');
    if(error) return;
    mine.add(tag);
  }
  if(chipEl) chipEl.classList.toggle('on', !had);
}
function buildQuickTagChips(recipeId){
  const wrap = el('div', {class:'chip-grid', style:'margin-bottom:0; gap:6px;'});
  QUICK_TAGS.forEach(tag => {
    const chip = el('button', {class:'qf-chip' + (myTags(recipeId).has(tag) ? ' on' : ''), type:'button', text: tag});
    chip.addEventListener('click', () => toggleTag(recipeId, tag, chip));
    wrap.appendChild(chip);
  });
  return wrap;
}
function buildQuickTagRow(r){
  const details = el('details', {style:'margin-top:12px;'});
  if(myTags(r.id).size) details.setAttribute('open', '');
  const sum = el('summary', {text:'Quick feedback', style:"cursor:pointer; font-family:'IBM Plex Mono',monospace; font-size:11.5px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-dim);"});
  details.appendChild(sum);
  const inner = el('div', {style:'margin-top:8px;'});
  inner.appendChild(buildQuickTagChips(r.id));
  details.appendChild(inner);
  return details;
}

// ---------------- ORDER MODE / PERSISTENT SHOPPING LISTS ----------------
const RETAILERS = ["Tesco Ireland","Dunnes Stores","SuperValu","Lidl Ireland","Aldi Ireland","M&S Food","SPAR","Centra","Manual / Other"];
const FULFIL_LABELS = { delivery:'Delivery', click_collect:'Click & Collect', in_store:'In-store shopping', whatsapp:'WhatsApp list only' };
const ITEM_STATUS_CYCLE = ['required','optional','check_pantry','already_have','bought'];
const ITEM_STATUS_LABELS = { required:'required', optional:'optional', check_pantry:'check pantry', already_have:'already have', bought:'bought' };

function switchToTab(name){
  document.querySelectorAll('.tabs button').forEach(b => {
    if(b.dataset.tab === name) b.click();
  });
}

async function loadShoppingLists(){
  const { data, error } = await safeDb(supabase.from('shopping_lists').select('*, shopping_list_items(count)').eq('household_id', household.id).order('created_at', {ascending:false}), 'Could not load shopping lists');
  if(!error) shoppingLists = data || [];
  renderShoppingListCards();
}

function renderShoppingListCards(){
  const wrap = document.getElementById('slListCards'); wrap.innerHTML = '';
  if(!shoppingLists.length){
    wrap.appendChild(el('div', {class:'hint', text:'No shopping lists yet. Create one above, add one from a recipe card ("Add to shopping list"), from low-stock items in Koskas, or from the meal plan.'}));
    return;
  }
  shoppingLists.forEach(l => {
    const count = l.shopping_list_items?.[0]?.count ?? 0;
    const card = el('div', {class:'panel list-card', style:'padding:14px 16px; margin-bottom:10px;'});
    const top = el('div', {class:'row', style:'justify-content:space-between;'});
    const left = el('div');
    left.appendChild(el('div', {style:'font-weight:600;', text: l.title}));
    left.appendChild(el('div', {class:'hint', text: [
      l.status, FULFIL_LABELS[l.fulfilment_method] || l.fulfilment_method, l.retailer_name,
      count + ' item' + (count === 1 ? '' : 's'),
      new Date(l.created_at).toLocaleDateString('en-IE')
    ].filter(Boolean).join(' · ')}));
    top.appendChild(left);
    top.appendChild(el('span', {class:'status-pill ' + (l.status === 'completed' ? 'already_have' : 'required'), text: l.status}));
    card.appendChild(top);
    card.addEventListener('click', () => openListDetail(l.id));
    wrap.appendChild(card);
  });
}

document.getElementById('newListBtn').addEventListener('click', async () => {
  const input = document.getElementById('newListTitle');
  const title = input.value.trim() || 'Shopping list';
  const { data, error } = await safeDb(supabase.from('shopping_lists').insert({
    household_id: household.id, title, source:'manual', created_by: session.user.id
  }).select().single(), 'Could not create the list');
  if(error) return;
  input.value = '';
  shoppingLists.unshift(data);
  openListDetail(data.id);
});

// Reuse the most recent draft list, or create one. Used by recipe cards, Koskas and the meal plan.
async function ensureDraftList(title, source){
  await loadShoppingLists();
  // Reuse an existing draft only when it's the same kind of list (so a "Restock list" click
  // doesn't silently dump into an unrelated recipe-sourced draft) or was started very recently
  // (so re-adding another meal/recipe within the same session still lands in one list) -
  // otherwise the requested title would be discarded with no sign anything happened.
  const RECENT_MS = 24 * 60 * 60 * 1000;
  const draft = shoppingLists.find(l => l.status === 'draft' &&
    (l.source === source || (Date.now() - new Date(l.created_at).getTime()) < RECENT_MS));
  if(draft) return draft;
  const { data, error } = await safeDb(supabase.from('shopping_lists').insert({
    household_id: household.id, title, source, created_by: session.user.id
  }).select().single(), 'Could not create a shopping list');
  if(error) return null;
  shoppingLists.unshift(data);
  return data;
}

// Adds items to a list, merging any that match an ingredient already on the list (whether
// already-persisted from an earlier add, or another item in this same batch) instead of
// creating a duplicate line - see baseIngredientKey/mergeCompatibleQuantity above.
async function addItemsToList(list, items){
  if(!items.length) return true;
  const { data: existingRows, error: fetchErr } = await safeDb(supabase.from('shopping_list_items').select('*').eq('shopping_list_id', list.id), 'Could not read the list before adding items');
  if(fetchErr) return false;
  const existing = existingRows || [];
  const byKey = new Map();
  existing.forEach(row => {
    if(row.status === 'bought') return; // once bought, don't silently fold new demand back into that line
    byKey.set(baseIngredientKey(row.item_name) + '|' + mergeUnitKey(row.unit), row);
  });

  const toInsert = [];
  const toUpdate = [];
  let nextSort = existing.length;

  for(const it of items){
    const key = baseIngredientKey(it.item_name) + '|' + mergeUnitKey(it.unit);
    const match = byKey.get(key);
    if(match){
      const merged = mergeCompatibleQuantity(match.quantity, match.unit, it.quantity, it.unit);
      if(merged){
        match.quantity = merged.quantity; match.unit = merged.unit;
        match.quantity_text = `${merged.quantity}${merged.unit ? ' ' + merged.unit : ''}`;
      } else {
        // Can't combine into one number (e.g. "zest of 1" + "juice of 1") - keep it to one
        // line anyway and say so honestly, rather than inventing a precise total.
        const combined = [match.quantity_text, it.quantity_text].filter(Boolean).join(' + ');
        match.quantity = null; match.unit = null;
        match.quantity_text = combined ? combined + ' (combined from multiple recipes)' : match.quantity_text;
      }
      if(match.pantry_item_id == null && it.pantry_item_id != null) match.pantry_item_id = it.pantry_item_id;
      if(match.id) toUpdate.push({ id: match.id, quantity: match.quantity, unit: match.unit, quantity_text: match.quantity_text, pantry_item_id: match.pantry_item_id });
      continue;
    }
    const row = {
      shopping_list_id: list.id, household_id: household.id,
      item_name: cleanIngredientDisplayName(it.item_name), quantity: it.quantity ?? null, unit: it.unit ?? null,
      quantity_text: it.quantity_text ?? null, category: it.category ?? null, notes: it.notes ?? null,
      status: it.status || 'required', source: it.source || 'manual',
      recipe_id: it.recipe_id ?? null, pantry_item_id: it.pantry_item_id ?? null,
      sort_order: nextSort++
    };
    toInsert.push(row);
    byKey.set(key, row); // later items in this same batch can still merge into it before it's inserted
  }

  const { error } = await safeDb(supabase.rpc('apply_shopping_list_changes', {p_list_id:list.id,p_updates:toUpdate,p_inserts:toInsert}), 'Could not apply shopping-list changes');
  if(error) return false;
  return true;
}

// Pantry-aware conversion of recipe ingredients into shopping list items. Conservative:
// full pantry coverage marks the line "already have", uncertain matches "check pantry",
// nothing is silently dropped.
function ingredientToListItem(ing, recipeId){
  const item = {
    item_name: ing.item || 'item',
    quantity_text: [ing.amount, ing.unit].filter(Boolean).join(' ') || null,
    recipe_id: recipeId || null, source:'recipe', status:'required',
    category: categorizeIngredient(ing.item)
  };
  const amt = parseFloat(ing.amount);
  if(!isNaN(amt)){ item.quantity = amt; item.unit = ing.unit || null; }
  const match = pantryItems.find(p => namesMatch(ing.item, p.name));
  if(match && match.quantity > 0){
    const conv = isNaN(amt) ? null : convertUnits(amt, ing.unit, match.unit);
    if(conv === null){
      item.status = 'check_pantry';
      item.notes = `pantry shows ${match.quantity}${match.unit ? ' ' + match.unit : ''} of ${match.name} — check before buying`;
    } else if(match.quantity >= conv){
      item.status = 'already_have';
      item.notes = `pantry shows enough (${match.quantity}${match.unit ? ' ' + match.unit : ''})`;
    } else {
      const needed = conv - match.quantity;
      item.quantity = Number(needed.toFixed(2));
      item.unit = match.unit || item.unit;
      item.quantity_text = `${item.quantity}${item.unit ? ' ' + item.unit : ''} (reduced — pantry has ${match.quantity}${match.unit ? ' ' + match.unit : ''})`;
      item.notes = 'quantity reduced by pantry stock';
    }
    item.pantry_item_id = match.id;
  }
  return item;
}

// Recipes already represented in a list (by recipe_id) - used to stop the same recipe's
// ingredients being added twice when it's sent to the list from more than one place.
async function recipeIdsAlreadyInList(listId, recipeIds){
  const ids = [...new Set((recipeIds||[]).filter(Boolean))];
  if(!ids.length) return new Set();
  const { data } = await safeDb(supabase.from('shopping_list_items').select('recipe_id').eq('shopping_list_id', listId).in('recipe_id', ids), 'Could not check the list for existing items');
  return new Set((data||[]).map(d => d.recipe_id));
}

async function addRecipeToShoppingList(r){
  const list = await ensureDraftList('Shopping for ' + (r.title || 'recipes'), 'recipe');
  if(!list) return;
  if(r.id){
    const already = await recipeIdsAlreadyInList(list.id, [r.id]);
    if(already.has(r.id)){
      showToast('"' + (r.title||'This recipe') + '" is already in "' + list.title + '"');
      openShoppingTab(list.id);
      return;
    }
  }
  const items = (r.ingredients||[]).map(ing => ingredientToListItem(ing, r.id || null));
  const ok = await addItemsToList(list, items);
  if(!ok) return;
  showToast('Added ' + items.length + ' ingredient(s) to "' + list.title + '"');
  openShoppingTab(list.id);
}

function openShoppingTab(listId){
  switchToTab('shopping');
  if(listId) openListDetail(listId);
}

async function openListDetail(listId){
  const { data: list, error } = await safeDb(supabase.from('shopping_lists').select('*').eq('id', listId).single(), 'Could not open the list');
  if(error) return;
  const { data: items, error: itemsErr } = await safeDb(supabase.from('shopping_list_items').select('*').eq('shopping_list_id', listId).order('sort_order'), 'Could not load the list items');
  if(itemsErr) return;
  currentList = list;
  currentListItems = items || [];
  document.getElementById('slOverviewPanel').classList.add('hidden');
  document.getElementById('slDetailPanel').classList.remove('hidden');
  renderListDetail();
}

function closeListDetail(){
  currentList = null; currentListItems = [];
  document.getElementById('slDetailPanel').classList.add('hidden');
  document.getElementById('slOverviewPanel').classList.remove('hidden');
  loadShoppingLists();
}
document.getElementById('slBackBtn').addEventListener('click', closeListDetail);

async function updateCurrentList(fields, friendly){
  const { error } = await safeDb(supabase.from('shopping_lists').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', currentList.id), friendly);
  if(!error) Object.assign(currentList, fields);
  return !error;
}

function renderListDetail(){
  const l = currentList;
  document.getElementById('slDetailTitle').textContent = l.title;
  document.getElementById('slDetailSub').textContent = `Status: ${l.status} · created ${new Date(l.created_at).toLocaleDateString('en-IE')}. Everything here saves automatically for the whole household.`;
  document.querySelectorAll('#slFulfilChips .chip').forEach(c => { const sel = c.dataset.fm === l.fulfilment_method; c.classList.toggle('selected', sel); c.setAttribute('aria-pressed', String(sel)); });
  const sel = document.getElementById('slRetailerSelect');
  sel.innerHTML = '';
  sel.appendChild(el('option', {value:'', text:'— choose a retailer —'}));
  RETAILERS.forEach(rname => sel.appendChild(el('option', {value:rname, text:rname})));
  sel.value = l.retailer_name || '';
  renderRetailerInfo();
  renderListItems();
  renderPepestoResults(pepestoResultsByList.get(l.id) || []);
  document.getElementById('slCompleteBtn').classList.toggle('hidden', l.status === 'completed');
  document.getElementById('slReopenBtn').classList.toggle('hidden', l.status !== 'completed');
}

function renderRetailerInfo(){
  const info = SHOP_FULFILMENT[currentList.retailer_name];
  const box = document.getElementById('slRetailerInfo');
  const linkRow = document.getElementById('slRetailerLinkRow');
  linkRow.innerHTML = '';
  if(!currentList.retailer_name || currentList.retailer_name === 'Manual / Other'){
    box.textContent = currentList.retailer_name ? 'No retailer site on file — use WhatsApp, print or copy below.' : '';
    return;
  }
  if(info){
    const bits = [];
    bits.push('Delivery: ' + (info.delivery === true ? 'available' : 'unknown — check their site'));
    bits.push('Click & Collect: ' + (info.collect === true ? 'available' : 'unknown — check their site'));
    box.textContent = bits.join(' · ') + '. ' + info.note + (info.delivery === null ? ' (Unverified — details may be out of date.)' : '');
    const a = el('a', {href: info.url, target:'_blank', rel:'noopener', class:'btn ghost small', style:'text-decoration:none;', text:'Open ' + currentList.retailer_name + ' shopping'});
    linkRow.appendChild(a);
    linkRow.appendChild(el('span', {class:'hint', style:'margin-top:0;', text:'Opens the retailer site directly. Pepesto handoff is available in the comparison section; retailer login and payment stay with you.'}));
  } else {
    box.textContent = 'No fulfilment details on file for this retailer.';
  }
}

document.querySelectorAll('#slFulfilChips .chip').forEach(chip => {
  chip.addEventListener('click', async () => {
    if(!currentList) return;
    const ok = await updateCurrentList({ fulfilment_method: chip.dataset.fm }, 'Could not save the fulfilment choice');
    if(ok) document.querySelectorAll('#slFulfilChips .chip').forEach(c => { c.classList.toggle('selected', c === chip); c.setAttribute('aria-pressed', String(c === chip)); });
  });
});

document.getElementById('slRetailerSelect').addEventListener('change', async (e) => {
  if(!currentList) return;
  const ok = await updateCurrentList({ retailer_name: e.target.value || null }, 'Could not save the retailer');
  if(ok) renderRetailerInfo();
});

function renderListItems(){
  const wrap = document.getElementById('slItems'); wrap.innerHTML = '';
  if(!currentListItems.length){
    wrap.appendChild(el('div', {class:'hint', text:'No items yet — add some below, or send a recipe here with "Add to shopping list".'}));
    return;
  }
  // Grouped the way you'd walk a shop (produce together, meat/fish together, etc.)
  // rather than in whatever order ingredients happened to be added.
  const byCategory = {};
  currentListItems.forEach(item => {
    const cat = getItemCategory(item);
    (byCategory[cat] = byCategory[cat] || []).push(item);
  });
  const cats = [...CATEGORY_ORDER, ...Object.keys(byCategory).filter(c => !CATEGORY_ORDER.includes(c))];
  cats.forEach(cat => {
    const items = byCategory[cat];
    if(!items || !items.length) return;
    wrap.appendChild(el('div', {class:'sl-category-label', text: cat}));
    items.forEach(item => wrap.appendChild(buildListItemRow(item)));
  });
}

function euro(value, currency = 'EUR'){
  return new Intl.NumberFormat('en-IE', {style:'currency', currency}).format(value);
}

function renderPepestoLoading(){
  const wrap = document.getElementById('pepestoResults');
  wrap.innerHTML = '';
  PEPESTO_RETAILERS.forEach(retailer => {
    const card = el('div', {class:'pepesto-card'});
    card.appendChild(el('div', {style:'font-weight:600;', text:retailer.name}));
    card.appendChild(el('div', {class:'hint', text:'Comparing required items…'}));
    wrap.appendChild(card);
  });
}

function buildPepestoReview(result){
  const details = el('details', {class:'pepesto-review'});
  details.appendChild(el('summary', {text:'View matched products'}));
  (result.matchedItems || []).forEach(match => {
    const row = el('div', {class:'pepesto-match'});
    if(match.productImage) row.appendChild(el('img', {src:match.productImage, alt:''}));
    const text = el('div');
    text.appendChild(el('div', {text:match.requestedItem + ' → ' + (match.productName || 'Matched product')}));
    const facts = [match.packSize, match.packs ? match.packs + ' pack(s)' : null,
      Number.isFinite(match.unitPrice) ? euro(match.unitPrice, result.currency) + ' each' : null,
      Number.isFinite(match.lineTotal) ? euro(match.lineTotal, result.currency) + ' line total' : null,
      match.isSubstitution ? 'Pepesto marks this as a substitution' : null].filter(Boolean);
    if(facts.length) text.appendChild(el('div', {class:'hint', text:facts.join(' · ')}));
    row.appendChild(text); details.appendChild(row);
  });
  if(!(result.matchedItems || []).length) details.appendChild(el('div', {class:'hint', text:'No product matches were returned.'}));
  if((result.unmatchedItems || []).length){
    details.appendChild(el('div', {class:'pepesto-unmatched', text:'Unmatched items'}));
    result.unmatchedItems.forEach(item => details.appendChild(el('div', {class:'pepesto-unmatched', text:'• ' + item.requestedItem})));
  }
  return details;
}

async function createPepestoBasket(result, button){
  if(!currentList || button.disabled) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Creating basket…';
  try {
    const { data, error } = await supabase.functions.invoke('pepesto-basket', {body:{
      shoppingListId:currentList.id, retailerDomain:result.retailer.domain, mode:'checkout'
    }});
    if(error) throw new Error(await pepestoInvokeErrorMessage(error));
    if(!data || data.error) throw new Error(data?.error || 'Basket creation failed');
    const redirectUrl = validHandoffUrl(data.redirectUrl);
    if(!redirectUrl) throw new Error('Pepesto did not return a safe basket-review link.');
    result.redirectUrl = redirectUrl;
    renderPepestoResults(pepestoResultsByList.get(currentList.id) || []);
  } catch(error) {
    button.disabled = false;
    button.textContent = originalText;
    showToast(error.message || 'Basket creation failed', true);
  }
}

function renderPepestoResults(results){
  const wrap = document.getElementById('pepestoResults');
  wrap.innerHTML = '';
  if(!results.length){
    document.getElementById('pepestoRefreshBtn').classList.add('hidden');
    return;
  }
  document.getElementById('pepestoRefreshBtn').classList.remove('hidden');
  const successful = results.filter(r => !r.error);
  const cheapestDomain = cheapestCompleteDomain(successful);
  const ordered = [...rankComparisonResults(successful), ...results.filter(r => r.error)];
  ordered.forEach(result => {
    const failed = Boolean(result.error);
    const card = el('div', {class:'pepesto-card ' + (failed ? 'failed' : (result.completeBasket ? 'complete' : 'incomplete'))});
    card.appendChild(el('div', {style:'font-weight:600;', text:result.retailer.name}));
    if(!failed && result.retailer.domain === cheapestDomain) card.appendChild(el('span', {class:'pepesto-badge', text:'Cheapest complete basket'}));
    if(failed){
      card.appendChild(el('div', {class:'pepesto-total', text:'Comparison failed'}));
      card.appendChild(el('div', {class:'hint', text:result.error}));
      wrap.appendChild(card); return;
    }
    const priceHeading = Number.isFinite(result.estimatedTotal)
      ? euro(result.estimatedTotal, result.currency)
      : (Number.isFinite(result.pricedSubtotal)
        ? 'Subtotal ' + euro(result.pricedSubtotal, result.currency)
        : 'Subtotal unavailable');
    card.appendChild(el('div', {class:'pepesto-total', text:priceHeading}));
    if(!Number.isFinite(result.estimatedTotal) && Number.isFinite(result.pricedSubtotal)){
      card.appendChild(el('div', {class:'hint', text:'Excludes unmatched products and products without a current price.'}));
    }
    card.appendChild(el('div', {class:'hint', text:`${result.matchedCount} matched · ${result.unmatchedCount} unmatched`}));
    card.appendChild(el('div', {class:'hint', text:result.completeBasket ? 'Complete basket match' : 'Incomplete basket — review unmatched items'}));
    card.appendChild(el('div', {class:'hint', text:'Compared ' + new Date(result.requestedAt).toLocaleString('en-IE')}));
    (result.warnings || []).forEach(warning => card.appendChild(el('div', {class:'hint', style:'color:#F2C6BE;', text:warning})));
    card.appendChild(buildPepestoReview(result));
    const redirectUrl = validHandoffUrl(result.redirectUrl);
    if(redirectUrl){
      card.appendChild(el('a', {class:'btn small', href:redirectUrl, target:'_blank', rel:'noopener noreferrer', style:'display:inline-block; text-decoration:none; margin-top:10px;', text:'Review basket at ' + result.retailer.name}));
    } else {
      const createBasket = el('button', {class:'btn small', type:'button', style:'margin-top:10px;', text:'Create basket at ' + result.retailer.name});
      createBasket.addEventListener('click', () => createPepestoBasket(result, createBasket));
      card.appendChild(createBasket);
      card.appendChild(el('div', {class:'hint', text:'Uses one €0.32 Pepesto /oneshot request. You review the basket before retailer login and payment.'}));
    }
    wrap.appendChild(card);
  });
}

async function pepestoInvokeErrorMessage(error){
  try {
    if(error?.context && typeof error.context.clone === 'function'){
      const payload = await error.context.clone().json();
      if(typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
    }
  } catch(_ignored){ /* fall back to the SDK message */ }
  return error?.message || 'Comparison failed';
}

async function comparePepestoBaskets(){
  if(!currentList) return;
  if(!currentListItems.some(item => item.status === 'required')){
    showToast('Add at least one required item before comparing', true); return;
  }
  await pepestoRequestGate.run(async () => {
    const button = document.getElementById('pepestoCompareBtn');
    const refresh = document.getElementById('pepestoRefreshBtn');
    button.disabled = true; refresh.disabled = true;
    try {
      const listId = currentList.id;
      renderPepestoLoading();
      const settled = await settleRetailerComparisons(PEPESTO_RETAILERS, async retailer => {
        const { data, error } = await supabase.functions.invoke('pepesto-basket', {body:{shoppingListId:listId, retailerDomain:retailer.domain, mode:'compare'}});
        if(error) throw new Error(await pepestoInvokeErrorMessage(error));
        if(!data || data.error) throw new Error(data?.error || 'Comparison failed');
        return data;
      });
      const results = settled.map((entry, index) => entry.status === 'fulfilled' ? entry.value : {
        retailer:PEPESTO_RETAILERS[index], error:entry.reason?.message || 'This retailer comparison failed.'
      });
      pepestoResultsByList.set(listId, results);
      if(currentList?.id === listId) renderPepestoResults(results);
    } finally {
      button.disabled = false; refresh.disabled = false;
    }
  });
}
document.getElementById('pepestoCompareBtn').addEventListener('click', comparePepestoBaskets);
document.getElementById('pepestoRefreshBtn').addEventListener('click', comparePepestoBaskets);

function buildListItemRow(item){
  const row = el('div', {class:'sl-item ' + item.status});
  const pill = el('button', {class:'status-pill ' + item.status, type:'button', text: ITEM_STATUS_LABELS[item.status] || item.status});
  pill.addEventListener('click', async () => {
    const next = ITEM_STATUS_CYCLE[(ITEM_STATUS_CYCLE.indexOf(item.status) + 1) % ITEM_STATUS_CYCLE.length];
    const { error } = await safeDb(supabase.from('shopping_list_items').update({ status: next }).eq('id', item.id), 'Could not update the item');
    if(error) return;
    item.status = next;
    row.className = 'sl-item ' + next;
    pill.className = 'status-pill ' + next;
    pill.textContent = ITEM_STATUS_LABELS[next];
  });
  row.appendChild(pill);

  const saveField = async (field, value, input) => {
    const { error } = await safeDb(supabase.from('shopping_list_items').update({ [field]: value }).eq('id', item.id), 'Could not save the change');
    if(error){ input.value = item[field] ?? ''; return; }
    item[field] = value;
  };
  const nameWrap = el('span', {class:'sl-name', style:'flex:2; min-width:130px;'});
  const nameInput = el('input', {type:'text', 'aria-label':'Item name'}); nameInput.value = item.item_name;
  nameInput.addEventListener('change', () => saveField('item_name', nameInput.value.trim() || item.item_name, nameInput));
  nameWrap.appendChild(nameInput);
  row.appendChild(nameWrap);

  const qtyInput = el('input', {type:'number', step:'0.1', min:'0', 'aria-label':'Item quantity', placeholder:'qty', style:'width:70px;'});
  if(item.quantity != null) qtyInput.value = item.quantity;
  qtyInput.addEventListener('change', () => saveField('quantity', qtyInput.value === '' ? null : parseFloat(qtyInput.value), qtyInput));
  row.appendChild(qtyInput);

  const unitInput = el('input', {type:'text', 'aria-label':'Item unit', placeholder:'unit', style:'width:64px;'});
  unitInput.value = item.unit || '';
  unitInput.addEventListener('change', () => saveField('unit', unitInput.value.trim() || null, unitInput));
  row.appendChild(unitInput);

  const notesInput = el('input', {type:'text', 'aria-label':'Item notes or substitutions', placeholder:'notes / substitutions, e.g. gluten-free only', style:'flex:3; min-width:170px;'});
  notesInput.value = item.notes || '';
  notesInput.addEventListener('change', () => saveField('notes', notesInput.value.trim() || null, notesInput));
  row.appendChild(notesInput);

  const del = el('button', {class:'icon-btn', type:'button', text:'✕', title:'Remove', style:'color:var(--text-dim);'});
  del.addEventListener('click', async () => {
    const { error } = await safeDb(supabase.from('shopping_list_items').delete().eq('id', item.id), 'Could not remove the item');
    if(error) return;
    currentListItems = currentListItems.filter(i => i.id !== item.id);
    row.remove();
  });
  row.appendChild(del);

  if(item.quantity_text && item.quantity == null){
    row.appendChild(el('div', {class:'hint', style:'width:100%; margin-top:2px;', text: item.quantity_text}));
  }
  return row;
}

document.getElementById('slExtraAdd').addEventListener('click', async () => {
  const input = document.getElementById('slExtraInput');
  const name = input.value.trim();
  if(!name || !currentList) return;
  const ok = await addItemsToList(currentList, [{ item_name: name }]);
  if(!ok) return;
  input.value = '';
  openListDetail(currentList.id);
});
document.getElementById('slExtraInput').addEventListener('keydown', e => {
  if(e.key === 'Enter'){ e.preventDefault(); document.getElementById('slExtraAdd').click(); }
});

document.getElementById('slAddLowStockBtn').addEventListener('click', async () => {
  if(!currentList) return;
  const low = lowStockItems().filter(i => !currentListItems.some(it => it.pantry_item_id === i.id));
  if(!low.length){ showToast('No low-stock items to add'); return; }
  const ok = await addItemsToList(currentList, low.map(i => ({
    item_name: i.name,
    quantity_text: `have ${i.quantity}${i.unit?(' '+i.unit):''}, keep ≥ ${i.par_level}`,
    pantry_item_id: i.id, source:'low_stock'
  })));
  if(ok) openListDetail(currentList.id);
});

function buildListExportText(){
  const l = currentList;
  const lines = ['🛒 ' + l.title + ' — Kook vir Jou'];
  lines.push('Fulfilment: ' + (FULFIL_LABELS[l.fulfilment_method] || l.fulfilment_method) + (l.retailer_name ? ' · Shop: ' + l.retailer_name : ''));
  lines.push('');

  // Grouped the way you'd walk a shop (produce together, meat/fish together, etc.) rather
  // than by to-do status - required/optional/check-pantry are all still things to pick up
  // while you're in that aisle, so they're flagged inline instead of split into their own sections.
  const toBuy = currentListItems.filter(i => i.status === 'required' || i.status === 'optional' || i.status === 'check_pantry');
  const byCategory = {};
  toBuy.forEach(i => { const cat = getItemCategory(i); (byCategory[cat] = byCategory[cat] || []).push(i); });
  const formatLine = (i) => {
    let line = '• ' + i.item_name;
    const q = i.quantity != null ? `${i.quantity}${i.unit ? ' ' + i.unit : ''}` : (i.quantity_text || '');
    if(q) line += ' — ' + q;
    const flags = [];
    if(i.status === 'optional') flags.push('optional');
    if(i.status === 'check_pantry') flags.push('check pantry first');
    if(i.notes) flags.push(i.notes);
    if(flags.length) line += ' (' + flags.join('; ') + ')';
    return line;
  };
  const cats = [...CATEGORY_ORDER, ...Object.keys(byCategory).filter(c => !CATEGORY_ORDER.includes(c))];
  cats.forEach(cat => {
    const items = byCategory[cat];
    if(!items || !items.length) return;
    lines.push(cat + ':');
    items.forEach(i => lines.push(formatLine(i)));
    lines.push('');
  });

  const alreadyHave = currentListItems.filter(i => i.status === 'already_have');
  const bought = currentListItems.filter(i => i.status === 'bought');
  if(alreadyHave.length){
    lines.push('Already have:');
    alreadyHave.forEach(i => lines.push('• ' + i.item_name + (i.notes ? ' (' + i.notes + ')' : '')));
    lines.push('');
  }
  if(bought.length){
    lines.push('Bought:');
    bought.forEach(i => lines.push('• ' + i.item_name));
    lines.push('');
  }

  const avoid = [...(household.allergies||[]), ...(household.diets||[])];
  if(avoid.length){
    lines.push('⚠️ This household avoids: ' + avoid.join(', ') + '. Check every product label — especially for Coeliac / gluten-free safety. This list is not an allergen guarantee.');
  }
  return lines.join('\n').trim();
}

document.getElementById('slWhatsAppBtn').addEventListener('click', () => {
  if(!currentList) return;
  window.open('https://wa.me/?text=' + encodeURIComponent(buildListExportText()), '_blank');
});
document.getElementById('slCopyBtn').addEventListener('click', async () => {
  if(!currentList) return;
  try { await navigator.clipboard.writeText(buildListExportText()); showToast('Copied to clipboard'); }
  catch(e){ showToast('Could not copy: ' + e.message, true); }
});
document.getElementById('slDownloadBtn').addEventListener('click', () => {
  if(!currentList) return;
  const blob = new Blob([buildListExportText()], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = el('a', {href:url, download: (currentList.title||'shopping-list').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.txt'});
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
});
document.getElementById('slPrintBtn').addEventListener('click', () => {
  if(!currentList) return;
  const area = document.getElementById('printArea');
  area.innerHTML = '';
  buildListExportText().split('\n').forEach((line, idx) => {
    if(idx === 0) area.appendChild(el('h1', {text: line}));
    else if(line.endsWith(':')) area.appendChild(el('h2', {text: line}));
    else if(line) area.appendChild(el('p', {text: line, style:'margin:2px 0;'}));
  });
  area.classList.remove('hidden');
  window.print();
  area.classList.add('hidden');
});

document.getElementById('slCompleteBtn').addEventListener('click', async () => {
  if(!currentList) return;
  if(await updateCurrentList({ status:'completed' }, 'Could not mark the list completed')){ showToast('List completed'); renderListDetail(); }
});
document.getElementById('slReopenBtn').addEventListener('click', async () => {
  if(!currentList) return;
  if(await updateCurrentList({ status:'draft' }, 'Could not reopen the list')){ showToast('List reopened'); renderListDetail(); }
});
document.getElementById('slDeleteBtn').addEventListener('click', async () => {
  if(!currentList) return;
  if(!confirm('Delete "' + currentList.title + '" and its items? This cannot be undone.')) return;
  const { error } = await safeDb(supabase.from('shopping_lists').delete().eq('id', currentList.id), 'Could not delete the list');
  if(error) return;
  showToast('List deleted');
  closeListDetail();
});

// ---------------- MEAL PLAN ----------------
const MP_SLOTS = ['breakfast','lunch','dinner'];

async function loadMealPlan(){
  if(!mpWeekStart) mpWeekStart = mondayOf(new Date());
  const weekStr = isoDate(mpWeekStart);
  const weekEnd = new Date(mpWeekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const { data: plan } = await safeDb(supabase.from('meal_plans').select('*').eq('household_id', household.id).eq('week_start', weekStr).maybeSingle(), 'Could not load the meal plan');
  mpPlan = plan || null;
  const { data: items, error } = await safeDb(supabase.from('meal_plan_items')
    .select('*, recipes(id,title,servings,ingredients,steps)')
    .eq('household_id', household.id)
    .gte('meal_date', weekStr).lte('meal_date', isoDate(weekEnd))
    .order('meal_date'), 'Could not load planned meals');
  if(!error) mpItems = items || [];
  mpSelected = new Set();
  renderMealPlan();
}

async function ensurePlanRow(){
  if(mpPlan) return mpPlan;
  const weekStr = isoDate(mpWeekStart);
  const { data, error } = await safeDb(supabase.from('meal_plans')
    .upsert({ household_id: household.id, week_start: weekStr }, { onConflict:'household_id,week_start' })
    .select().single(), 'Could not create the week plan');
  if(error) return null;
  mpPlan = data;
  return mpPlan;
}

function mealTitle(m){
  if(m.recipes?.title) return m.recipes.title + (m.use_leftovers ? ' (leftovers)' : '');
  if(m.manual_title) return m.manual_title + (m.use_leftovers ? ' (leftovers)' : '');
  return 'Meal';
}

function renderMealPlan(){
  const weekEnd = new Date(mpWeekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  document.getElementById('mpWeekTitle').textContent = 'Week of ' + mpWeekStart.toLocaleDateString('en-IE', {day:'numeric', month:'short'}) + ' – ' + weekEnd.toLocaleDateString('en-IE', {day:'numeric', month:'short'});
  const grid = document.getElementById('mpGrid'); grid.innerHTML = '';
  const todayStr = isoDate(new Date(new Date().setHours(0,0,0,0)));
  for(let i=0;i<7;i++){
    const day = new Date(mpWeekStart); day.setDate(day.getDate() + i);
    const dayStr = isoDate(day);
    const card = el('div', {class:'mp-day' + (dayStr === todayStr ? ' today' : '')});
    const head = el('div', {class:'mp-day-head'});
    head.appendChild(el('span', {text: day.toLocaleDateString('en-IE', {weekday:'long', day:'numeric', month:'short'})}));
    const dayListBtn = el('button', {class:'btn ghost small', type:'button', text:'List for this day', style:'padding:4px 10px; font-size:11px;'});
    dayListBtn.addEventListener('click', () => createListFromMeals(mpItems.filter(m => m.meal_date === dayStr), 'Meals on ' + day.toLocaleDateString('en-IE', {weekday:'short', day:'numeric', month:'short'})));
    head.appendChild(dayListBtn);
    card.appendChild(head);
    MP_SLOTS.forEach(slot => {
      const slotRow = el('div', {class:'mp-slot'});
      slotRow.appendChild(el('div', {class:'slot-label', text: slot}));
      const body = el('div', {class:'slot-body'});
      mpItems.filter(m => m.meal_date === dayStr && m.meal_slot === slot).forEach(m => {
        const meal = el('div', {class:'mp-meal'});
        const left = el('div', {class:'row', style:'gap:8px; flex:1;'});
        const cb = el('input', {type:'checkbox', title:'Tick to include in "Shopping list: ticked meals"'});
        cb.checked = mpSelected.has(m.id);
        cb.addEventListener('change', () => { cb.checked ? mpSelected.add(m.id) : mpSelected.delete(m.id); });
        left.appendChild(cb);
        const info = el('div');
        info.appendChild(el('div', {text: mealTitle(m)}));
        const noteBits = [m.servings ? m.servings + ' servings' : null, m.notes].filter(Boolean).join(' · ');
        if(noteBits) info.appendChild(el('div', {class:'mm-note', text: noteBits}));
        left.appendChild(info);
        meal.appendChild(left);
        if(m.recipes && m.recipes.steps && m.recipes.steps.length){
          const cookBtn = el('button', {class:'btn ghost small', type:'button', text:'Cook now', style:'padding:3px 9px; font-size:11px;'});
          cookBtn.addEventListener('click', () => startCooking(m.recipes));
          meal.appendChild(cookBtn);
        }
        const rm = el('button', {class:'icon-btn', type:'button', text:'✕', title:'Remove meal', style:'color:var(--text-dim);'});
        rm.addEventListener('click', async () => {
          const { error } = await safeDb(supabase.from('meal_plan_items').delete().eq('id', m.id), 'Could not remove the meal');
          if(error) return;
          mpItems = mpItems.filter(x => x.id !== m.id);
          renderMealPlan();
        });
        meal.appendChild(rm);
        body.appendChild(meal);
      });
      const addBtn = el('button', {class:'btn ghost small', type:'button', text:'+ Add', style:'padding:3px 9px; font-size:11px; margin-top:2px;'});
      addBtn.addEventListener('click', () => openMealModal(dayStr, slot));
      body.appendChild(addBtn);
      slotRow.appendChild(body);
      card.appendChild(slotRow);
    });
    grid.appendChild(card);
  }
}

document.getElementById('mpPrevWeek').addEventListener('click', () => { mpWeekStart.setDate(mpWeekStart.getDate() - 7); loadMealPlan(); });
document.getElementById('mpNextWeek').addEventListener('click', () => { mpWeekStart.setDate(mpWeekStart.getDate() + 7); loadMealPlan(); });
document.getElementById('mpThisWeek').addEventListener('click', () => { mpWeekStart = mondayOf(new Date()); loadMealPlan(); });

let mealModalContext = null;
async function openMealModal(dateStr, slot){
  mealModalContext = { dateStr, slot };
  document.getElementById('mealModalTitle').textContent = 'Add ' + slot;
  document.getElementById('mealModalSub').textContent = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IE', {weekday:'long', day:'numeric', month:'long'});
  const recipeSel = document.getElementById('mealRecipeSelect');
  recipeSel.innerHTML = '';
  recipeSel.appendChild(el('option', {value:'', text:'— none —'}));
  const { data: recipes } = await safeDb(supabase.from('recipes').select('id,title,is_favourite,servings').eq('household_id', household.id).order('is_favourite', {ascending:false}).order('generated_at', {ascending:false}).limit(200), 'Could not load recipes');
  const all = recipes || [];
  // Recipes still showing in the New recipes tab get their own group at the top so they're
  // easy to add to the plan right after generating, instead of being buried under favourites.
  const currentIds = new Set((state.currentResults||[]).map(r => r.id));
  const justGenerated = all.filter(r => currentIds.has(r.id));
  const others = all.filter(r => !currentIds.has(r.id));
  if(justGenerated.length){
    const grp = el('optgroup', {label:'✨ Just generated (New recipes tab)'});
    justGenerated.forEach(r => grp.appendChild(el('option', {value:r.id, text:(r.is_favourite ? '★ ' : '') + r.title})));
    recipeSel.appendChild(grp);
  }
  if(others.length){
    const grp2 = el('optgroup', {label: justGenerated.length ? 'Other saved recipes' : 'Saved recipes'});
    others.forEach(r => grp2.appendChild(el('option', {value:r.id, text:(r.is_favourite ? '★ ' : '') + r.title})));
    recipeSel.appendChild(grp2);
  }
  const loSel = document.getElementById('mealLeftoverSelect');
  loSel.innerHTML = '';
  loSel.appendChild(el('option', {value:'', text:'— none —'}));
  const { data: los } = await safeDb(supabase.from('leftovers').select('*').eq('household_id', household.id).is('consumed_at', null).order('created_at', {ascending:false}).limit(20), 'Could not load leftovers');
  (los||[]).forEach(l => loSel.appendChild(el('option', {value:l.id, text:(l.recipe_title||'Leftovers') + ' — ' + l.amount})));
  document.getElementById('mealManualInput').value = '';
  document.getElementById('mealServings').value = state.servings;
  document.getElementById('mealCookTwice').checked = false;
  document.getElementById('mealNotes').value = '';
  document.getElementById('mealModal').classList.remove('hidden');
}
document.getElementById('mealCancelBtn').addEventListener('click', () => document.getElementById('mealModal').classList.add('hidden'));
document.getElementById('mealSaveBtn').addEventListener('click', async () => {
  if(!mealModalContext) return;
  const plan = await ensurePlanRow();
  if(!plan) return;
  const recipeId = document.getElementById('mealRecipeSelect').value || null;
  const manual = document.getElementById('mealManualInput').value.trim() || null;
  const leftoverSel = document.getElementById('mealLeftoverSelect');
  const leftoverId = leftoverSel.value || null;
  const leftoverTitle = leftoverId ? leftoverSel.options[leftoverSel.selectedIndex].text : null;
  if(!recipeId && !manual && !leftoverId){ showToast('Pick a recipe, type a meal, or choose leftovers', true); return; }
  const servings = parseInt(document.getElementById('mealServings').value) || null;
  const notes = document.getElementById('mealNotes').value.trim() || null;
  const cookTwice = document.getElementById('mealCookTwice').checked;
  const row = {
    meal_plan_id: plan.id, household_id: household.id,
    meal_date: mealModalContext.dateStr, meal_slot: mealModalContext.slot,
    recipe_id: recipeId, manual_title: manual || (leftoverId ? leftoverTitle : null),
    servings, notes, use_leftovers: !!leftoverId, leftover_id: leftoverId
  };
  let followup=null;
  if(cookTwice){
    const nextDay=new Date(mealModalContext.dateStr+'T00:00:00'); nextDay.setDate(nextDay.getDate()+1);
    followup={week_start:isoDate(mondayOf(nextDay)),meal_date:isoDate(nextDay),meal_slot:'lunch',recipe_id:recipeId,manual_title:manual,servings};
  }
  const { error } = await safeDb(supabase.rpc('add_meal_with_optional_leftover',{p_meal:row,p_followup:followup}), 'Could not add the meal');
  if(error) return;
  await loadMealPlan();
  document.getElementById('mealModal').classList.add('hidden');
  renderMealPlan();
});

// Aggregate ingredients from planned meals (scaled by servings), subtract pantry, persist as a list.
async function createListFromMeals(items, title){
  const cookMeals = items.filter(m => !m.use_leftovers); // leftover meals don't need shopping
  const withRecipes = cookMeals.filter(m => m.recipes?.ingredients?.length);
  if(!withRecipes.length){ showToast('No recipe-backed meals there to shop for', true); return; }
  const list = await ensureDraftList(title, 'meal_plan');
  if(!list) return;
  // Skip recipes whose ingredients are already in this list, so re-running "shopping list
  // for the week" (or overlapping day/selected-meal lists) doesn't double up quantities.
  const recipeIds = withRecipes.map(m => m.recipe_id).filter(Boolean);
  const already = await recipeIdsAlreadyInList(list.id, recipeIds);
  const newMeals = withRecipes.filter(m => !m.recipe_id || !already.has(m.recipe_id));
  const skippedForDup = withRecipes.length - newMeals.length;
  if(!newMeals.length){
    showToast('All of those recipes are already in "' + list.title + '"');
    openShoppingTab(list.id);
    return;
  }
  const aggregated = {};
  newMeals.forEach(m => {
    const scale = (m.servings && m.recipes.servings > 0) ? m.servings / m.recipes.servings : 1;
    (m.recipes.ingredients||[]).forEach(ing => {
      const amt = parseFloat(ing.amount);
      const scaledAmt = isNaN(amt) ? null : amt * scale;
      // Same key scheme (and same merge helper) addItemsToList uses below, so aggregating a
      // week's meals here and folding into an existing list line later never disagree about
      // what counts as "the same ingredient".
      const key = baseIngredientKey(ing.item) + '|' + mergeUnitKey(ing.unit);
      const existing = aggregated[key];
      if(!existing){
        aggregated[key] = { ...ing, amount: scaledAmt == null ? ing.amount : scaledAmt, recipeId: m.recipe_id };
        return;
      }
      if(scaledAmt == null) return; // can't safely fold a non-numeric amount in, keep the first one
      const merged = mergeCompatibleQuantity(existing.amount, existing.unit, scaledAmt, ing.unit);
      if(merged){ existing.amount = merged.quantity; existing.unit = merged.unit; }
    });
  });
  const listItems = Object.values(aggregated).map(ing => {
    const rounded = typeof ing.amount === 'number' ? Number(ing.amount.toFixed(2)) : ing.amount;
    return ingredientToListItem({ ...ing, amount: rounded }, ing.recipeId);
  });
  const ok = await addItemsToList(list, listItems);
  if(!ok) return;
  const skippedManual = cookMeals.length - withRecipes.length;
  const notes = [];
  if(skippedManual) notes.push(`${skippedManual} manual meal(s) skipped — no ingredient data`);
  if(skippedForDup) notes.push(`${skippedForDup} recipe(s) already in the list, skipped`);
  showToast('Added ' + listItems.length + ' item(s) to "' + list.title + '"' + (notes.length ? ` (${notes.join('; ')})` : ''));
  openShoppingTab(list.id);
}
document.getElementById('mpListWeekBtn').addEventListener('click', () => createListFromMeals(mpItems, 'Meal plan — week of ' + mpWeekStart.toLocaleDateString('en-IE', {day:'numeric', month:'short'})));
document.getElementById('mpListSelectedBtn').addEventListener('click', () => {
  const selected = mpItems.filter(m => mpSelected.has(m.id));
  if(!selected.length){ showToast('Tick some meals first', true); return; }
  createListFromMeals(selected, 'Selected meals');
});

// ---------------- EXPIRY REMINDERS (in-app; notifications only fire while the app is open) ----------------
function expiryBuckets(){
  const todayStr = isoDate(new Date(new Date().setHours(0,0,0,0)));
  const groups = { expired:[], today:[], tomorrow:[], three:[], seven:[] };
  pantryItems.forEach(item => {
    if(!item.expiry_date || Number(item.quantity) <= 0) return;
    if(item.reminder_snooze_until && item.reminder_snooze_until > todayStr) return;
    const d = daysUntil(item.expiry_date);
    if(d === null || d > 7) return;
    if(d < 0) groups.expired.push(item);
    else if(d === 0) groups.today.push(item);
    else if(d === 1) groups.tomorrow.push(item);
    else if(d <= 3) groups.three.push(item);
    else groups.seven.push(item);
  });
  return groups;
}

function renderExpiringPanel(){
  const panel = document.getElementById('expiringPanel');
  const body = document.getElementById('expiringBody');
  const groups = expiryBuckets();
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  if(!total){ panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  body.innerHTML = '';
  const labels = [['expired','Already expired'],['today','Expires today'],['tomorrow','Expires tomorrow'],['three','Within 3 days'],['seven','Within 7 days']];
  labels.forEach(([key, label]) => {
    const items = groups[key];
    if(!items.length) return;
    body.appendChild(el('div', {class:'exp-group-label' + (key === 'three' || key === 'seven' ? ' later' : ''), text: label}));
    items.forEach(item => {
      const row = el('div', {class:'exp-item'});
      row.appendChild(el('span', {text: `${item.name} — ${item.quantity}${item.unit ? ' ' + item.unit : ''} (use by ${item.expiry_date})`}));
      const btns = el('div', {class:'row', style:'gap:6px;'});
      const useBtn = el('button', {class:'btn ghost small', type:'button', text:'Use in recipe'});
      useBtn.addEventListener('click', () => {
        if(!state.onHand.includes(item.name)) state.onHand.push(item.name);
        renderOnHand();
        switchToTab('recipes');
        showToast('"' + item.name + '" added to ingredients on hand');
      });
      const eatBtn = el('button', {class:'btn ghost small', type:'button', text:'Mark consumed'});
      eatBtn.addEventListener('click', async () => {
        const { error } = await safeDb(supabase.from('pantry_items').update({ quantity: 0, updated_at: new Date().toISOString() }).eq('id', item.id), 'Could not mark it consumed');
        if(error) return;
        item.quantity = 0;
        renderPantryList(); renderShoppingNeeded(); renderExpiringPanel();
      });
      const snoozeBtn = el('button', {class:'btn ghost small', type:'button', text:'Snooze 3d'});
      snoozeBtn.addEventListener('click', async () => {
        const until = new Date(); until.setDate(until.getDate() + 3);
        const untilStr = isoDate(until);
        const { error } = await safeDb(supabase.from('pantry_items').update({ reminder_snooze_until: untilStr }).eq('id', item.id), 'Could not snooze the reminder');
        if(error) return;
        item.reminder_snooze_until = untilStr;
        renderExpiringPanel();
      });
      btns.appendChild(useBtn); btns.appendChild(eatBtn); btns.appendChild(snoozeBtn);
      row.appendChild(btns);
      body.appendChild(row);
    });
  });
}

function updateRemindersStatus(){
  const btn = document.getElementById('enableRemindersBtn');
  const status = document.getElementById('remindersStatus');
  if(!('Notification' in window)){
    btn.classList.add('hidden');
    status.textContent = 'Browser notifications are not supported here — reminders show in this panel instead.';
    return;
  }
  if(Notification.permission === 'granted' && localStorage.getItem('kvj_reminders') === 'on'){
    btn.classList.add('hidden');
    status.textContent = 'Reminders on: you\'ll get a notification about expiring items when you open the app. (Not a background push — nothing fires while the app is closed.)';
  } else if(Notification.permission === 'denied'){
    btn.classList.add('hidden');
    status.textContent = 'Notifications are blocked in your browser settings — reminders show in this panel instead.';
  } else {
    btn.classList.remove('hidden');
    status.textContent = '';
  }
}
document.getElementById('enableRemindersBtn').addEventListener('click', async () => {
  if(!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  if(perm === 'granted'){ localStorage.setItem('kvj_reminders', 'on'); showToast('Expiry reminders enabled'); maybeShowExpiryNotification(true); }
  updateRemindersStatus();
});
async function maybeShowExpiryNotification(force){
  if(!('Notification' in window) || Notification.permission !== 'granted' || localStorage.getItem('kvj_reminders') !== 'on') return;
  const todayStr = isoDate(new Date(new Date().setHours(0,0,0,0)));
  if(!force && localStorage.getItem('kvj_last_expiry_notif') === todayStr) return; // once a day is plenty
  const groups = expiryBuckets();
  const urgent = [...groups.expired, ...groups.today, ...groups.tomorrow];
  if(!urgent.length) return;
  localStorage.setItem('kvj_last_expiry_notif', todayStr);
  const bodyText = urgent.slice(0,5).map(i => i.name + ' (' + i.expiry_date + ')').join(', ') + (urgent.length > 5 ? ` and ${urgent.length-5} more` : '');
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if(reg && reg.showNotification) reg.showNotification('Kook vir Jou — use these soon', { body: bodyText, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
    else new Notification('Kook vir Jou — use these soon', { body: bodyText, icon: 'icons/icon-192.png' });
  } catch(e){ console.error('Could not show the expiry notification', e); }
}

// ---------------- BARCODE + OPEN FOOD FACTS ----------------
let barcodeStream = null, barcodeDetectLoop = null;

document.getElementById('barcodeLookupBtn').addEventListener('click', () => {
  const code = document.getElementById('barcodeManualInput').value.trim().replace(/\s+/g,'');
  if(!code){ document.getElementById('barcodeStatus').textContent = 'Type or scan a barcode first.'; return; }
  lookupBarcode(code);
});
document.getElementById('barcodeManualInput').addEventListener('keydown', e => {
  if(e.key === 'Enter'){ e.preventDefault(); document.getElementById('barcodeLookupBtn').click(); }
});

document.getElementById('barcodeScanBtn').addEventListener('click', async () => {
  const status = document.getElementById('barcodeStatus');
  if(!('BarcodeDetector' in window)){
    status.textContent = 'This browser has no built-in barcode detector (works in Chrome/Edge on Android and desktop). Type the barcode instead — the number under the bars.';
    document.getElementById('barcodeManualInput').focus();
    return;
  }
  try {
    const detector = new BarcodeDetector({ formats: ['ean_13','ean_8','upc_a','upc_e','code_128'] });
    barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'environment' } });
    const video = document.getElementById('barcodeVideo');
    video.srcObject = barcodeStream;
    document.getElementById('barcodeVideoWrap').classList.remove('hidden');
    status.textContent = 'Point the camera at the barcode…';
    barcodeDetectLoop = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if(codes.length){
          const code = codes[0].rawValue;
          stopBarcodeCamera();
          document.getElementById('barcodeManualInput').value = code;
          lookupBarcode(code);
        }
      } catch(e){ /* frame not ready yet */ }
    }, 350);
  } catch(e){
    status.textContent = 'Camera not available (' + e.message + '). Type the barcode instead.';
  }
});
function stopBarcodeCamera(){
  clearInterval(barcodeDetectLoop); barcodeDetectLoop = null;
  if(barcodeStream){ barcodeStream.getTracks().forEach(t => t.stop()); barcodeStream = null; }
  document.getElementById('barcodeVideoWrap').classList.add('hidden');
}
document.getElementById('barcodeStopBtn').addEventListener('click', stopBarcodeCamera);

async function lookupBarcode(code){
  const status = document.getElementById('barcodeStatus');
  const resultWrap = document.getElementById('barcodeResult');
  resultWrap.innerHTML = '';
  status.textContent = 'Looking up ' + code + ' on Open Food Facts…';
  let product = null;
  try {
    const resp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,quantity,ingredients_text,allergens_tags,nutriments,code`);
    const data = await resp.json();
    if(data.status === 1 && data.product) product = data.product;
  } catch(e){
    status.textContent = 'Open Food Facts request failed (' + e.message + ') — you can still add the item manually below.';
    resultWrap.appendChild(buildBarcodeConfirmCard(code, null));
    return;
  }
  if(!product){
    status.textContent = 'Product ' + code + ' not found on Open Food Facts. Fill it in manually — the barcode will still be saved with the item.';
    resultWrap.appendChild(buildBarcodeConfirmCard(code, null));
    return;
  }
  status.textContent = 'Found it — check the details, edit anything, then confirm:';
  resultWrap.appendChild(buildBarcodeConfirmCard(code, product));
}

function buildBarcodeConfirmCard(code, product){
  const card = el('div', {class:'panel', style:'padding:14px 16px;'});
  const name = product ? [product.product_name, product.brands ? '(' + product.brands.split(',')[0].trim() + ')' : ''].filter(Boolean).join(' ') : '';
  card.appendChild(el('div', {style:'font-weight:600;', text: product ? (product.product_name || 'Unnamed product') : 'Manual entry for barcode ' + code}));
  if(product) card.appendChild(el('div', {class:'source-note', text:'Product data from Open Food Facts (community database) — not an AI guess. Check the physical label for allergens.'}));

  // parse "500 g" / "1 l" style package size
  let qtyGuess = '', unitGuess = '';
  if(product?.quantity){
    const m = product.quantity.match(/([\d.,]+)\s*([a-zA-Z]+)/);
    if(m){ qtyGuess = m[1].replace(',', '.'); unitGuess = m[2].toLowerCase(); }
  }

  const row1 = el('div', {class:'row', style:'margin-top:10px;'});
  const nameInput = el('input', {type:'text', placeholder:'Item name', style:'flex:2; min-width:160px;'});
  nameInput.value = product ? (product.product_name || '') : '';
  const qtyInput = el('input', {type:'number', step:'0.1', min:'0', placeholder:'qty', style:'width:80px;'});
  qtyInput.value = qtyGuess;
  const unitInput = el('input', {type:'text', placeholder:'unit', style:'width:70px;'});
  unitInput.value = unitGuess;
  const expInput = el('input', {type:'text', placeholder:'expiry yyyy-mm-dd', style:'width:150px;'});
  row1.appendChild(nameInput); row1.appendChild(qtyInput); row1.appendChild(unitInput); row1.appendChild(expInput);
  card.appendChild(row1);
  const trackLabel = el('label', {style:'font-size:12.5px; display:flex; align-items:center; gap:6px; margin-top:8px;'});
  const trackCb = el('input', {type:'checkbox'});
  trackLabel.appendChild(trackCb);
  trackLabel.appendChild(document.createTextNode(' track use in recipes'));
  card.appendChild(trackLabel);

  if(product){
    const facts = el('div', {class:'hint', style:'margin-top:10px;'});
    if(product.brands) facts.appendChild(el('div', {text:'Brand: ' + product.brands}));
    if(product.quantity) facts.appendChild(el('div', {text:'Package size: ' + product.quantity}));
    if(product.ingredients_text) facts.appendChild(el('div', {text:'Ingredients (label): ' + product.ingredients_text}));
    const allergens = (product.allergens_tags||[]).map(t => t.replace(/^[a-z]{2}:/,'').replace(/-/g,' '));
    if(allergens.length) facts.appendChild(el('div', {style:'color:var(--warn);', text:'Allergens on record: ' + allergens.join(', ') + ' (from Open Food Facts — still check the label)'}));
    const n = product.nutriments || {};
    const nutBits = [];
    if(n['energy-kcal_100g'] != null) nutBits.push(Math.round(n['energy-kcal_100g']) + ' kcal');
    if(n.proteins_100g != null) nutBits.push(n.proteins_100g + 'g protein');
    if(n.carbohydrates_100g != null) nutBits.push(n.carbohydrates_100g + 'g carbs');
    if(n.fat_100g != null) nutBits.push(n.fat_100g + 'g fat');
    if(n.salt_100g != null) nutBits.push(n.salt_100g + 'g salt');
    if(nutBits.length) facts.appendChild(el('div', {text:'Per 100g (Open Food Facts): ' + nutBits.join(' · ')}));
    card.appendChild(facts);
  }

  const saveBtn = el('button', {class:'btn small', type:'button', text:'Add to pantry', style:'margin-top:12px;'});
  saveBtn.addEventListener('click', async () => {
    const itemName = nameInput.value.trim();
    if(!itemName){ nameInput.focus(); nameInput.style.borderColor = 'var(--warn)'; return; }
    const quantity = parseFloat(qtyInput.value) || 0;
    const n = product?.nutriments || {};
    const nutrition = {};
    ['energy-kcal_100g','proteins_100g','carbohydrates_100g','fat_100g','salt_100g','sugars_100g','fiber_100g'].forEach(k => { if(n[k] != null) nutrition[k] = n[k]; });
    const allergens = (product?.allergens_tags||[]).map(t => t.replace(/^[a-z]{2}:/,'').replace(/-/g,' ')).join(', ');
    const { data, error } = await safeDb(supabase.from('pantry_items').insert({
      household_id: household.id, name: itemName, quantity,
      unit: unitInput.value.trim() || null, expiry_date: expInput.value.trim() || null,
      track_consumption: trackCb.checked, source:'barcode',
      barcode: code, brand: product?.brands || null,
      product_data: product ? { code: product.code, product_name: product.product_name, brands: product.brands, quantity: product.quantity } : null,
      nutrition_per_100g: Object.keys(nutrition).length ? nutrition : null,
      ingredients_text: product?.ingredients_text || null,
      allergen_text: allergens || null
    }).select().single(), 'Could not save the item');
    if(error) return;
    if(data){ pantryItems.push(data); renderPantryList(); renderShoppingNeeded(); renderExpiringPanel(); }
    showToast('"' + itemName + '" added to Koskas');
    card.remove();
    document.getElementById('barcodeStatus').textContent = '';
    document.getElementById('barcodeManualInput').value = '';
  });
  card.appendChild(saveBtn);
  return card;
}

// ---------------- PWA SERVICE WORKER ----------------
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(e => console.error('Service worker registration failed', e));
  });
}

renderOnHand();
