"""Копии аватарок рядом с сайтом (04.11): <out>/ava/<хэш адреса>.jpg и <out>/data/ava.json — «адрес фото → копия».

Через шлюз фото идут из Supabase за Cloudflare: первая загрузка — до 8 с, и отдаются с «не кэшировать», так что в таблице
секунды висели буквы вместо лиц. Хэш — от полного адреса с ?v=: сменил фото — новый адрес, новая копия, старая не подхватится.
Зовёт scripts/deploy.sh; упало — сайт выкладывается без копий, фото пойдут через шлюз, как раньше.
Запуск: python3 scripts/mirror_avatars.py <папка сборки>
"""
import csv, hashlib, io, json, pathlib, subprocess, sys, urllib.request

out = pathlib.Path(sys.argv[1])
res = subprocess.run(["supabase", "db", "query", "--linked", "-o", "csv",
                      "select photo_url from players where photo_url is not null order by nick"],
                     capture_output=True, text=True, check=True)
rows = [r for r in csv.reader(io.StringIO(res.stdout)) if r and r[0].startswith("https://")]
(out / "ava").mkdir(exist_ok=True)
copies, failed = {}, 0
for (url,) in rows:
    name = f"ava/{hashlib.sha256(url.encode()).hexdigest()[:16]}.jpg"
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                body = r.read()
            if body[:2] == b"\xff\xd8":   # JPEG, а не страница ошибки
                (out / name).write_bytes(body); copies[url] = name
            break
        except Exception:
            continue
    else:
        failed += 1
(out / "data" / "ava.json").write_text(json.dumps(copies, ensure_ascii=False))
print(f"Аватарки: скопировано {len(copies)} из {len(rows)}" + (f", не скачались {failed} — пойдут через шлюз" if failed else ""))
