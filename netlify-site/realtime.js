export function subscribeToHousehold(supabase,householdId,onChange){
  let timer; const notify=table=>{clearTimeout(timer);timer=setTimeout(()=>onChange(table),350);};
  const channel=supabase.channel(`household-${householdId}`);
  for(const table of ['shopping_lists','shopping_list_items','meal_plans','meal_plan_items','pantry_items','leftovers']){
    channel.on('postgres_changes',{event:'*',schema:'public',table,filter:`household_id=eq.${householdId}`},()=>notify(table));
  }
  channel.on('postgres_changes',{event:'*',schema:'public',table:'usage_alerts'},()=>notify('usage_alerts'));
  channel.subscribe(); return ()=>supabase.removeChannel(channel);
}
