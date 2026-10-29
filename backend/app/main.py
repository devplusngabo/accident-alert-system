import os
import sqlite3
import time
import uuid
from contextlib import closing
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, Field

DB_PATH = os.getenv("DB_PATH", "alerts.db")
API_KEY = os.getenv("API_KEY", "")  # empty means no key check, for local testing only
CANCEL_SECONDS = int(os.getenv("CANCEL_SECONDS", "15"))
ONLINE_SECONDS = int(os.getenv("ONLINE_SECONDS", "60"))

app = FastAPI(title="Accident Alert System API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def require_key(key: Optional[str] = Depends(api_key_header)):
    if API_KEY and key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


with closing(connect()) as conn, conn:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY, device_id TEXT, probability REAL, latitude REAL,
            longitude REAL, occurred_at REAL, created_at REAL, status TEXT);
        CREATE TABLE IF NOT EXISTS devices (
            device_id TEXT PRIMARY KEY, last_seen REAL, connected INTEGER, rssi INTEGER,
            alert_count INTEGER, last_probability REAL);
    """)


class AlertIn(BaseModel):
    device_id: str
    probability: float = Field(ge=0, le=1)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    occurred_at: Optional[float] = None  # unix seconds, measured on the phone


class HeartbeatIn(BaseModel):
    connected: bool = True
    rssi: Optional[int] = None
    alert_count: int = 0
    last_probability: Optional[float] = None


def alert_dict(row):
    data = dict(row)
    age = time.time() - data["created_at"]
    if data["status"] == "pending" and age > CANCEL_SECONDS:
        data["status"] = "dispatched"  # cancel window passed, no human action needed
    data["cancel_seconds_left"] = max(0, round(CANCEL_SECONDS - age)) if data["status"] == "pending" else 0
    return data


def device_dict(row):
    data = dict(row)
    data["connected"] = bool(data["connected"])
    data["seconds_since_seen"] = round(time.time() - data["last_seen"])
    data["online"] = data["connected"] and data["seconds_since_seen"] < ONLINE_SECONDS
    return data


def load_alert(conn, alert_id):
    row = conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Unknown alert")
    return alert_dict(row)


def change_status(alert_id, new_status, allowed):
    with closing(connect()) as conn, conn:
        current = load_alert(conn, alert_id)["status"]
        if current not in allowed:
            raise HTTPException(status_code=409, detail=f"Alert is already {current}")
        conn.execute("UPDATE alerts SET status = ? WHERE id = ?", (new_status, alert_id))
        return load_alert(conn, alert_id)


@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse("/docs")


@app.get("/health")
def health():
    return {"status": "ok", "time": time.time()}


@app.put("/api/devices/{device_id}/heartbeat", dependencies=[Depends(require_key)])
def heartbeat(device_id: str, body: HeartbeatIn):
    with closing(connect()) as conn, conn:
        conn.execute(
            """INSERT INTO devices (device_id, last_seen, connected, rssi, alert_count, last_probability)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen,
               connected = excluded.connected, rssi = excluded.rssi,
               alert_count = excluded.alert_count, last_probability = excluded.last_probability""",
            (device_id, time.time(), int(body.connected), body.rssi, body.alert_count,
             body.last_probability))
        row = conn.execute("SELECT * FROM devices WHERE device_id = ?", (device_id,)).fetchone()
    return device_dict(row)


@app.get("/api/devices", dependencies=[Depends(require_key)])
def list_devices():
    with closing(connect()) as conn:
        rows = conn.execute("SELECT * FROM devices ORDER BY last_seen DESC").fetchall()
    return [device_dict(r) for r in rows]


@app.get("/api/devices/{device_id}/status", dependencies=[Depends(require_key)])
def device_status(device_id: str):
    with closing(connect()) as conn:
        row = conn.execute("SELECT * FROM devices WHERE device_id = ?", (device_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Unknown device")
    return device_dict(row)


@app.post("/api/alerts", status_code=201, dependencies=[Depends(require_key)])
def create_alert(body: AlertIn):
    alert_id, now = uuid.uuid4().hex[:12], time.time()
    with closing(connect()) as conn, conn:
        conn.execute(
            """INSERT INTO alerts (id, device_id, probability, latitude, longitude,
               occurred_at, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')""",
            (alert_id, body.device_id, body.probability, body.latitude, body.longitude,
             body.occurred_at or now, now))
        return load_alert(conn, alert_id)


@app.get("/api/alerts", dependencies=[Depends(require_key)])
def list_alerts(status: Optional[str] = None, device_id: Optional[str] = None,
                limit: int = Query(50, ge=1, le=200)):
    with closing(connect()) as conn:
        rows = conn.execute("SELECT * FROM alerts ORDER BY created_at DESC LIMIT 500").fetchall()
    alerts = [alert_dict(r) for r in rows]
    if status:
        alerts = [a for a in alerts if a["status"] == status]
    if device_id:
        alerts = [a for a in alerts if a["device_id"] == device_id]
    return alerts[:limit]


@app.get("/api/alerts/{alert_id}", dependencies=[Depends(require_key)])
def get_alert(alert_id: str):
    with closing(connect()) as conn:
        return load_alert(conn, alert_id)


@app.post("/api/alerts/{alert_id}/cancel", dependencies=[Depends(require_key)])
def cancel_alert(alert_id: str):
    return change_status(alert_id, "cancelled", ("pending",))


@app.post("/api/alerts/{alert_id}/resolve", dependencies=[Depends(require_key)])
def resolve_alert(alert_id: str):
    return change_status(alert_id, "resolved", ("pending", "dispatched"))
