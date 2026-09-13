import { corsHeaders, json, adminClient, sendWhatsApp, sendEmail } from '../_shared.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
Deno.serve(async req=>{
 if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
 try{
  const auth=req.headers.get('Authorization'); if(!auth) return json({error:'Authentication required'},401);
  const userClient=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
  const {data:{user}}=await userClient.auth.getUser(); if(!user) return json({error:'Invalid session'},401);
  const body=await req.json(); const db=adminClient();
  const {data:membership}=await db.from('clinic_users').select('clinic_id,role').eq('user_id',user.id).limit(1).maybeSingle(); if(!membership) return json({error:'No clinic access'},403);
  const {data:clinic}=await db.from('clinics').select('*').eq('id',membership.clinic_id).single();
  if(body.action==='test-whatsapp'){ if(!body.to) return json({error:'Phone required'},400); const id=await sendWhatsApp(clinic,body.to,Deno.env.get('WHATSAPP_TEST_TEMPLATE')||'hello_world',[clinic.name]); return json({ok:true,message_id:id}); }
  if(body.action==='test-email'){ if(!body.to) return json({error:'Email required'},400); const id=await sendEmail(body.to,`ClinicReminder test — ${clinic.name}`,`<p>This is a ClinicReminder test email for <strong>${clinic.name}</strong>.</p>`); return json({ok:true,message_id:id}); }
  return json({error:'Unknown action'},400);
 }catch(e){return json({error:e?.message||'Server error'},500)}
});
