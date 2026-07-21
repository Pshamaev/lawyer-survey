/**
 * Этап 3 конвейера курации: сводка разметки оговорок практики экспертами.
 *
 * По каждой оговорке (filter_status=passed из caveats/caveats_filtered.json):
 * голоса из caveat_reviews, консенсус и статус:
 *   approved       - 3+ содержательных голосов и 75%+ "Так и есть" (confirm)
 *   rejected       - 3+ содержательных голосов и 75%+ "Не так" (reject)
 *   needs_arbiter  - 3+ содержательных голосов без консенсуса, либо консенсус "Зависит"
 *                    (75%+ depends: региональная/судейская вилка - решает арбитр)
 *   pending        - меньше 3 содержательных голосов
 *
 * "Не сталкивался" (not_encountered) - содержательным вердиктом НЕ считается:
 * в базу консенсуса не входит, но показывается в сводке. Если not_encountered
 * больше половины ВСЕХ голосов оговорки - пометка LOW_EXPOSURE (экзотика,
 * кандидат на понижение веса в слое практики).
 *
 * Запуск (данные никуда не пишутся, только консоль):
 *   SUPABASE_URL=https://xumxgwnvorgqefoldwma.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx src/scripts/caveatReport.ts
 *
 * С флагом --emit-disputed дополнительно пишет caveats/disputed_ids.json -
 * список id со статусом pending (содержательных голосов меньше 3) или
 * needs_arbiter (нет 75% в одну сторону). Страница /caveats?focus=disputed
 * показывает эти карточки первыми (точечная рассылка резервистам).
 */
import * as fs from "fs";
import * as path from "path";

interface Review {
  caveat_id: number;
  verdict: "confirm" | "reject" | "depends" | "not_encountered";
  comment: string | null;
  reviewer_token: string;
  reviewer_profile: string | null;
  // Профиль практики с чипов страницы: criminal | civil | both | null (не выбран).
  reviewer_practice: "criminal" | "civil" | "both" | null;
  created_at: string;
}

interface CouncilInterest {
  id: number;
  reviewer_token: string;
  telegram: string | null;
  reviewed_count: number;
  created_at: string;
}

interface Caveat {
  id: number;
  text: string;
  class: string;
  filter_status: string;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в окружении.");
  process.exit(1);
}

const CONSENSUS_MIN_VOTES = 3;
const CONSENSUS_SHARE = 0.75;

async function fetchAll(): Promise<Review[]> {
  const rows: Review[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/caveat_reviews?select=caveat_id,verdict,comment,reviewer_token,reviewer_profile,reviewer_practice,created_at&order=created_at.asc&offset=${offset}&limit=${pageSize}`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as Review[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchCouncil(): Promise<CouncilInterest[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/council_interest?select=id,reviewer_token,telegram,reviewed_count,created_at&order=created_at.asc`,
    {
      headers: {
        apikey: SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    },
  );
  // Таблица могла ещё не быть создана - сводка по оговоркам важнее, не падаем.
  if (!res.ok) {
    console.error(`council_interest недоступна: HTTP ${res.status}`);
    return [];
  }
  return (await res.json()) as CouncilInterest[];
}

type Status = "approved" | "rejected" | "needs_arbiter" | "pending";

function statusOf(votes: Review[]): { status: Status; detail: string; lowExposure: boolean } {
  // not_encountered не входит в базу консенсуса, но учитывается для флага LOW_EXPOSURE.
  const ne = votes.filter((v) => v.verdict === "not_encountered").length;
  const substantive = votes.filter((v) => v.verdict !== "not_encountered");
  const lowExposure = votes.length > 0 && ne > votes.length / 2;
  const neNote = ne ? `; не сталкивались ${ne}` : "";
  const n = substantive.length;
  if (n < CONSENSUS_MIN_VOTES) {
    return { status: "pending", detail: `содержательных голосов ${n} < ${CONSENSUS_MIN_VOTES}${neNote}`, lowExposure };
  }
  const c = substantive.filter((v) => v.verdict === "confirm").length;
  const r = substantive.filter((v) => v.verdict === "reject").length;
  const d = substantive.filter((v) => v.verdict === "depends").length;
  if (c / n >= CONSENSUS_SHARE) return { status: "approved", detail: `подтверждено ${c}/${n}${neNote}`, lowExposure };
  if (r / n >= CONSENSUS_SHARE) return { status: "rejected", detail: `отклонено ${r}/${n}${neNote}`, lowExposure };
  if (d / n >= CONSENSUS_SHARE) return { status: "needs_arbiter", detail: `консенсус "Зависит" ${d}/${n} - вилка, решает арбитр${neNote}`, lowExposure };
  return { status: "needs_arbiter", detail: `разброс c=${c} r=${r} d=${d}${neNote}`, lowExposure };
}

async function main(): Promise<void> {
  const caveatsPath = path.join(__dirname, "..", "..", "caveats", "caveats_filtered.json");
  const all: Caveat[] = JSON.parse(fs.readFileSync(caveatsPath, "utf-8"));
  const passed = all.filter((c) => c.filter_status === "passed");
  const reviews = await fetchAll();
  const council = await fetchCouncil();

  // Уголовный разрез: голоса практиков уголовного профиля (criminal + both).
  const isCriminal = (r: Review) => r.reviewer_practice === "criminal" || r.reviewer_practice === "both";

  const byId = new Map<number, Review[]>();
  for (const r of reviews) {
    if (!byId.has(r.caveat_id)) byId.set(r.caveat_id, []);
    byId.get(r.caveat_id)!.push(r);
  }

  const buckets: Record<Status, Array<{ c: Caveat; votes: Review[]; detail: string; lowExposure: boolean }>> = {
    approved: [], rejected: [], needs_arbiter: [], pending: [],
  };
  for (const c of passed) {
    const votes = byId.get(c.id) ?? [];
    const { status, detail, lowExposure } = statusOf(votes);
    buckets[status].push({ c, votes, detail, lowExposure });
  }

  const uniqueReviewers = new Set(reviews.map((r) => r.reviewer_token)).size;
  const byPractice: Record<string, number> = {};
  for (const r of reviews) {
    const key = r.reviewer_practice ?? "не указан";
    byPractice[key] = (byPractice[key] ?? 0) + 1;
  }
  const neTotal = reviews.filter((r) => r.verdict === "not_encountered").length;
  const lowExposureCount = (Object.values(buckets) as Array<Array<{ lowExposure: boolean }>>)
    .flat().filter((b) => b.lowExposure).length;
  console.log(
    `Оговорок в разметке: ${passed.length}; голосов: ${reviews.length}` +
      ` (из них "не сталкивался": ${neTotal}); экспертов: ${uniqueReviewers}; LOW_EXPOSURE: ${lowExposureCount}`,
  );
  console.log(
    `Голоса по профилю: ${Object.entries(byPractice).map(([k, v]) => `${k}=${v}`).join(" ") || "нет"}`,
  );
  console.log(
    `Статусы: approved=${buckets.approved.length} rejected=${buckets.rejected.length} ` +
      `needs_arbiter=${buckets.needs_arbiter.length} pending=${buckets.pending.length}\n`,
  );

  for (const status of ["approved", "rejected", "needs_arbiter"] as Status[]) {
    if (!buckets[status].length) continue;
    console.log(`=== ${status.toUpperCase()} (${buckets[status].length}) ===`);
    for (const { c, votes, detail, lowExposure } of buckets[status]) {
      console.log(`[${c.id}] (${c.class}) ${detail}${lowExposure ? " [LOW_EXPOSURE: экзотика, кандидат на понижение веса]" : ""}`);
      const criminalVotes = votes.filter(isCriminal);
      if (criminalVotes.length) {
        const crim = statusOf(criminalVotes);
        console.log(`    уголовный разрез (${criminalVotes.length} гол.): ${crim.status} - ${crim.detail}`);
      }
      console.log(`    ${c.text.substring(0, 140)}`);
      for (const v of votes) {
        if (v.comment) console.log(`    - ${v.verdict}: "${v.comment}"${v.reviewer_profile ? ` (${v.reviewer_profile})` : ""}`);
      }
    }
    console.log("");
  }

  const votedPending = buckets.pending.filter((p) => p.votes.length > 0);
  if (votedPending.length) {
    console.log(`=== PENDING с голосами (${votedPending.length}) ===`);
    for (const { c, votes, detail, lowExposure } of votedPending) {
      console.log(`[${c.id}] голосов ${votes.length} (${detail})${lowExposure ? " [LOW_EXPOSURE]" : ""}: ${c.text.substring(0, 100)}`);
    }
    console.log("");
  }

  // Досыл контакта со страницы: unique(reviewer_token) + insert-only RLS не дают дополнить
  // пустую заявку, поэтому страница шлёт вторую строку с токеном "<token>-contact".
  // Склеиваем пары по базовому токену: контакт и created_at берём из строки с контактом,
  // reviewed_count - максимум из пары.
  const CONTACT_SUFFIX = "-contact";
  const byBaseToken = new Map<string, CouncilInterest[]>();
  for (const ci of council) {
    const base = ci.reviewer_token.endsWith(CONTACT_SUFFIX)
      ? ci.reviewer_token.slice(0, -CONTACT_SUFFIX.length)
      : ci.reviewer_token;
    if (!byBaseToken.has(base)) byBaseToken.set(base, []);
    byBaseToken.get(base)!.push(ci);
  }
  const merged = [...byBaseToken.entries()].map(([base, rows]) => {
    const withContact = rows.filter((r) => r.telegram);
    const primary = withContact.length ? withContact[withContact.length - 1] : rows[0];
    return {
      base,
      telegram: primary.telegram,
      reviewed_count: Math.max(...rows.map((r) => r.reviewed_count)),
      created_at: rows[0].created_at,
      lateContact: rows.length > 1 && withContact.length > 0,
    };
  }).sort((a, b) => a.created_at.localeCompare(b.created_at));

  console.log(`=== ЗАЯВКИ В СОВЕТ (${merged.length}) ===`);
  for (const ci of merged) {
    console.log(
      `[${ci.created_at.substring(0, 10)}] ${ci.telegram ?? "без контакта"}; размечено ${ci.reviewed_count}; token ${ci.base.substring(0, 8)}...${ci.lateContact ? " (контакт дослан позже)" : ""}`,
    );
  }

  // --emit-disputed: приоритетный список для режима focus=disputed страницы /caveats.
  if (process.argv.includes("--emit-disputed")) {
    const ids = [...buckets.pending, ...buckets.needs_arbiter]
      .map((b) => b.c.id)
      .sort((a, b) => a - b);
    const outPath = path.join(__dirname, "..", "..", "caveats", "disputed_ids.json");
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          pending: buckets.pending.length,
          needs_arbiter: buckets.needs_arbiter.length,
          ids,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    console.log(
      `\ndisputed_ids.json: ${ids.length} id (pending ${buckets.pending.length} + needs_arbiter ${buckets.needs_arbiter.length}) -> ${outPath}`,
    );
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
