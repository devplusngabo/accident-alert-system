import os, sqlite3, time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

# ---- Config (environment variables) ----
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT = os.getenv("TELEGRAM_CHAT_ID")
DB_PATH = os.getenv("DB_PATH", "./crashguard.db")
TZ = ZoneInfo(os.getenv("TIMEZONE_DISPLAY", "Africa/Kigali"))
RATE = int(os.getenv("ALERT_RATE_LIMIT_PER_MIN", "10"))
STATIC = Path(__file__).parent / "static"
SEV = {0: "none", 1: "minor", 2: "serious", 3: "critical"}

# ---- Database ----
def q(sql, args=(), write=False):
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        cur = c.execute(sql, args)
        if write:
            c.commit()
            return cur.lastrowid
        return [dict(r) for r in cur.fetchall()]
    finally:
        c.close()

q("""CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_utc TEXT,
 vehicle_label TEXT, event_class INTEGER, severity INTEGER, peak_g REAL, confidence REAL, flags INTEGER,
 device_ms INTEGER, seq INTEGER, lat REAL, lng REAL, accuracy_m REAL, fix_age_s REAL,
 client_time_iso TEXT, countdown_s INTEGER, telegram_status TEXT, status TEXT)""", write=True)
q("""CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_utc TEXT,
 type TEXT, vehicle_label TEXT, event_class INTEGER, severity INTEGER, peak_g REAL, flags INTEGER,
 client_time_iso TEXT)""", write=True)

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
    lat: float
    lng: float
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

# ---- Rate limit (per IP, in memory) ----
hits = defaultdict(deque)
def limited(ip):
    now, d = time.time(), hits[ip]
    while d and now - d[0] > 60:
        d.popleft()
    if len(d) >= RATE:
        return True
    d.append(now)
    return False

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
    text = (f"{'TEST ' if ev.flags & 2 else ''}CRASH ALERT (severity {ev.severity}: {SEV[ev.severity]})\n"
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
app = FastAPI(title="CrashGuard")
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

@app.post("/api/alerts", status_code=201)
async def post_alert(a: AlertIn, request: Request):
    if limited(request.client.host if request.client else "?"):
        raise HTTPException(429, "Too many alerts")
    now = datetime.now(timezone.utc)
    ev, loc = a.event, a.location
    id_ = q("""INSERT INTO alerts(created_at_utc,vehicle_label,event_class,severity,peak_g,confidence,flags,device_ms,seq,
        lat,lng,accuracy_m,fix_age_s,client_time_iso,countdown_s,telegram_status,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (now.isoformat(), a.vehicle_label, ev.cls, ev.severity, ev.peak_g, ev.confidence, ev.flags, ev.device_ms, ev.seq,
         loc.lat if loc else None, loc.lng if loc else None, loc.accuracy_m if loc else None,
         loc.fix_age_s if loc else None, a.client_time_iso, a.countdown_s, "pending", "received"), write=True)
    when = f"{now.astimezone(TZ).strftime('%d %b %Y, %H:%M')} ({TZ.key.split('/')[-1]})"
    status = await telegram(a, when)
    q("UPDATE alerts SET telegram_status=? WHERE id=?", (status, id_), write=True)
    return {"id": id_, "status": "received", "telegram_status": status}

@app.post("/api/events", status_code=201)
def post_event(e: EventLogIn):
    ev = e.event
    q("""INSERT INTO events(created_at_utc,type,vehicle_label,event_class,severity,peak_g,flags,client_time_iso)
        VALUES(?,?,?,?,?,?,?,?)""",
      (datetime.now(timezone.utc).isoformat(), e.type, e.vehicle_label, ev.cls, ev.severity, ev.peak_g, ev.flags,
       e.client_time_iso), write=True)
    return {"status": "stored"}

def with_local(rows):
    for r in rows:
        r["created_at_local"] = datetime.fromisoformat(r["created_at_utc"]).astimezone(TZ).strftime("%d %b %H:%M:%S")
    return rows

@app.get("/api/alerts")
def list_alerts(limit: int = 50):
    return with_local(q("SELECT * FROM alerts ORDER BY id DESC LIMIT ?", (min(max(limit, 1), 500),)))

@app.get("/api/events")
def list_events(limit: int = 50):
    return with_local(q("SELECT * FROM events ORDER BY id DESC LIMIT ?", (min(max(limit, 1), 500),)))
