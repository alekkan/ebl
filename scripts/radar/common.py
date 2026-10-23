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


STOP = (r"\b(баня|бани|банный|банное|банька|баньки|банно|бань|комплекс|сауна|сауны|спа|spa|клуб|центр|оздоровительный|городская|городские|общественная|"
        r"отель|гостиница|hotel|парк|дом|двор|дворик|"
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


def league_match(name, lat, lng, league, region=None, where=""):
    """(уверенно, подсказка): уверенно — то же название ближе 1,5 км; подсказка — название совпало, а точка далеко или неточная,
    или любая баня лиги ближе 300 м. Из тёзок — сначала в том же регионе и ближе (23.10: «Сандуновские бани» Москвы
    получали подсказку «Алтай, Сандуны»). Хуитнес и термы лиги с общественной не склеиваем."""
    pt = (lat, lng) if real_point(lat, lng) else None
    dist = lambda b: km(pt, (b["lat"], b["lng"])) if pt and b.get("lat") is not None else 9999
    # ближе 150 м к точной точке бани лиги — это она, как бы ни называлась (23.10; так же скрывает сайт — radarNear)
    same_spot = min((b for b in league if b.get("precision") == "exact" and dist(b) < 0.15), key=dist, default=None)
    if same_spot: return same_spot, None
    named = []
    for b in league:
        if b.get("type") == "spa" or AQUA.search(b["name"]) or not same_name(name, b["name"]):
            continue
        if dist(b) < 1.5:
            return b, None
        # тёзка с точной точкой далеко — другая баня («Жар-птица» в Сходне и на Масловке); подсказываем только примерным
        if b.get("precision") != "exact" or not pt: named.append(b)
    reg = REGION.get(region) or (region and re.sub(r"\s+область$", " обл", region))   # «Тверская область» → как у Комиссии
    named.sort(key=lambda b: (bool(reg) and b.get("region") != reg, dist(b)))
    if named and (not reg or named[0].get("region") == reg):
        return None, named[0]
    # баня лиги названа по посёлку, а точка у неё примерная: «Лесной» ↔ «Быт-сервис, баня», пгт Лесной (23.10, Леха там был)
    # целыми словами, не по корню: «Красноармейск» не равен «Красноармейской улице»
    whole = lambda t: set(re.findall(r"[а-яa-z0-9-]{4,}", (t or "").lower().replace("ё", "е")))
    ww = whole(where)
    town = [b for b in league if b.get("precision") != "exact" and b.get("type") != "spa" and whole(b["name"]) and whole(b["name"]) <= ww
            and (not reg or b.get("region") in (reg, None))]
    if town:
        return None, town[0]
    # рядом — только с точной точкой: примерная стоит в центре города, и любая баня у площади к ней «рядом» (Красноармейск)
    near = min((b for b in league if b.get("type") != "spa" and b.get("precision") == "exact" and dist(b) < 0.3), key=dist, default=None)
    return None, near
