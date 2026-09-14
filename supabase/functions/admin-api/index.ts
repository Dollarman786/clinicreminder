import { corsHeaders, json, adminClient, sendWhatsApp, sendEmail } from '../_shared.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const auth = req.headers.get('Authorization');

    if (!auth) {
      return json({ error: 'Authentication required' }, 401);
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      {
        global: {
          headers: {
            Authorization: auth,
          },
        },
      }
    );

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return json({ error: 'Invalid session' }, 401);
    }

    const body = await req.json();
    const db = adminClient();

    const { data: membership, error: membershipError } = await db
      .from('clinic_users')
      .select('clinic_id,role')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (membershipError) {
      return json({ error: 'Could not verify clinic access' }, 500);
    }

    if (!membership) {
      return json({ error: 'No clinic access' }, 403);
    }

    const { data: clinic, error: clinicError } = await db
      .from('clinics')
      .select('*')
      .eq('id', membership.clinic_id)
      .single();

    if (clinicError || !clinic) {
      return json({ error: 'Clinic not found' }, 404);
    }

    if (body.action === 'save-integration') {
      const phoneNumberId =
        typeof body.whatsapp_phone_number_id === 'string'
          ? body.whatsapp_phone_number_id.trim()
          : '';

      const businessAccountId =
        typeof body.whatsapp_business_account_id === 'string'
          ? body.whatsapp_business_account_id.trim()
          : '';

      const resendFrom =
        typeof body.resend_from === 'string'
          ? body.resend_from.trim()
          : '';

      const accessToken =
        typeof body.whatsapp_access_token === 'string'
          ? body.whatsapp_access_token.trim()
          : '';

      const { data: existing } = await db
        .from('clinic_integrations')
        .select('whatsapp_access_token')
        .eq('clinic_id', clinic.id)
        .maybeSingle();

      const record: Record<string, unknown> = {
        clinic_id: clinic.id,
        whatsapp_phone_number_id: phoneNumberId || null,
        whatsapp_business_account_id: businessAccountId || null,
        resend_from: resendFrom || null,
        updated_at: new Date().toISOString(),
      };

      if (accessToken) {
        record.whatsapp_access_token = accessToken;
      } else if (existing?.whatsapp_access_token) {
        record.whatsapp_access_token = existing.whatsapp_access_token;
      }

      const { error } = await db
        .from('clinic_integrations')
        .upsert(record, { onConflict: 'clinic_id' });

      if (error) {
        return json({ error: error.message }, 400);
      }

      return json({
        ok: true,
        token_configured:
          Boolean(accessToken) ||
          Boolean(existing?.whatsapp_access_token),
      });
    }

    if (body.action === 'get-integration') {
      const { data: integration, error } = await db
        .from('clinic_integrations')
        .select(
          'whatsapp_phone_number_id,whatsapp_business_account_id,resend_from,whatsapp_access_token'
        )
        .eq('clinic_id', clinic.id)
        .maybeSingle();

      if (error) {
        return json({ error: error.message }, 400);
      }

      return json({
        ok: true,
        integration: {
          whatsapp_phone_number_id:
            integration?.whatsapp_phone_number_id || '',
          whatsapp_business_account_id:
            integration?.whatsapp_business_account_id || '',
          resend_from:
            integration?.resend_from || '',
          token_configured:
            Boolean(integration?.whatsapp_access_token),
        },
      });
    }

    if (body.action === 'test-whatsapp') {
      if (!body.to) {
        return json({ error: 'Phone required' }, 400);
      }

      const id = await sendWhatsApp(
        clinic,
        body.to,
        Deno.env.get('WHATSAPP_TEST_TEMPLATE') || 'hello_world',
        [clinic.name]
      );

      return json({
        ok: true,
        message_id: id,
      });
    }

    if (body.action === 'test-email') {
      if (!body.to) {
        return json({ error: 'Email required' }, 400);
      }

      const id = await sendEmail(
        body.to,
        `ClinicReminder test - ${clinic.name}`,
        `<p>This is a ClinicReminder test email for <strong>${clinic.name}</strong>.</p>`
      );

      return json({
        ok: true,
        message_id: id,
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json(
      {
        error:
          e instanceof Error
            ? e.message
            : 'Server error',
      },
      500
    );
  }
});
