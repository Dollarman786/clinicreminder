import { corsHeaders, json, adminClient } from '../_shared.ts';

function normalizePhone(value: string): string {
  return String(value || '').replace(/[^\d]/g, '');
}

function metaTime(value?: string): string {
  const n = Number(value);
  return Number.isFinite(n)
    ? new Date(n * 1000).toISOString()
    : new Date().toISOString();
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  const secret = Deno.env.get('META_APP_SECRET');

  if (!secret) {
    console.error('META_APP_SECRET is not configured');
    return false;
  }

  if (!signatureHeader?.startsWith('sha256=')) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody)
  );

  const expected = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const received = signatureHeader.slice(7);

  return safeEqual(received, expected);
}

function getReplyText(message: any): string {
  if (message?.type === 'text') {
    return message?.text?.body || '';
  }

  if (message?.type === 'button') {
    return message?.button?.text ||
      message?.button?.payload ||
      '';
  }

  if (
    message?.type === 'interactive' &&
    message?.interactive?.button_reply
  ) {
    return message.interactive.button_reply.title ||
      message.interactive.button_reply.id ||
      '';
  }

  if (
    message?.type === 'interactive' &&
    message?.interactive?.list_reply
  ) {
    return message.interactive.list_reply.title ||
      message.interactive.list_reply.id ||
      '';
  }

  return '';
}

function classifyReply(value: string):
  'confirm' | 'cancel' | 'reschedule' | 'unknown' {

  const reply = value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

  if (
    ['YES', 'Y', 'CONFIRM', 'CONFIRMED', 'OK', '1']
      .includes(reply)
  ) {
    return 'confirm';
  }

  if (
    ['NO', 'N', 'CANCEL', 'CANCEL APPOINTMENT', '2']
      .includes(reply)
  ) {
    return 'cancel';
  }

  if (
    ['RESCHEDULE', 'CHANGE', 'CHANGE APPOINTMENT', 'NEW TIME', '3']
      .includes(reply)
  ) {
    return 'reschedule';
  }

  return 'unknown';
}

async function processDeliveryStatus(
  db: any,
  status: any
) {
  const messageId = status?.id;
  const providerStatus = status?.status;

  if (!messageId || !providerStatus) return;

  const time = metaTime(status?.timestamp);

  const update: Record<string, unknown> = {
    provider_status: providerStatus
  };

  if (providerStatus === 'sent') {
    update.sent_at = time;
  }

  if (providerStatus === 'delivered') {
    update.delivered_at = time;
  }

  if (providerStatus === 'read') {
    update.read_at = time;
  }

  if (providerStatus === 'failed') {
    update.status = 'failed';
    update.failed_at = time;

    const errors = Array.isArray(status?.errors)
      ? status.errors
      : [];

    update.provider_error =
      errors
        .map((e: any) =>
          e?.title ||
          e?.message ||
          String(e?.code || '')
        )
        .filter(Boolean)
        .join('; ') ||
      'WhatsApp delivery failed';
  }

  const { error } = await db
    .from('reminder_logs')
    .update(update)
    .eq('provider_message_id', messageId);

  if (error) {
    console.error(
      'Delivery status update failed:',
      error.message
    );
  }
}

async function findAppointment(
  db: any,
  clinicId: string,
  patientPhone: string
) {
  const target = normalizePhone(patientPhone);

  const now = new Date();

  const earliest = new Date(
    now.getTime() - 12 * 60 * 60 * 1000
  );

  const latest = new Date(
    now.getTime() + 30 * 24 * 60 * 60 * 1000
  );

  const { data, error } = await db
    .from('appointments')
    .select(
      'id,clinic_id,patient_name,phone,appointment_at,status'
    )
    .eq('clinic_id', clinicId)
    .in('status', ['pending', 'confirmed'])
    .gte('appointment_at', earliest.toISOString())
    .lte('appointment_at', latest.toISOString())
    .order('appointment_at', { ascending: true })
    .limit(100);

  if (error) {
    console.error(
      'Appointment lookup failed:',
      error.message
    );
    return null;
  }

  return (data || []).find(
    (appointment: any) =>
      normalizePhone(appointment.phone || '') === target
  ) || null;
}

async function processPatientMessage(
  db: any,
  phoneNumberId: string,
  message: any
) {
  const patientPhone = message?.from || '';
  const replyText = getReplyText(message);

  if (!patientPhone || !replyText) return;

  const { data: integration, error: integrationError } =
    await db
      .from('clinic_integrations')
      .select('clinic_id')
      .eq('whatsapp_phone_number_id', phoneNumberId)
      .maybeSingle();

  if (integrationError || !integration) {
    console.error(
      'Incoming WhatsApp number is not linked to a clinic'
    );
    return;
  }

  const appointment = await findAppointment(
    db,
    integration.clinic_id,
    patientPhone
  );

  if (!appointment) {
    console.log(
      'No matching appointment for patient reply'
    );
    return;
  }

  const response = classifyReply(replyText);
  const respondedAt = metaTime(message?.timestamp);

  if (response === 'confirm') {
    const { error } = await db
      .from('appointments')
      .update({
        status: 'confirmed',
        patient_response: 'confirmed',
        patient_responded_at: respondedAt,
        cancelled_at: null,
        reschedule_requested_at: null
      })
      .eq('id', appointment.id);

    if (error) console.error(error.message);
    return;
  }

  if (response === 'cancel') {
    const { error } = await db
      .from('appointments')
      .update({
        status: 'cancelled',
        patient_response: 'cancelled',
        patient_responded_at: respondedAt,
        cancelled_at: respondedAt,
        reschedule_requested_at: null
      })
      .eq('id', appointment.id);

    if (error) console.error(error.message);
    return;
  }

  if (response === 'reschedule') {
    const { error } = await db
      .from('appointments')
      .update({
        status: 'reschedule_requested',
        patient_response: 'reschedule_requested',
        patient_responded_at: respondedAt,
        reschedule_requested_at: respondedAt,
        cancelled_at: null
      })
      .eq('id', appointment.id);

    if (error) console.error(error.message);
    return;
  }

  const { error } = await db
    .from('appointments')
    .update({
      patient_response: replyText.slice(0, 250),
      patient_responded_at: respondedAt
    })
    .eq('id', appointment.id);

  if (error) console.error(error.message);
}

Deno.serve(async req => {
  if (req.method === 'GET') {
    const url = new URL(req.url);

    const mode =
      url.searchParams.get('hub.mode');

    const token =
      url.searchParams.get('hub.verify_token');

    const challenge =
      url.searchParams.get('hub.challenge');

    const expected =
      Deno.env.get('META_VERIFY_TOKEN');

    if (
      mode === 'subscribe' &&
      expected &&
      token === expected
    ) {
      return new Response(
        challenge || '',
        { status: 200 }
      );
    }

    return new Response(
      'Forbidden',
      { status: 403 }
    );
  }

  if (req.method === 'OPTIONS') {
    return new Response(
      'ok',
      { headers: corsHeaders }
    );
  }

  if (req.method !== 'POST') {
    return json(
      { error: 'Method not allowed' },
      405
    );
  }

  try {
    const rawBody = await req.text();

    const validSignature =
      await verifyMetaSignature(
        rawBody,
        req.headers.get('x-hub-signature-256')
      );

    if (!validSignature) {
      console.error(
        'Rejected invalid Meta webhook signature'
      );

      return json(
        { error: 'Invalid signature' },
        401
      );
    }

    let payload: any;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(
        { error: 'Invalid JSON' },
        400
      );
    }

    const db = adminClient();

    const { error: logError } =
      await db
        .from('webhook_events')
        .insert({ payload });

    if (logError) {
      console.error(
        'Webhook event logging failed:',
        logError.message
      );
    }

    const entries =
      Array.isArray(payload?.entry)
        ? payload.entry
        : [];

    for (const entry of entries) {
      const changes =
        Array.isArray(entry?.changes)
          ? entry.changes
          : [];

      for (const change of changes) {
        const value = change?.value;

        if (!value) continue;

        const statuses =
          Array.isArray(value?.statuses)
            ? value.statuses
            : [];

        for (const status of statuses) {
          await processDeliveryStatus(
            db,
            status
          );
        }

        const messages =
          Array.isArray(value?.messages)
            ? value.messages
            : [];

        const phoneNumberId =
          String(
            value?.metadata?.phone_number_id || ''
          );

        if (phoneNumberId) {
          for (const message of messages) {
            await processPatientMessage(
              db,
              phoneNumberId,
              message
            );
          }
        }
      }
    }

    return json({
      received: true
    });

  } catch (error) {
    console.error(
      'WhatsApp webhook error:',
      error
    );

    return json(
      {
        error:
          'Webhook processing failed'
      },
      500
    );
  }
});
