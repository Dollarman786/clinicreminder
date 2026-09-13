# ClinicReminder V1.2 — usable SaaS MVP

ClinicReminder is an embeddable appointment/reminder system for clinics. A clinic website creates appointments through the API, while Supabase stores appointments and scheduled jobs send 24-hour and 2-hour reminders through WhatsApp and email.

## Included
- Supabase Auth + tenant-aware database
- Clinic onboarding and API-key rotation
- Appointment API
- Immediate appointment confirmation email
- 24h and 2h reminder engine
- WhatsApp Cloud API template sending
- Resend email sending
- WhatsApp webhook receiver
- Clinic dashboard
- Embeddable JS SDK
- Supabase Cron schedule
- Klinik Zara integration with WhatsApp number updated to +601155275797

## Important
No credentials are embedded in this package. You must connect your own Supabase, Meta WhatsApp Business Platform and Resend accounts. Do not put Meta access tokens in website JavaScript.

For WhatsApp, Meta requires a WhatsApp Business Account/business phone setup and approved message templates for template messages. The product uses the `/messages` endpoint with template payloads.

For scheduling, Supabase Cron can invoke Edge Functions through pg_cron/pg_net.
