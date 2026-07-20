-- Миграция от 2026-07-19 к дополнениям страницы /caveats.
-- Выполнить в Supabase SQL Editor проекта garant-bot ДО деплоя обновлённой страницы
-- (страница шлёт reviewer_practice с каждым голосом; без колонки insert упадёт в 400).

-- 1. Профиль практики голосующего (чипы "Уголовные дела" / "Гражданские" / "И то и другое").
--    Существующая колонка reviewer_profile НЕ трогается: в ней свободный текст "регион/стаж".
alter table public.caveat_reviews
  add column if not exists reviewer_practice text
  check (reviewer_practice in ('criminal', 'civil', 'both'));

-- 2. Заявки в совет практиков.
create table if not exists public.council_interest (
  id bigint generated always as identity primary key,
  reviewer_token text not null,
  telegram text,
  reviewed_count integer not null default 0,
  created_at timestamptz not null default now(),
  -- Повторная отправка с того же устройства = 409, страница считает доставленным.
  constraint council_interest_reviewer_token_key unique (reviewer_token)
);

-- RLS: anon insert-only, select только service role (service role обходит RLS).
alter table public.council_interest enable row level security;

drop policy if exists council_interest_anon_insert on public.council_interest;
create policy council_interest_anon_insert
  on public.council_interest
  for insert
  to anon
  with check (true);

-- Select-политики для anon НЕ создаём: чтение заявок только через service role (caveatReport.ts).

-- Проверка после выполнения (обе строки должны отработать без ошибок):
--   select reviewer_practice from public.caveat_reviews limit 1;
--   select count(*) from public.council_interest;
