import { corsHeaders, json, clinicFromApiKey, sendEmail, formatDateTime } from '../_shared.ts';
Deno.serve(async req => {
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
  try {
    const clinic = await clinicFromApiKey(req); if(!clinic) return json({error:'Invalid clinic API key'},401);
    const b = await req.json();
    if(!b.patient_name || !b.appointment_at) return json({error:'patient_name and appointment_at are required'},400);
    const at = new Date(b.appointment_at); if(isNaN(at.getTime()) || at <= new Date()) return json({error:'Appointment date/time must be in the future'},400);
    const db = (await import('../_shared.ts')).adminClient();
    const {data,error}=await db.from('appointments').insert({clinic_id:clinic.id,patient_name:b.patient_name,phone:b.phone||null,email:b.email||null,appointment_at:at.toISOString(),service:b.service||null,notes:b.notes||null,status:'confirmed'}).select('id').single();
    if(error) throw error;
    if(clinic.email_enabled && b.email){
      try { await sendEmail(b.email,`Appointment confirmed — ${clinic.name}`,`<p>Dear ${b.patient_name},</p><p>Your appointment at <strong>${clinic.name}</strong>${clinic.doctor_name?` with ${clinic.doctor_name}`:''} is confirmed.</p><p><strong>${formatDateTime(at.toISOString(),clinic.timezone)}</strong></p><p>Service: ${b.service||'General consultation'}</p><p>Please contact the clinic if you need to change your appointment.</p>`); } catch(e) { console.error('confirmation email',e); }
    }
    return json({ok:true,appointment_id:data.id});
  } catch(e){ console.error(e); return json({error:e?.message||'Server error'},500); }
});
