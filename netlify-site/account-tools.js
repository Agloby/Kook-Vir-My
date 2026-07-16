export function downloadJson(value, filename){
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
}
export async function exportAccountData(supabase){
  const {data,error}=await supabase.functions.invoke('export-account-data',{body:{}});
  if(error||data?.error) throw new Error(data?.error||error?.message||'Data export failed');
  downloadJson(data,`kook-vir-jou-export-${new Date().toISOString().slice(0,10)}.json`);
}
export async function leaveHousehold(supabase){
  const {data,error}=await supabase.rpc('leave_household');
  if(error) throw error; return data;
}
