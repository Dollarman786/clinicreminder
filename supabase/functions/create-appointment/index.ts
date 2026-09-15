import { corsHeaders, json, adminClient } from '../_shared.ts';

const MAX_BODY_BYTES = 16_384;

// Per IP + clinic
const RATE_WINDOW_MINUTES = 10;
const RATE_LIMIT = 10;

// Extra clinic-wide protection
const CLINIC_RATE_LIMIT = 200;

function cleanString(
  value: unknown,
  maxLength: number
): string {
  if (typeof value !== 'string') return '';

  return value
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function validEmail(email: string): boolean {
  if (!email) return true;
  if (email.length > 254) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPhone(phone: string): boolean {
  if (!phone) return true;

  // Allows international numbers such as +60123456789
  return /^\+?[0-9 ()-]{7,25}$/.test(phone);
}

function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');

  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);

  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    data
  );

  return Array.from(
    new Uint8Array(hashBuffer)
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function safeEqual(
  a: string,
  b: string
): boolean {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function consumeRateLimit(
  db: ReturnType<typeof adminClient>,
  key: string,
  limit: number
): Promise<boolean> {
  const now = new Date();

  const windowStart = new Date(
    now.getTime() -
      RATE_WINDOW_MINUTES * 60 * 1000
  );

  const { data: existing, error: readError } =
    await db
      .from('appointment_rate_limits')
      .select(
        'key,window_started_at,request_count'
      )
      .eq('key', key)
      .maybeSingle();

  if (readError) {
    console.error(
      'Rate-limit read failed:',
      readError.message
    );

    // Do not take the appointment system offline
    // solely because rate-limit storage failed.
    return true;
  }

  if (!existing) {
    const { error } = await db
      .from('appointment_rate_limits')
      .insert({
        key,
        window_started_at:
          now.toISOString(),
        request_count: 1,
        updated_at: now.toISOString(),
      });

    if (error) {
      console.error(
        'Rate-limit insert failed:',
        error.message
      );
    }

    return true;
  }

  const existingWindow =
    new Date(existing.window_started_at);

  if (existingWindow < windowStart) {
    const { error } = await db
      .from('appointment_rate_limits')
      .update({
        window_started_at:
          now.toISOString(),
        request_count: 1,
        updated_at: now.toISOString(),
      })
      .eq('key', key);

    if (error) {
      console.error(
        'Rate-limit reset failed:',
        error.message
      );
    }

    return true;
  }

  if (existing.request_count >= limit) {
    return false;
  }

  const { error } = await db
    .from('appointment_rate_limits')
    .update({
      request_count:
        existing.request_count + 1,
      updated_at: now.toISOString(),
    })
    .eq('key', key);

  if (error) {
    console.error(
      'Rate-limit update failed:',
      error.message
    );
  }

  return true;
}

Deno.serve(async (req) => {
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
    /*
     * -------------------------------------------------
     * 1. Request size protection
     * -------------------------------------------------
     */

    const contentLength =
      Number(
        req.headers.get('content-length') || 0
      );

    if (
      contentLength &&
      contentLength > MAX_BODY_BYTES
    ) {
      return json(
        { error: 'Request too large' },
        413
      );
    }

    /*
     * -------------------------------------------------
     * 2. Clinic API key
     * -------------------------------------------------
     */

    const apiKey =
      req.headers
        .get('x-clinic-api-key')
        ?.trim() || '';

    if (
      !apiKey ||
      apiKey.length < 16 ||
      apiKey.length > 500
    ) {
      return json(
        { error: 'Invalid clinic API key' },
        401
      );
    }

    const db = adminClient();

    const apiKeyHash =
      await sha256(apiKey);

    const { data: clinic, error: clinicError } =
      await db
        .from('clinics')
        .select(
          'id,name,api_key_hash,website_domain'
        )
        .eq('api_key_hash', apiKeyHash)
        .maybeSingle();

    if (
      clinicError ||
      !clinic
    ) {
      return json(
        { error: 'Invalid clinic API key' },
        401
      );
    }

    /*
     * -------------------------------------------------
     * 3. Rate limiting
     * -------------------------------------------------
     */

    const clientIp =
      getClientIp(req);

    // Do not store raw IP addresses.
    const ipHash =
      await sha256(clientIp);

    const ipClinicKey =
      `clinic:${clinic.id}:ip:${ipHash}`;

    const clinicKey =
      `clinic:${clinic.id}:global`;

    const ipAllowed =
      await consumeRateLimit(
        db,
        ipClinicKey,
        RATE_LIMIT
      );

    if (!ipAllowed) {
      return json(
        {
          error:
            'Too many appointment requests. Please try again later.',
        },
        429
      );
    }

    const clinicAllowed =
      await consumeRateLimit(
        db,
        clinicKey,
        CLINIC_RATE_LIMIT
      );

    if (!clinicAllowed) {
      return json(
        {
          error:
            'Appointment service is temporarily busy. Please try again later.',
        },
        429
      );
    }

    /*
     * -------------------------------------------------
     * 4. Parse JSON
     * -------------------------------------------------
     */

    let body: Record<
      string,
      unknown
    >;

    try {
      body = await req.json();
    } catch {
      return json(
        { error: 'Invalid JSON request' },
        400
      );
    }

    /*
     * -------------------------------------------------
     * 5. Clean input
     * -------------------------------------------------
     */

    const patientName =
      cleanString(
        body.patient_name,
        120
      );

    const phone =
      cleanString(
        body.phone,
        30
      );

    const email =
      cleanString(
        body.email,
        254
      ).toLowerCase();

    const service =
      cleanString(
        body.service,
        150
      );

    const notes =
      cleanString(
        body.notes,
        1000
      );

    const appointmentAtRaw =
      cleanString(
        body.appointment_at,
        100
      );

    /*
     * -------------------------------------------------
     * 6. Validation
     * -------------------------------------------------
     */

    if (
      patientName.length < 2
    ) {
      return json(
        {
          error:
            'Patient name is required',
        },
        400
      );
    }

    if (
      !phone &&
      !email
    ) {
      return json(
        {
          error:
            'Phone number or email is required',
        },
        400
      );
    }

    if (!validPhone(phone)) {
      return json(
        {
          error:
            'Invalid phone number',
        },
        400
      );
    }

    if (!validEmail(email)) {
      return json(
        {
          error:
            'Invalid email address',
        },
        400
      );
    }

    if (!appointmentAtRaw) {
      return json(
        {
          error:
            'Appointment date and time are required',
        },
        400
      );
    }

    const appointmentDate =
      new Date(appointmentAtRaw);

    if (
      Number.isNaN(
        appointmentDate.getTime()
      )
    ) {
      return json(
        {
          error:
            'Invalid appointment date or time',
        },
        400
      );
    }

    const now = new Date();

    const minimumTime =
      new Date(
        now.getTime() +
          5 * 60 * 1000
      );

    const maximumTime =
      new Date(
        now.getTime() +
          366 *
            24 *
            60 *
            60 *
            1000
      );

    if (
      appointmentDate <
      minimumTime
    ) {
      return json(
        {
          error:
            'Appointment must be in the future',
        },
        400
      );
    }

    if (
      appointmentDate >
      maximumTime
    ) {
      return json(
        {
          error:
            'Appointment is too far in the future',
        },
        400
      );
    }

    /*
     * -------------------------------------------------
     * 7. Duplicate submission protection
     * -------------------------------------------------
     *
     * If the same contact submits the exact same
     * appointment time within 5 minutes, return the
     * existing appointment instead of creating another.
     */

    const duplicateCutoff =
      new Date(
        now.getTime() -
          5 * 60 * 1000
      ).toISOString();

    let duplicateQuery =
      db
        .from('appointments')
        .select(
          'id,appointment_at,status,created_at'
        )
        .eq(
          'clinic_id',
          clinic.id
        )
        .eq(
          'appointment_at',
          appointmentDate.toISOString()
        )
        .gte(
          'created_at',
          duplicateCutoff
        )
        .order(
          'created_at',
          { ascending: false }
        )
        .limit(1);

    if (phone) {
      duplicateQuery =
        duplicateQuery.eq(
          'phone',
          phone
        );
    } else {
      duplicateQuery =
        duplicateQuery.eq(
          'email',
          email
        );
    }

    const {
      data: duplicateAppointments,
      error: duplicateError,
    } =
      await duplicateQuery;

    if (duplicateError) {
      console.error(
        'Duplicate check failed:',
        duplicateError.message
      );
    }

    const duplicate =
      duplicateAppointments?.[0];

    if (duplicate) {
      return json(
        {
          ok: true,
          duplicate: true,
          appointment: {
            id: duplicate.id,
            appointment_at:
              duplicate.appointment_at,
            status:
              duplicate.status,
          },
        },
        200
      );
    }

    /*
     * -------------------------------------------------
     * 8. Create appointment
     * -------------------------------------------------
     */

    const {
      data: appointment,
      error: insertError,
    } =
      await db
        .from('appointments')
        .insert({
          clinic_id:
            clinic.id,

          patient_name:
            patientName,

          phone:
            phone || null,

          email:
            email || null,

          appointment_at:
            appointmentDate.toISOString(),

          service:
            service || null,

          notes:
            notes || null,

          status:
            'confirmed',
        })
        .select(
          'id,appointment_at,status'
        )
        .single();

    if (
      insertError ||
      !appointment
    ) {
      console.error(
        'Appointment insert failed:',
        insertError?.message
      );

      return json(
        {
          error:
            'Appointment could not be created',
        },
        500
      );
    }

    /*
     * -------------------------------------------------
     * 9. Return only safe data
     * -------------------------------------------------
     */

    return json(
      {
        ok: true,
        duplicate: false,
        appointment: {
          id:
            appointment.id,

          appointment_at:
            appointment.appointment_at,

          status:
            appointment.status,
        },
      },
      201
    );
  } catch (error) {
    console.error(
      'create-appointment error:',
      error
    );

    return json(
      {
        error:
          'Appointment could not be created',
      },
      500
    );
  }
});