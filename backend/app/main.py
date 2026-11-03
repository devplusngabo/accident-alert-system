import hashlib, hmac, math, os, secrets, sqlite3, statistics, time
from collections import Counter, defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional
from zoneinfo import ZoneInfo

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

# ---- Config (environment variables) ----
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT = os.getenv("TELEGRAM_CHAT_ID")
DB_PATH = os.getenv("DB_PATH", "./crashguard.db")
TZ = ZoneInfo(os.getenv("TIMEZONE_DISPLAY", "Africa/Kigali"))
RATE = int(os.getenv("ALERT_RATE_LIMIT_PER_MIN", "10"))
LOGIN_RATE = int(os.getenv("LOGIN_ATTEMPTS_PER_MIN", "5"))
SESSION_HOURS = float(os.getenv("SESSION_HOURS", "12"))
DEMO_PIN = os.getenv("DEMO_STATION_PIN", "")
STATIC = Path(__file__).parent / "static"
SEV = {0: "none", 1: "minor", 2: "serious", 3: "critical"}

# Incident workflow. Order matters: an assigned station may only move an incident forward.
ACTIVE = ["new", "acknowledged", "en_route", "on_scene"]
CLOSED = ["resolved", "false_alarm"]
STATUSES = ACTIVE + CLOSED


# ---- Database ----
@contextmanager
def db():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        with c:  # commits on success, rolls back on error
            yield c
    finally:
        c.close()


def q(sql, args=()):
    with db() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_utc TEXT,
         vehicle_label TEXT, event_class INTEGER, severity INTEGER, peak_g REAL, confidence REAL, flags INTEGER,
         device_ms INTEGER, seq INTEGER, lat REAL, lng REAL, accuracy_m REAL, fix_age_s REAL,
         client_time_iso TEXT, countdown_s INTEGER, telegram_status TEXT, status TEXT);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_utc TEXT,
         type TEXT, vehicle_label TEXT, event_class INTEGER, severity INTEGER, peak_g REAL, flags INTEGER,
         client_time_iso TEXT);
        CREATE TABLE IF NOT EXISTS stations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
         area TEXT, lat REAL, lng REAL, pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, created_at_utc TEXT);
        CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, station_id INTEGER NOT NULL,
         expires_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS alert_updates(id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id INTEGER NOT NULL,
         station_id INTEGER, action TEXT NOT NULL, status TEXT, note TEXT, created_at_utc TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at_utc);
        CREATE INDEX IF NOT EXISTS idx_updates_alert ON alert_updates(alert_id);
        """)
        # Migrate alerts tables created before the station workflow existed
        have = {r["name"] for r in c.execute("PRAGMA table_info(alerts)")}
        for col, typ in [("assigned_station_id", "INTEGER"), ("acknowledged_at_utc", "TEXT"),
                         ("closed_at_utc", "TEXT"), ("updated_at_utc", "TEXT")]:
            if col not in have:
                c.execute(f"ALTER TABLE alerts ADD COLUMN {col} {typ}")
        c.execute("UPDATE alerts SET status='new' WHERE status IS NULL OR status='received'")
        if DEMO_PIN and not c.execute("SELECT 1 FROM stations LIMIT 1").fetchone():
            for name, area, lat, lng in [("Kacyiru Station", "Gasabo", -1.9441, 30.0880),
                                         ("Nyamirambo Station", "Nyarugenge", -1.9787, 30.0435),
                                         ("Kicukiro Station", "Kicukiro", -1.9706, 30.1044)]:
                add_station(c, name, area, lat, lng, DEMO_PIN)
            print("[stations] Seeded 3 demo stations with DEMO_STATION_PIN. Change the PINs before real use.")


# ---- PINs and sessions ----
def hash_pin(pin: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), 200_000).hex()


def add_station(c, name, area, lat, lng, pin):
    if not (4 <= len(pin) <= 12 and pin.isdigit()):
        raise ValueError("PIN must be 4 to 12 digits")
    salt = secrets.token_hex(16)
    cur = c.execute("INSERT INTO stations(name,area,lat,lng,pin_salt,pin_hash,created_at_utc) VALUES(?,?,?,?,?,?,?)",
                    (name, area, lat, lng, salt, hash_pin(pin, salt), iso(utcnow())))
    return cur.lastrowid


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()  # store only the hash: a leaked DB holds no live tokens


def public_station(r):
    return {k: r[k] for k in ("id", "name", "area", "lat", "lng")}


def current_station(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sign in required")
    with db() as c:
        row = c.execute("""SELECT s.* FROM sessions x JOIN stations s ON s.id = x.station_id
                           WHERE x.token_hash=? AND x.expires_at>?""",
                        (token_hash(authorization[7:]), time.time())).fetchone()
    if not row:
        raise HTTPException(401, "Session expired, sign in again")
    return public_station(row)


# ---- Request models ----
class Event(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    cls: int = Field(alias="class", ge=0, le=3)
    severity: int = Field(ge=0, le=3)
    peak_g: float = Field(ge=0)
    confidence: float = Field(ge=0, le=1)
    flags: int = Field(ge=0, le=255)
    device_ms: int = Field(ge=0)
    seq: int = Field(ge=0)


class Location(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy_m: Optional[float] = None
    fix_age_s: Optional[float] = None


class AlertIn(BaseModel):
    vehicle_label: str = Field(min_length=1, max_length=40)
    event: Event
    location: Optional[Location] = None
    client_time_iso: str
    countdown_s: int = Field(ge=0, le=120)


class EventLogIn(BaseModel):
    type: Literal["cancelled", "ignored_event"]
    vehicle_label: str = Field(min_length=1, max_length=40)
    event: Event
    client_time_iso: str


class LoginIn(BaseModel):
    station_id: int
    pin: str = Field(min_length=1, max_length=12)


class UpdateIn(BaseModel):
    action: Literal["status", "assist", "note"]
    status: Optional[Literal["acknowledged", "en_route", "on_scene", "resolved", "false_alarm"]] = None
    note: Optional[str] = Field(None, max_length=500)


# ---- Rate limit (per IP, in memory) ----
hits = defaultdict(deque)


def limited(key, limit):
    now, d = time.time(), hits[key]
    while d and now - d[0] > 60:
        d.popleft()
    if len(d) >= limit:
        return True
    d.append(now)
    return False


def client_ip(request: Request):
    return request.client.host if request.client else "?"


# ---- Telegram ----
async def telegram(a: AlertIn, when: str) -> str:
    if not (TOKEN and CHAT):
        print("[alert] Telegram disabled, alert stored only:", a.vehicle_label, a.event.peak_g, "g")
        return "disabled"
    ev, loc = a.event, a.location
    if loc:
        acc = f" (accuracy {round(loc.accuracy_m)} m)" if loc.accuracy_m is not None else ""
        where = f"https://www.google.com/maps?q={loc.lat},{loc.lng}{acc}"
    else:
        where = "unavailable"
    text = (f"AccidentAlert AI\n{'TEST ' if ev.flags & 2 else ''}CRASH ALERT (severity {ev.severity}: {SEV[ev.severity]})\n"
            f"Vehicle: {a.vehicle_label}\nPeak impact: {ev.peak_g:.1f} g, confidence {round(ev.confidence * 100)}%\n"
            f"Time: {when}\nLocation: {where}")
    base = f"https://api.telegram.org/bot{TOKEN}"
    try:
        async with httpx.AsyncClient(timeout=5) as h:
            (await h.post(f"{base}/sendMessage", json={"chat_id": CHAT, "text": text})).raise_for_status()
            if loc:
                await h.post(f"{base}/sendLocation", json={"chat_id": CHAT, "latitude": loc.lat, "longitude": loc.lng})
        return "sent"
    except Exception as e:
        print("[alert] Telegram failed:", type(e).__name__)  # never print the URL: it holds the token
        return "failed"


# ---- App ----
init_db()
app = FastAPI(title="AccidentAlert AI System")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/")
def client_page():
    return FileResponse(STATIC / "index.html")


@app.get("/dispatch")
def dispatch_page():
    return FileResponse(STATIC / "dispatch.html")


# -- Device side (phone page). Unauthenticated, rate limited. --
@app.post("/api/alerts", status_code=201)
async def post_alert(a: AlertIn, request: Request):
    if limited(("alert", client_ip(request)), RATE):
        raise HTTPException(429, "Too many alerts")
    now = utcnow()
    ev, loc = a.event, a.location
    with db() as c:
        id_ = c.execute("""INSERT INTO alerts(created_at_utc,vehicle_label,event_class,severity,peak_g,confidence,flags,
            device_ms,seq,lat,lng,accuracy_m,fix_age_s,client_time_iso,countdown_s,telegram_status,status,updated_at_utc)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (iso(now), a.vehicle_label, ev.cls, ev.severity, ev.peak_g, ev.confidence, ev.flags, ev.device_ms, ev.seq,
             loc.lat if loc else None, loc.lng if loc else None, loc.accuracy_m if loc else None,
             loc.fix_age_s if loc else None, a.client_time_iso, a.countdown_s, "pending", "new", iso(now))).lastrowid
    when = f"{now.astimezone(TZ).strftime('%d %b %Y, %H:%M')} ({TZ.key.split('/')[-1]})"
    status = await telegram(a, when)
    with db() as c:
        c.execute("UPDATE alerts SET telegram_status=? WHERE id=?", (status, id_))
    return {"id": id_, "status": "received", "telegram_status": status}


@app.post("/api/events", status_code=201)
def post_event(e: EventLogIn, request: Request):
    if limited(("event", client_ip(request)), RATE * 3):
        raise HTTPException(429, "Too many events")
    ev = e.event
    with db() as c:
        c.execute("""INSERT INTO events(created_at_utc,type,vehicle_label,event_class,severity,peak_g,flags,client_time_iso)
            VALUES(?,?,?,?,?,?,?,?)""",
            (iso(utcnow()), e.type, e.vehicle_label, ev.cls, ev.severity, ev.peak_g, ev.flags, e.client_time_iso))
    return {"status": "stored"}


# -- Stations and sign-in --
@app.get("/api/stations")
def list_stations():
    return q("SELECT id,name,area,lat,lng FROM stations ORDER BY name")


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request):
    if limited(("login", client_ip(request)), LOGIN_RATE):
        raise HTTPException(429, "Too many attempts, wait a minute")
    with db() as c:
        s = c.execute("SELECT * FROM stations WHERE id=?", (body.station_id,)).fetchone()
        if not s or not hmac.compare_digest(hash_pin(body.pin, s["pin_salt"]), s["pin_hash"]):
            raise HTTPException(401, "Wrong station or PIN")
        token = secrets.token_urlsafe(32)
        c.execute("DELETE FROM sessions WHERE expires_at<?", (time.time(),))
        c.execute("INSERT INTO sessions VALUES(?,?,?)", (token_hash(token), s["id"], time.time() + SESSION_HOURS * 3600))
    return {"token": token, "station": public_station(s)}


@app.post("/api/auth/logout")
def logout(authorization: Optional[str] = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        with db() as c:
            c.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(authorization[7:]),))
    return {"status": "signed_out"}


@app.get("/api/auth/me")
def me(station=Depends(current_station)):
    return station


# -- Incidents (responders only) --
def with_local(rows):
    for r in rows:
        r["created_at_local"] = datetime.fromisoformat(r["created_at_utc"]).astimezone(TZ).strftime("%d %b %H:%M:%S")
    return rows


ALERT_SELECT = """SELECT a.*, s.name AS assigned_station_name,
  (SELECT group_concat(DISTINCT st.name) FROM alert_updates u JOIN stations st ON st.id=u.station_id
    WHERE u.alert_id=a.id AND u.action='assist') AS assisting_stations
  FROM alerts a LEFT JOIN stations s ON s.id=a.assigned_station_id"""


@app.get("/api/alerts")
def list_alerts(limit: int = Query(100, ge=1, le=500), scope: Literal["all", "active", "closed"] = "all",
                _=Depends(current_station)):
    where = {"all": "", "active": f"WHERE a.status IN ({','.join('?' * len(ACTIVE))})",
             "closed": f"WHERE a.status IN ({','.join('?' * len(CLOSED))})"}[scope]
    args = {"all": [], "active": ACTIVE, "closed": CLOSED}[scope]
    return with_local(q(f"{ALERT_SELECT} {where} ORDER BY a.id DESC LIMIT ?", (*args, limit)))


def load_alert(c, alert_id):
    row = c.execute(f"{ALERT_SELECT} WHERE a.id=?", (alert_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Unknown incident")
    return dict(row)


def alert_detail(alert_id):
    with db() as c:
        a = load_alert(c, alert_id)
        a["updates"] = [dict(r) for r in c.execute(
            """SELECT u.*, s.name AS station_name FROM alert_updates u LEFT JOIN stations s ON s.id=u.station_id
               WHERE u.alert_id=? ORDER BY u.id""", (alert_id,))]
    return with_local([a])[0]


@app.get("/api/alerts/{alert_id}")
def get_alert(alert_id: int, _=Depends(current_station)):
    return alert_detail(alert_id)


@app.post("/api/alerts/{alert_id}/updates", status_code=201)
def update_alert(alert_id: int, body: UpdateIn, station=Depends(current_station)):
    now = iso(utcnow())
    sid = station["id"]
    with db() as c:
        a = load_alert(c, alert_id)
        cur, owner = a["status"], a["assigned_station_id"]
        if body.action == "status":
            new = body.status
            if not new:
                raise HTTPException(422, "status is required")
            if cur in CLOSED:
                raise HTTPException(409, f"Incident is already {cur.replace('_', ' ')}")
            if owner is None:
                # Unclaimed: any station may claim it or dismiss it as a false alarm
                if new not in ("acknowledged", "false_alarm"):
                    raise HTTPException(409, "Acknowledge the incident first")
            elif owner != sid:
                raise HTTPException(403, f"{a['assigned_station_name']} is handling this incident")
            elif new in ACTIVE and ACTIVE.index(new) <= ACTIVE.index(cur):
                raise HTTPException(409, "Status can only move forward")
            # Guarded update: if two stations click at once, only the first one wins
            res = c.execute(f"""UPDATE alerts SET status=?, assigned_station_id=?, updated_at_utc=?,
                acknowledged_at_utc=COALESCE(acknowledged_at_utc, ?),
                closed_at_utc=CASE WHEN ? IN ('resolved','false_alarm') THEN ? ELSE closed_at_utc END
                WHERE id=? AND status=? AND assigned_station_id IS ?""",
                (new, sid, now, now, new, now, alert_id, cur, owner))
            if res.rowcount != 1:
                raise HTTPException(409, "Someone else updated this incident, refresh and try again")
        elif body.action == "assist":
            if owner is None:
                raise HTTPException(409, "Acknowledge the incident first")
            if owner == sid:
                raise HTTPException(409, "Your station is already handling this incident")
            if cur in CLOSED:
                raise HTTPException(409, "Incident is closed")
        elif not (body.note or "").strip():
            raise HTTPException(422, "Note is empty")
        c.execute("INSERT INTO alert_updates(alert_id,station_id,action,status,note,created_at_utc) VALUES(?,?,?,?,?,?)",
                  (alert_id, sid, body.action, body.status if body.action == "status" else None,
                   (body.note or "").strip() or None, now))
        c.execute("UPDATE alerts SET updated_at_utc=? WHERE id=?", (now, alert_id))
    return alert_detail(alert_id)


@app.get("/api/events")
def list_events(limit: int = Query(50, ge=1, le=500), _=Depends(current_station)):
    return with_local(q("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)))


# -- Analytics --
def period_range(period, date):
    """Local [start, end) for the period containing `date`, plus the previous period and bucket keys."""
    try:
        d = datetime.strptime(date, "%Y-%m-%d") if date else datetime.now(TZ).replace(tzinfo=None)
    except ValueError:
        raise HTTPException(422, "date must be YYYY-MM-DD")
    if period == "year":
        start = datetime(d.year, 1, 1, tzinfo=TZ)
        end, prev = start.replace(year=d.year + 1), start.replace(year=d.year - 1)
        buckets = [(f"{m:02d}", datetime(2000, m, 1).strftime("%b")) for m in range(1, 13)]
        label = str(d.year)
    elif period == "month":
        start = datetime(d.year, d.month, 1, tzinfo=TZ)
        end = (start + timedelta(days=32)).replace(day=1)
        prev = (start - timedelta(days=1)).replace(day=1)
        buckets = [(f"{i:02d}", str(i)) for i in range(1, (end - start).days + 1)]
        label = start.strftime("%B %Y")
    else:
        start = datetime(d.year, d.month, d.day, tzinfo=TZ)
        end, prev = start + timedelta(days=1), start - timedelta(days=1)
        buckets = [(f"{h:02d}", f"{h:02d}:00") for h in range(24)]
        label = start.strftime("%a %d %B %Y")
    return start, end, prev, buckets, label


def bucket_key(period, local):
    return local.strftime({"year": "%m", "month": "%d", "day": "%H"}[period])


def minutes_between(a, b):
    return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 60


def median(xs):
    return round(statistics.median(xs), 1) if xs else None


@app.get("/api/analytics")
def analytics(period: Literal["year", "month", "day"] = "month", date: Optional[str] = None,
              include_tests: bool = True, _=Depends(current_station)):
    start, end, prev, buckets, label = period_range(period, date)
    test_filter = "" if include_tests else " AND (flags & 2)=0"
    rng = (iso(start), iso(end))
    alerts = q(f"SELECT * FROM alerts WHERE created_at_utc>=? AND created_at_utc<?{test_filter}", rng)
    prev_count = q(f"SELECT COUNT(*) n FROM alerts WHERE created_at_utc>=? AND created_at_utc<?{test_filter}",
                   (iso(prev), iso(start)))[0]["n"]
    events = q(f"SELECT type, COUNT(*) n FROM events WHERE created_at_utc>=? AND created_at_utc<?{test_filter} GROUP BY type", rng)
    ev = {r["type"]: r["n"] for r in events}
    stations = {s["id"]: s for s in q("SELECT id,name,area FROM stations")}
    ids = [a["id"] for a in alerts]
    updates = q(f"SELECT alert_id, station_id, action FROM alert_updates WHERE alert_id IN ({','.join('?' * len(ids))})",
                ids) if ids else []

    series = {k: {"key": k, "label": lbl, "minor": 0, "serious": 0, "critical": 0} for k, lbl in buckets}
    by_hour, by_weekday = [0] * 24, [0] * 7
    outcomes = Counter()
    ack, close = [], []
    per_station = defaultdict(lambda: {"handled": 0, "resolved": 0, "false_alarm": 0, "assisted": 0, "ack": []})
    cells = defaultdict(lambda: {"count": 0, "critical": 0, "lat": 0.0, "lng": 0.0})
    vehicles = Counter()
    for a in alerts:
        local = datetime.fromisoformat(a["created_at_utc"]).astimezone(TZ)
        sev = SEV[max(1, a["severity"] or 1)]
        series[bucket_key(period, local)][sev] += 1
        by_hour[local.hour] += 1
        by_weekday[local.weekday()] += 1
        outcomes[a["status"]] += 1
        vehicles[a["vehicle_label"]] += 1
        if a["acknowledged_at_utc"]:
            ack.append(minutes_between(a["created_at_utc"], a["acknowledged_at_utc"]))
        if a["closed_at_utc"] and a["status"] == "resolved":
            close.append(minutes_between(a["created_at_utc"], a["closed_at_utc"]))
        if a["assigned_station_id"] in stations:
            p = per_station[a["assigned_station_id"]]
            p["handled"] += 1
            p["resolved"] += a["status"] == "resolved"
            p["false_alarm"] += a["status"] == "false_alarm"
            if a["acknowledged_at_utc"]:
                p["ack"].append(minutes_between(a["created_at_utc"], a["acknowledged_at_utc"]))
        if a["lat"] is not None:
            cell = cells[(round(a["lat"], 2), round(a["lng"], 2))]  # ~1 km grid
            cell["count"] += 1
            cell["critical"] += sev == "critical"
            cell["lat"] += a["lat"]
            cell["lng"] += a["lng"]
    for _alert_id, sid in {(u["alert_id"], u["station_id"]) for u in updates if u["action"] == "assist"}:
        if sid in stations:
            per_station[sid]["assisted"] += 1  # counted once per incident, however many assist clicks

    hotspots = sorted(({"lat": round(v["lat"] / v["count"], 5), "lng": round(v["lng"] / v["count"], 5),
                        "count": v["count"], "critical": v["critical"]} for v in cells.values()),
                      key=lambda h: (-h["count"], -h["critical"]))[:8]
    station_rows = [{"id": sid, "name": s["name"], "area": s["area"], **{k: v for k, v in per_station[sid].items() if k != "ack"},
                     "median_ack_min": median(per_station[sid]["ack"])} for sid, s in stations.items()]
    station_rows.sort(key=lambda r: -r["handled"])
    total, cancelled = len(alerts), ev.get("cancelled", 0)
    years = q("SELECT DISTINCT substr(created_at_utc,1,4) y FROM alerts ORDER BY y")
    return {
        "period": period, "label": label, "start": start.date().isoformat(),
        "kpis": {
            "alerts": total, "prev_alerts": prev_count,
            "critical": sum(s["critical"] for s in series.values()),
            "open": sum(outcomes[s] for s in ACTIVE),
            "resolved": outcomes["resolved"], "false_alarm": outcomes["false_alarm"],
            "cancelled_by_driver": cancelled, "ignored_impacts": ev.get("ignored_event", 0),
            "cancel_rate": round(cancelled / (total + cancelled), 3) if total + cancelled else None,
            "median_ack_min": median(ack), "median_resolve_min": median(close),
            "unassigned": outcomes["new"],
        },
        "series": list(series.values()),
        "by_hour": by_hour, "by_weekday": by_weekday,
        "outcomes": {s: outcomes[s] for s in STATUSES},
        "stations": station_rows, "hotspots": hotspots,
        "vehicles": [{"label": k, "count": n} for k, n in vehicles.most_common(5)],
        "years": [int(r["y"]) for r in years if r["y"]],
    }


def haversine_km(lat1, lng1, lat2, lng2):
    p = math.pi / 180
    h = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lng2 - lng1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


@app.get("/api/alerts/{alert_id}/nearest-stations")
def nearest_stations(alert_id: int, _=Depends(current_station)):
    with db() as c:
        a = load_alert(c, alert_id)
    if a["lat"] is None:
        return []
    rows = [dict(s, distance_km=round(haversine_km(a["lat"], a["lng"], s["lat"], s["lng"]), 1))
            for s in list_stations() if s["lat"] is not None]
    return sorted(rows, key=lambda s: s["distance_km"])[:5]
