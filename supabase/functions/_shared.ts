import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-clinic-api-key, x-cron-secret',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
export function adminClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}
export async function clinicFromApiKey(req: Request) {
  const key = req.headers.get('x-clinic-api-key');
  if (!key) return null;
  const db = adminClient();
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
  const { data } = await db.from('clinics').select('*').eq('api_key_hash', hex).maybeSingle();
  return data;
}
export function cleanPhone(v: string) { return String(v || '').replace(/[^\d+]/g,'').replace(/^00/,'+'); }
export function formatDateTime(iso: string, timezone = 'Asia/Kuala_Lumpur') {
  return new Intl.DateTimeFormat('en-MY',{dateStyle:'full',timeStyle:'short',timeZone:timezone}).format(new Date(iso));
}
export async function sendWhatsApp(clinic: any, to: string, templateName: string, params: string[]) {
  const db = adminClient();
  const { data: integration } = await db.from('clinic_integrations').select('*').eq('clinic_id', clinic.id).single();
  if (!integration?.whatsapp_phone_number_id || !integration?.whatsapp_access_token) throw new Error('WhatsApp integration is not configured');
  const version = Deno.env.get('META_GRAPH_VERSION') || 'v23.0';
  const language = Deno.env.get('WHATSAPP_TEMPLATE_LANGUAGE') || 'en_US';
  const r = await fetch(`https://graph.facebook.com/${version}/${integration.whatsapp_phone_number_id}/messages`, {
    method:'POST', headers:{Authorization:`Bearer ${integration.whatsapp_access_token}`,'Content-Type':'application/json'},
    body: JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:cleanPhone(to),type:'template',template:{name:templateName,language:{code:language},components:[{type:'body',parameters:params.map((text,i)=>({type:'text',parameter_name:['patient_name','clinic_name','doctor_name','appointment_datetime'][i],text}))},{type:'button',sub_type:'quick_reply',index:'0',parameters:[{type:'payload',payload:'CONFIRM'}]},{type:'button',sub_type:'quick_reply',index:'1',parameters:[{type:'payload',payload:'RESCHEDULE'}]},{type:'button',sub_type:'quick_reply',index:'2',parameters:[{type:'payload',payload:'CANCEL'}]}]}})
  });
  const j = await r.json(); if(!r.ok) throw new Error(j?.error?.message || 'WhatsApp API error');
  return j?.messages?.[0]?.id || null;
}
export async function sendEmail(to: string, subject: string, html: string, from?: string) {
  const key = Deno.env.get('RESEND_API_KEY'); if (!key) throw new Error('RESEND_API_KEY is not configured');
  const sender = from || Deno.env.get('EMAIL_FROM'); if (!sender) throw new Error('EMAIL_FROM is not configured');
  const r = await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from:sender,to:[to],subject,html})});
  const j = await r.json(); if(!r.ok) throw new Error(j?.message || 'Email API error'); return j?.id || null;
}
