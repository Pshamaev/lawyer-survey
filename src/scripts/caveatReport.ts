/**
 * Этап 3 конвейера курации: сводка разметки оговорок практики экспертами.
 *
 * По каждой оговорке (filter_status=passed из caveats/caveats_filtered.json):
 * голоса из caveat_reviews, консенсус и статус:
 *   approved       - 3+ голосов и 75%+ "Так и есть" (confirm)
 *   rejected       - 3+ голосов и 75%+ "Не так" (reject)
 *   needs_arbiter  - 3+ голосов без консенсуса, либо консенсус "Зависит"
 *                    (75%+ depends: региональная/судейская вилка - решает арбитр)
 *   pending        - меньше 3 голосов
 *
 * Запуск (данные никуда не пишутся, только консоль):
 *   SUPABASE_URL=https://xumxgwnvorgqefoldwma.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx src/scripts/caveatReport.ts
 */
import * as fs from "fs";
import * as path from "path";

interface Review {
  caveat_id: number;
  verdict: "confirm" | "reject" | "depends";
  comment: string | null;
  reviewer_token: string;
  reviewer_profile: string | null;
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
      `${SUPABASE_URL}/rest/v1/caveat_reviews?select=caveat_id,verdict,comment,reviewer_token,reviewer_profile,created_at&order=created_at.asc&offset=${offset}&limit=${pageSize}`,
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

type Status = "approved" | "rejected" | "needs_arbiter" | "pending";

function statusOf(votes: Review[]): { status: Status; detail: string } {
  const n = votes.length;
  if (n < CONSENSUS_MIN_VOTES) return { status: "pending", detail: `голосов ${n} < ${CONSENSUS_MIN_VOTES}` };
  const c = votes.filter((v) => v.verdict === "confirm").length;
  const r = votes.filter((v) => v.verdict === "reject").length;
  const d = votes.filter((v) => v.verdict === "depends").length;
  if (c / n >= CONSENSUS_SHARE) return { status: "approved", detail: `подтверждено ${c}/${n}` };
  if (r / n >= CONSENSUS_SHARE) return { status: "rejected", detail: `отклонено ${r}/${n}` };
  if (d / n >= CONSENSUS_SHARE) return { status: "needs_arbiter", detail: `консенсус "Зависит" ${d}/${n} - вилка, решает арбитр` };
  return { status: "needs_arbiter", detail: `разброс c=${c} r=${r} d=${d}` };
}

async function main(): Promise<void> {
  const caveatsPath = path.join(__dirname, "..", "..", "caveats", "caveats_filtered.json");
  const all: Caveat[] = JSON.parse(fs.readFileSync(caveatsPath, "utf-8"));
  const passed = all.filter((c) => c.filter_status === "passed");
  const reviews = await fetchAll();

  const byId = new Map<number, Review[]>();
  for (const r of reviews) {
    if (!byId.has(r.caveat_id)) byId.set(r.caveat_id, []);
    byId.get(r.caveat_id)!.push(r);
  }

  const buckets: Record<Status, Array<{ c: Caveat; votes: Review[]; detail: string }>> = {
    approved: [], rejected: [], needs_arbiter: [], pending: [],
  };
  for (const c of passed) {
    const votes = byId.get(c.id) ?? [];
    const { status, detail } = statusOf(votes);
    buckets[status].push({ c, votes, detail });
  }

  const uniqueReviewers = new Set(reviews.map((r) => r.reviewer_token)).size;
  console.log(`Оговорок в разметке: ${passed.length}; голосов: ${reviews.length}; экспертов: ${uniqueReviewers}`);
  console.log(
    `Статусы: approved=${buckets.approved.length} rejected=${buckets.rejected.length} ` +
      `needs_arbiter=${buckets.needs_arbiter.length} pending=${buckets.pending.length}\n`,
  );

  for (const status of ["approved", "rejected", "needs_arbiter"] as Status[]) {
    if (!buckets[status].length) continue;
    console.log(`=== ${status.toUpperCase()} (${buckets[status].length}) ===`);
    for (const { c, votes, detail } of buckets[status]) {
      console.log(`[${c.id}] (${c.class}) ${detail}`);
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
    for (const { c, votes } of votedPending) {
      console.log(`[${c.id}] голосов ${votes.length}: ${c.text.substring(0, 100)}`);
    }
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
