import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.5";
const ORIGINS=["https://kookvirjou.com","https://www.kookvirjou.com"],NETLIFY=/^https:\/\/([a-z0-9-]+--)?kookvirmy\.netlify\.app$/i;
function allowed(r:Request){const o=r.headers.get("origin");return !o||ORIGINS.includes(o)||NETLIFY.test(o)||o==="http://localhost:8888";}
function h(r:Request){const o=r.headers.get("origin")||"";return{"Access-Control-Allow-Origin":allowed(r)&&o?o:ORIGINS[0],"Access-Control-Allow-Headers":"authorization, content-type, apikey, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store","Vary":"Origin"};}
Deno.serve(async r=>{if(r.method==="OPTIONS")return new Response("ok",{headers:h(r)});if(r.method!=="POST"||!allowed(r))return new Response(JSON.stringify({error:"Request not allowed."}),{status:403,headers:h(r)});
 try{const auth=r.headers.get("authorization"),url=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY");if(!auth||!url||!anon)return new Response(JSON.stringify({error:"Authentication required."}),{status:401,headers:h(r)});
 const client=createClient(url,anon,{global:{headers:{Authorization:auth}}});const {data:user}=await client.auth.getUser();if(!user.user)return new Response(JSON.stringify({error:"Authentication required."}),{status:401,headers:h(r)});
 const {data:membership}=await client.from("household_members").select("household_id,role,joined_at").eq("user_id",user.user.id).single();
 const tables=["profiles","households","household_members","recipes","recipe_ratings","recipe_feedback_tags","pantry_items","leftovers","shops","ingredient_prices","shopping_lists","shopping_list_items","meal_plans","meal_plan_items","usage_events","usage_alerts"];
 const exported:Record<string,unknown>={exported_at:new Date().toISOString(),account:{id:user.user.id,email:user.user.email,created_at:user.user.created_at},membership};
 for(const table of tables){const {data,error}=await client.from(table).select("*");if(error)throw new Error(`Could not export ${table}`);exported[table]=data||[];}
 return new Response(JSON.stringify(exported),{headers:{...h(r),"Content-Disposition":`attachment; filename="kook-vir-jou-export-${new Date().toISOString().slice(0,10)}.json"`}});
 }catch(error){console.error(JSON.stringify({event:"export_error",message:error instanceof Error?error.message:String(error)}));return new Response(JSON.stringify({error:"Data export failed."}),{status:500,headers:h(r)});}});
