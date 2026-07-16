import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.5";

const ORIGINS = ["https://kookvirjou.com", "https://www.kookvirjou.com"];
const NETLIFY = /^https:\/\/([a-z0-9-]+--)?kookvirmy\.netlify\.app$/i;
function allowed(req: Request) { const o=req.headers.get("origin"); return !o || ORIGINS.includes(o) || NETLIFY.test(o) || o === "http://localhost:8888"; }
function headers(req: Request) { const o=req.headers.get("origin")||""; return {"Access-Control-Allow-Origin":allowed(req)&&o?o:ORIGINS[0],"Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store","Vary":"Origin"}; }
function json(req: Request, value: unknown, status=200) { return new Response(JSON.stringify(value),{status,headers:headers(req)}); }

Deno.serve(async req => {
  if(req.method === "OPTIONS") return new Response("ok",{headers:headers(req)});
  if(req.method !== "POST") return json(req,{error:"Method not allowed."},405);
  if(!allowed(req)) return json(req,{error:"Origin not allowed."},403);
  try {
    const auth=req.headers.get("authorization");
    if(!auth?.startsWith("Bearer ")) return json(req,{error:"Authentication required."},401);
    const url=Deno.env.get("SUPABASE_URL"), anon=Deno.env.get("SUPABASE_ANON_KEY"), key=Deno.env.get("GOOGLE_MAPS_API_KEY");
    if(!url||!anon||!key) return json(req,{error:"Map search is not configured."},503);
    const client=createClient(url,anon,{global:{headers:{Authorization:auth}}});
    const {data:user,error}=await client.auth.getUser();
    if(error||!user.user) return json(req,{error:"Authentication required."},401);
    const raw=await req.text();
    if(new TextEncoder().encode(raw).byteLength>2048) return json(req,{error:"Request is too large."},413);
    let body:Record<string,unknown>; try{body=JSON.parse(raw);}catch{return json(req,{error:"Invalid request."},400);}
    if(body.action === "geocode"){
      if(typeof body.address!=="string"||!body.address.trim()||body.address.length>500) return json(req,{error:"Enter a valid address."},400);
      const upstream=await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(body.address)}&key=${key}`);
      const data=await upstream.json(); const loc=data?.results?.[0]?.geometry?.location;
      if(!upstream.ok||data.status!=="OK"||!Number.isFinite(loc?.lat)||!Number.isFinite(loc?.lng)) return json(req,{error:"The address could not be located."},422);
      return json(req,{lat:loc.lat,lon:loc.lng});
    }
    if(body.action === "nearby"){
      const lat=Number(body.lat),lon=Number(body.lon);
      if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lon)||lon < -180||lon > 180) return json(req,{error:"Invalid map location."},400);
      const upstream=await fetch("https://places.googleapis.com/v1/places:searchNearby",{method:"POST",headers:{"Content-Type":"application/json","X-Goog-Api-Key":key,"X-Goog-FieldMask":"places.displayName,places.location,places.primaryType"},body:JSON.stringify({includedTypes:["supermarket","grocery_store"],maxResultCount:20,locationRestriction:{circle:{center:{latitude:lat,longitude:lon},radius:20000}}})});
      if(!upstream.ok) return json(req,{error:"Nearby shops could not be loaded."},502);
      const data=await upstream.json();
      return json(req,{places:(data.places||[]).map((p:Record<string,any>)=>({name:p.displayName?.text||"Shop",lat:p.location?.latitude,lon:p.location?.longitude})).filter((p:Record<string,unknown>)=>Number.isFinite(p.lat)&&Number.isFinite(p.lon))});
    }
    return json(req,{error:"Invalid map action."},400);
  }catch{return json(req,{error:"Map request failed."},502);}
});
