# ClinicReminder deployment

## 1. Supabase
- Create a Supabase project.
- Run `supabase/schema.sql`.
- Enable Email Auth. For testing, you may disable email confirmation; for production, keep confirmation enabled.
- Deploy functions:
  - create-appointment
  - process-reminders
  - whatsapp-webhook
  - admin-api
- Set these secrets: `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION`, `WHATSAPP_TEMPLATE_LANGUAGE`, `CRON_SECRET`.
- Keep `SUPABASE_ANON_KEY` only in the browser dashboard; never expose the service-role key.

## 2. Dashboard
Edit `dashboard/index.html` and replace `YOUR-PROJECT.supabase.co` and `YOUR_ANON_KEY`. Host it on Vercel, Netlify, Cloudflare Pages or your own HTTPS site.

## 3. WhatsApp
Create/verify the clinic WhatsApp Business setup in Meta. Add the approved templates `appointment_reminder_24h` and `appointment_reminder_2h`. Save the phone number ID and access token in the dashboard integration screen. Configure the webhook URL as `/functions/v1/whatsapp-webhook` and the same verify token as the `META_VERIFY_TOKEN` secret.

## 4. Email
Verify your sending domain in Resend. Use a sender such as `ClinicReminder <appointments@yourdomain.com>`. You can use the global `EMAIL_FROM` or the clinic-specific `resend_from`.

## 5. Reminder scheduler
Run `process-reminders` every 5 minutes. The function accepts `x-cron-secret` when `CRON_SECRET` is set. Use Supabase Cron/pg_cron, an external scheduler, or a small server-side scheduled job. Never place the service-role key in client-side code.

## 6. Website integration
Use the generated clinic API key in the existing website's server/API integration. If you embed it in browser JavaScript, understand that the key can be extracted by visitors; the safer production pattern is to proxy appointment creation through your website backend. For a simple low-risk MVP, the embeddable key can be restricted by allowed origin at the API layer.

## 7. Security before real patient data
- Replace `*` CORS with clinic-specific allowed origins.
- Add rate limiting/WAF.
- Encrypt integration tokens at rest or move them to a managed secret store.
- Add audit logs and retention/deletion workflows.
- Add backups and monitoring.
- Add privacy notice and patient consent language.
- Minimize patient data stored.
- Do not include diagnosis, medication or other sensitive clinical information in reminders.
