/**
 * Сводка по ответам опроса юристов из Supabase.
 *
 * Запуск (нужен Node 18+, данные никуда не пишутся, только консоль):
 *   SUPABASE_URL=https://xumxgwnvorgqefoldwma.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx src/scripts/surveyReport.ts
 */

interface SurveyResponse {
  id: string;
  created_at: string;
  practice_area: string | null;
  experience: string | null;
  work_format: string | null;
  time_wasters: string[] | null;
  time_wasters_other: string | null;
  tools_used: string[] | null;
  tools_frustrations: string | null;
  ai_usage: string | null;
  ai_quit_reason: string | null;
  assistant_usefulness: string | null;
  assistant_must_have: string | null;
  hours_saved: string | null;
  hourly_rate: string | null;
  telegram_contact: string | null;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в окружении.");
  process.exit(1);
}

async function fetchAll(): Promise<SurveyResponse[]> {
  const rows: SurveyResponse[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/survey_responses?select=*&order=created_at.asc&offset=${offset}&limit=${pageSize}`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) throw new Error(`Supabase ответил ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as SurveyResponse[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function distribution(label: string, values: (string | null)[]) {
  const counts = new Map<string, number>();
  let empty = 0;
  for (const v of values) {
    if (!v) { empty++; continue; }
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  console.log(`\n${label}`);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [value, count] of sorted) console.log(`  ${count.toString().padStart(3)}  ${value}`);
  if (empty) console.log(`  ${empty.toString().padStart(3)}  (без ответа)`);
}

function multiDistribution(label: string, values: (string[] | null)[]) {
  const flat = values.flatMap((v) => v ?? []);
  distribution(label, flat.length ? flat : [null]);
}

function freeText(label: string, rows: SurveyResponse[], pick: (r: SurveyResponse) => string | null) {
  const items = rows
    .map((r) => ({ date: r.created_at.slice(0, 10), text: pick(r) }))
    .filter((x): x is { date: string; text: string } => Boolean(x.text));
  console.log(`\n${label} (${items.length})`);
  for (const { date, text } of items) console.log(`  [${date}] ${text}`);
}

async function main() {
  const rows = await fetchAll();
  console.log(`Всего ответов: ${rows.length}`);
  if (!rows.length) return;
  console.log(`Первый: ${rows[0].created_at}, последний: ${rows[rows.length - 1].created_at}`);

  console.log("\n=== РАСПРЕДЕЛЕНИЯ ===");
  distribution("Направление", rows.map((r) => r.practice_area));
  distribution("Стаж", rows.map((r) => r.experience));
  distribution("Формат работы", rows.map((r) => r.work_format));
  multiDistribution("Куда уходит время (мультивыбор)", rows.map((r) => r.time_wasters));
  multiDistribution("Инструменты (мультивыбор)", rows.map((r) => r.tools_used));
  distribution("Опыт с ИИ", rows.map((r) => r.ai_usage));
  distribution("Полезность ассистента", rows.map((r) => r.assistant_usefulness));

  console.log("\n=== СВОБОДНЫЕ ОТВЕТЫ ===");
  freeText("Куда уходит время, другое", rows, (r) => r.time_wasters_other);
  freeText("Что раздражает в инструментах", rows, (r) => r.tools_frustrations);
  freeText("Что оттолкнуло от ИИ", rows, (r) => r.ai_quit_reason);
  freeText("Что ассистент должен уметь", rows, (r) => r.assistant_must_have);
  freeText("Часов экономии в неделю", rows, (r) => r.hours_saved);
  freeText("Стоимость часа", rows, (r) => r.hourly_rate);
  freeText("Телеграм для ранней версии", rows, (r) => r.telegram_contact);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
