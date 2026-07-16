import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.5";
const ORIGINS=["https://kookvirjou.com","https://www.kookvirjou.com"],NETLIFY=/^https:\/\/([a-z0-9-]+--)?kookvirmy\.netlify\.app$/i;
function allowed(r:Request){const o=r.headers.get("origin");return !o||ORIGINS.includes(o)||NETLIFY.test(o)||o==="http://localhost:8888";}
function h(r:Request){const o=r.headers.get("origin")||"";return{"Access-Control-Allow-Origin":allowed(r)&&o?o:ORIGINS[0],"Access-Control-Allow-Headers":"authorization, content-type, apikey, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store","Vary":"Origin"};}
Deno.serve(async r=>{if(r.method==="OPTIONS")return new Response("ok",{headers:h(r)});if(r.method!=="POST"||!allowed(r))return new Response(JSON.stringify({error:"Request not allowed."}),{status:403,headers:h(r)});
 try{const auth=r.headers.get("authorization"),url=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!auth||!url||!anon||!service)throw new Error();
 const body=await r.json();if(body?.confirmation!=="DELETE MY ACCOUNT")return new Response(JSON.stringify({error:"Confirmation is required."}),{status:400,headers:h(r)});
 const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}}});const {data}=await userClient.auth.getUser();if(!data.user)return new Response(JSON.stringify({error:"Authentication required."}),{status:401,headers:h(r)});
 const admin=createClient(url,service,{auth:{persistSession:false}});const {error}=await admin.auth.admin.deleteUser(data.user.id);if(error)throw error;return new Response(JSON.stringify({deleted:true}),{headers:h(r)});
 }catch{return new Response(JSON.stringify({error:"The account could not be deleted."}),{status:500,headers:h(r)});}});
