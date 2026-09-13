-- Run once after enabling pg_cron and pg_net in Supabase.
-- Store the project URL and cron secret in Supabase Vault for production.
select cron.schedule('clinicreminder-process-reminders','*/5 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT.supabase.co/functions/v1/process-reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','YOUR_CRON_SECRET'),
    body := '{}'::jsonb
  );
$$);
