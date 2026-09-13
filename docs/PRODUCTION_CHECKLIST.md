# ClinicReminder V1.2 production checklist

1. Create Supabase project and run `supabase/schema.sql`.
2. Deploy all five functions under `supabase/functions/`.
3. Set secrets: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, EMAIL_FROM, META_VERIFY_TOKEN, META_GRAPH_VERSION, WHATSAPP_TEMPLATE_LANGUAGE, WHATSAPP_TEMPLATE_24H, WHATSAPP_TEMPLATE_2H, WHATSAPP_TEST_TEMPLATE, CRON_SECRET, and ALLOWED_ORIGIN.
4. Enable pg_cron and pg_net and run `docs/cron.sql`.
5. In Meta WhatsApp Business Platform, configure the business phone and approved utility templates. Cloud API template messages are sent through the phone-number `/messages` endpoint and require an approved template. See Meta's documentation. 
6. In Resend, verify the sending domain and set EMAIL_FROM.
7. Host `dashboard/index.html` on HTTPS and insert the Supabase URL + anon key.
8. Create a ClinicReminder account and Klinik Zara clinic.
9. Copy the generated API key into the Klinik Zara integration HTML.
10. Test one appointment with a test patient number/email.
11. Verify confirmation email, 24h reminder, 2h reminder, and reminder logs.
12. Only then point the live Klinik Zara site at the integration.

Important: this is appointment/reminder infrastructure, not a clinical-record system. Minimize stored patient data and do not put diagnoses, medication details, or other sensitive clinical information into reminder messages.
