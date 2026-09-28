// Ночной бэкап в Яндекс (бакет ebl-backups): все таблицы схемы public — сжатым JSON, и аватарки из Storage.
// Схема базы лежит в миграциях (git), поэтому для восстановления хватает данных: scripts/restore-backup.sh <дата>.
// Зовёт pg_cron в 03:30 МСК (ebl-nightly-backup). Одна копия в сутки: манифест за сегодня уже есть — ничего не делаем,
// так что дёргать адрес снаружи бесполезно. Копии старше 30 дней бакет удаляет сам (правило жизненного цикла).
// Ключ к бакету (BACKUP_S3_KEY_ID, BACKUP_S3_SECRET) кладёт владелец скриптом scripts/setup-backup-key.sh — он пишет только сюда.
//   ?dry=1 — ничего не выгружать: какие таблицы и сколько строк (для тестов)
import postgres from "npm:postgres@3.4.4";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const DB = Deno.env.get("SUPABASE_DB_URL") ?? "";
const BASE = Deno.env.get("SUPABASE_URL") ?? "";
const KEY_ID = Deno.env.get("BACKUP_S3_KEY_ID") ?? "", SECRET = Deno.env.get("BACKUP_S3_SECRET") ?? "";
const BUCKET = Deno.env.get("BACKUP_BUCKET") ?? "ebl-backups";
const S3 = "https://storage.yandexcloud.net";
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const gzip = async (text: string) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
const mskDay = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

// все таблицы public — одним запросом на таблицу; порядок строк — по первичному ключу, чтобы копии было удобно сравнивать
async function dump() {
  const sql = postgres(DB, { prepare: false, max: 1 });
  try {
    const tables = (await sql`select tablename from pg_tables where schemaname = 'public' order by tablename`).map((r) => r.tablename as string);
    const data: Record<string, string> = {}, counts: Record<string, number> = {};
    for (const t of tables) {
      const [row] = await sql.unsafe(`select coalesce(json_agg(x), '[]'::json)::text as data, count(*)::int as n from (select * from public."${t}" order by 1) x`);
      data[t] = row.data; counts[t] = row.n;
    }
    const [m] = await sql`select coalesce(json_agg(version order by version), '[]'::json)::text as v from supabase_migrations.schema_migrations`;
    const avatars = (await sql`select name from storage.objects where bucket_id = 'avatars' order by name`).map((r) => r.name as string);
    return { tables, data, counts, migrations: JSON.parse(m.v), avatars };
  } finally {
    await sql.end();
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    if (url.searchParams.has("dry")) {
      const d = await dump();
      return json({ tables: d.counts, migrations: d.migrations.length, avatars: d.avatars.length });
    }
    if (!KEY_ID || !SECRET) return json({ error: "нет ключа к бакету — scripts/setup-backup-key.sh" }, 500);
    const aws = new AwsClient({ accessKeyId: KEY_ID, secretAccessKey: SECRET, service: "s3", region: "ru-central1" });
    const put = async (key: string, body: BodyInit, type: string) => {
      const r = await aws.fetch(`${S3}/${BUCKET}/${key}`, { method: "PUT", body, headers: { "Content-Type": type } });
      if (!r.ok) throw new Error(`${key}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    };
    const day = mskDay();
    // одна копия в сутки: манифест пишется последним, есть манифест — копия за сегодня уже целиком лежит
    if ((await aws.fetch(`${S3}/${BUCKET}/${day}/manifest.json`, { method: "HEAD" })).ok) return json({ skipped: "копия за сегодня уже есть", day });
    const d = await dump();
    let bytes = 0;
    for (const t of d.tables) {
      const gz = await gzip(d.data[t]);
      bytes += gz.length;
      await put(`${day}/public.${t}.json.gz`, gz, "application/gzip");
    }
    // аватарки — отдельной папкой (перезаписываются каждую ночь): их немного, а без них после восстановления будут одни буквы
    let pics = 0;
    for (const name of d.avatars) {
      const r = await fetch(`${BASE}/storage/v1/object/public/avatars/${encodeURI(name)}`);
      if (!r.ok) continue;
      await put(`avatars/${name}`, new Uint8Array(await r.arrayBuffer()), r.headers.get("content-type") ?? "application/octet-stream");
      pics++;
    }
    const manifest = { day, at: new Date().toISOString(), tables: d.counts, migrations: d.migrations, avatars: pics, bytes };
    await put(`${day}/manifest.json`, JSON.stringify(manifest, null, 2), "application/json");
    return json(manifest);
  } catch (e) {
    console.error("backup", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
