import { corsHeaders, json, adminClient } from '../_shared.ts';
Deno.serve(async req=>{
 if(req.method==='GET'){const u=new URL(req.url);if(u.searchParams.get('hub.verify_token')===Deno.env.get('META_VERIFY_TOKEN')) return new Response(u.searchParams.get('hub.challenge')||'',{status:200});return new Response('Forbidden',{status:403});}
 if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
 try{const payload=await req.json();const db=adminClient();await db.from('webhook_events').insert({payload});return json({received:true});}catch(e){return json({error:e?.message||'Webhook error'},500)}
});
