import { corsHeaders, json, adminClient, sendWhatsApp, sendEmail, formatDateTime } from '../_shared.ts';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const secret = Deno.env.get('CRON_SECRET');

  if (secret && req.headers.get('x-cron-secret') !== secret) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const db = adminClient();
  const now = new Date();

  const windows = [
    {
      type: '24h',
      from: 23 * 60,
      to: 25 * 60,
      enabled: 'reminder_24h',
      template: Deno.env.get('WHATSAPP_TEMPLATE_24H') || 'appointment_reminder_24h'
    },
    {
      type: '2h',
      from: 60,
      to: 180,
      enabled: 'reminder_2h',
      template: Deno.env.get('WHATSAPP_TEMPLATE_2H') || 'appointment_reminder_2h'
    }
  ];

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const w of windows) {
    const from = new Date(now.getTime() + w.from * 60000).toISOString();
    const to = new Date(now.getTime() + w.to * 60000).toISOString();

    const { data: apps, error: queryError } = await db
      .from('appointments')
      .select('*,clinics(*)')
      .eq('status', 'confirmed')
      .gte('appointment_at', from)
      .lte('appointment_at', to);

    if (queryError) {
      return json({ error: queryError.message }, 500);
    }

    for (const a of apps || []) {
      const clinic = a.clinics;

      if (!clinic) {
        skipped++;
        continue;
      }

      if (!clinic[w.enabled]) {
        skipped++;
        continue;
      }

      const channels = [
        ['whatsapp', a.phone],
        ['email', a.email]
      ] as const;

      for (const [channel, target] of channels) {
        if (!target) {
          skipped++;
          continue;
        }

        if (channel === 'whatsapp' && !clinic.whatsapp_enabled) {
          skipped++;
          continue;
        }

        if (channel === 'email' && !clinic.email_enabled) {
          skipped++;
          continue;
        }

        const { data: existing } = await db
          .from('reminder_logs')
          .select('id')
          .eq('appointment_id', a.id)
          .eq('reminder_type', w.type)
          .eq('channel', channel)
          .maybeSingle();

        if (existing) {
          skipped++;
          continue;
        }

        try {
          let id = null;
          const dt = formatDateTime(a.appointment_at, clinic.timezone);

          if (channel === 'whatsapp') {
            id = await sendWhatsApp(
              clinic,
              a.phone,
              w.template,
              [
                a.patient_name,
                clinic.name,
                clinic.doctor_name || '',
                dt
              ]
            );
          } else {
            id = await sendEmail(
              a.email,
              `Appointment reminder — ${clinic.name}`,
              `<p>Dear ${a.patient_name},</p>
               <p>This is a reminder for your appointment at <strong>${clinic.name}</strong> on <strong>${dt}</strong>.</p>
               <p>Service: ${a.service || 'General consultation'}</p>`
            );
          }

          await db.from('reminder_logs').insert({
            appointment_id: a.id,
            reminder_type: w.type,
            channel,
            status: 'sent',
            provider_message_id: id,
            sent_at: new Date().toISOString()
          });

          sent++;
        } catch (e) {
          await db.from('reminder_logs').insert({
            appointment_id: a.id,
            reminder_type: w.type,
            channel,
            status: 'failed',
            error: e?.message || 'Send failed'
          });

          failed++;
        }
      }
    }
  }

  return json({
    ok: true,
    sent,
    failed,
    skipped
  });
});