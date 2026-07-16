function safeContext(){return {path:location.pathname,userAgent:navigator.userAgent.slice(0,300),online:navigator.onLine};}
export function installClientMonitoring(supabase,getReady){
  const send=(source,message,extra={})=>{if(!getReady())return;supabase.rpc('record_client_error',{p_source:source,p_message:String(message).slice(0,1000),p_context:{...safeContext(),...extra}}).then(()=>{});};
  window.addEventListener('error',e=>send('window.error',e.message,{file:e.filename?.split('/').pop(),line:e.lineno,column:e.colno}));
  window.addEventListener('unhandledrejection',e=>send('unhandledrejection',e.reason?.message||e.reason||'Unknown rejection'));
  return send;
}
export async function loadUsageSummary(supabase){
  const since=new Date();since.setHours(0,0,0,0);
  const [{data:events},{data:alerts}]=await Promise.all([
    supabase.from('usage_events').select('category,estimated_cost_eur,created_at').gte('created_at',since.toISOString()),
    supabase.from('usage_alerts').select('*').is('acknowledged_at',null).order('created_at',{ascending:false})
  ]);
  return {events:events||[],alerts:alerts||[],total:(events||[]).reduce((n,e)=>n+Number(e.estimated_cost_eur||0),0)};
}
