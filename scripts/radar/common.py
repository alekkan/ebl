"""Общее для скриптов радара: адреса из config.js, расстояние, сравнение названий, бани лиги."""
import json, math, re, urllib.request, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
_cfg = (ROOT / "prototype" / "config.js").read_text(encoding="utf-8")
API = re.search(r'supabaseUrl: *"([^"]+)"', _cfg)[1]
KEY = re.search(r'supabaseKey: *"([^"]+)"', _cfg)[1]
UA = "ebl.su-radar/1.0 (+https://ebl.su)"
# у части бань лиги вместо точки — заглушка (центр Москвы / области): по ней ничего не сопоставляем
PLACEHOLDERS = {(55.50432, 38.03539), (55.62558, 37.60639)}
AQUA = re.compile(r"(аквапарк|аква|термол|термы|терм[ао]|фитнес|бассейн|world class|ddx|spirit|wegym|спорткомплекс)", re.I)


def km(a, b):
    p = math.pi / 180
    return 6371 * 2 * math.asin(math.sqrt(math.sin((b[0] - a[0]) * p / 2) ** 2 + math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2))


def real_point(lat, lng):
    return lat is not None and lng is not None and (round(lat, 5), round(lng, 5)) not in PLACEHOLDERS


STOP = (r"\b(баня|бани|банный|банное|комплекс|сауна|сауны|спа|spa|клуб|центр|оздоровительный|городская|городские|общественная|"
        r"русская|русские|мужской|мужская|женский|женская|fitness|фитнес|nice|термолэнд|термоленд|двор|усадьба|и|на|в|№|ул|улица|пр|г)\b")


def words(name):
    """основы значимых слов названия: «Перловские бани» → {перлов}"""
    s = re.sub(r"\(.*?\)", " ", (name or "").lower().replace("ё", "е"))
    return {w[:6] for w in re.sub(STOP, " ", re.sub(r"[«»\"'.,()\-–—№]", " ", s)).split() if len(w) > 3}


def flat(name):
    return re.sub(r"[^а-яa-z0-9]", "", re.sub(STOP, " ", re.sub(r"\(.*?\)", " ", (name or "").lower().replace("ё", "е"))))


def same_name(a, b):
    fa, fb = flat(a), flat(b.split(",")[0]) if b else ""
    return bool(words(a) & words(b)) or (len(fb) >= 5 and fb in fa) or (len(fa) >= 5 and fa in fb)


def league_baths():
    """бани лиги — тот же общий запрос, что у сайта (только чтение, публичный ключ)"""
    req = urllib.request.Request(f"{API}/rest/v1/rpc/boot_public", headers={"apikey": KEY, "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["baths"]


REGION = {"Москва": "Москва", "Московская область": "Московская обл"}   # регион радара → как у Комиссии


def league_match(name, lat, lng, league, region=None):
    """(уверенно, подсказка): уверенно — то же название ближе 1,5 км; подсказка — название совпало, а точка далеко или неточная,
    или любая баня лиги ближе 300 м. Из тёзок — сначала в том же регионе и ближе (23.10: «Сандуновские бани» Москвы
    получали подсказку «Алтай, Сандуны»). Хуитнес и термы лиги с общественной не склеиваем."""
    pt = (lat, lng) if real_point(lat, lng) else None
    dist = lambda b: km(pt, (b["lat"], b["lng"])) if pt and b.get("lat") is not None else 9999
    named = []
    for b in league:
        if b.get("type") == "spa" or AQUA.search(b["name"]) or not same_name(name, b["name"]):
            continue
        if dist(b) < 1.5:
            return b, None
        named.append(b)
    reg = REGION.get(region)
    named.sort(key=lambda b: (bool(reg) and b.get("region") != reg, dist(b)))
    if named and (not reg or named[0].get("region") == reg):
        return None, named[0]
    near = min((b for b in league if b.get("type") != "spa" and dist(b) < 0.3), key=dist, default=None)
    return None, near
