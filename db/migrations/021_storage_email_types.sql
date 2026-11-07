-- 021 — let the private file bucket hold saved emails (.eml / .msg), used by the Emails panel (Part G1)
-- and pre-alert emails (Part E). Same 10 MB limit; documents and photos as before. Safe to run twice.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    update storage.buckets set allowed_mime_types = array[
      'application/pdf', 'image/jpeg', 'image/png',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'message/rfc822', 'application/vnd.ms-outlook']
    where id = 'tms-documents';
  end if;
end $$;

insert into schema_migrations (name) values ('021_storage_email_types.sql') on conflict do nothing;
