-- Миграция от 2026-07-20: вариант "Не сталкивался" (verdict = 'not_encountered')
-- по фидбеку живого эксперта с поля.
-- Выполнить в Supabase SQL Editor проекта garant-bot ДО раскомментирования кнопки
-- btn-skip в caveats/index.html (иначе insert упадёт в 400/23514).
--
-- DDL таблицы caveat_reviews вне репы, наличие check-констрейнта на verdict не
-- подтверждено, поэтому миграция защитная и идемпотентная:
--   1) если check на verdict есть (любое имя) - снимает его;
--   2) вешает новый check на четыре значения.
-- Если констрейнта не было, шаг 1 ничего не делает, шаг 2 просто добавляет контроль.

do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'public.caveat_reviews'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%verdict%';
  if cname is not null then
    execute format('alter table public.caveat_reviews drop constraint %I', cname);
  end if;
end $$;

alter table public.caveat_reviews
  add constraint caveat_reviews_verdict_check
  check (verdict in ('confirm', 'reject', 'depends', 'not_encountered'));

-- Проверка после выполнения (строка должна отработать без ошибок и вернуть 1 constraint):
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.caveat_reviews'::regclass and contype = 'c';
