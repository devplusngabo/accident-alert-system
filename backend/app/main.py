import os
import sqlite3
import time
import uuid
from contextlib import closing
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .model import predict_window

DB_PATH = os.getenv("DB_PATH", "alerts.db")
API_KEY = os.getenv("API_KEY", "")  # empty means open, for local development only
CANCEL_SECONDS = int(os.getenv("CANCEL_SECONDS", "15"))
ONLINE_SECONDS = 60

app = FastAPI(title="Accident Alert System API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


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
            alert_count INTEGER, last_probability REAL, model_version TEXT);
    """)


class AlertIn(BaseModel):
    device_id: str
    probability: float = Field(ge=0, le=1)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    occurred_at: Optional[float] = None  # unix seconds, measured on the phone


class HeartbeatIn(BaseModel):
    connected: bool
    rssi: Optional[int] = None
    alert_count: int = 0
    last_probability: Optional[float] = None
    model_version: Optional[str] = None


class WindowIn(BaseModel):
    window: list[list[float]]  # 200 rows of [acceleration magnitude in g, gyro magnitude in deg/s]


class Hub:
    def __init__(self):
        self.clients = set()

    async def broadcast(self, message: dict):
        for client in list(self.clients):
            try:
                await client.send_json(message)
            except Exception:
                self.clients.discard(client)


hub = Hub()


def require_key(x_api_key: str = Header(default="")):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def alert_dict(row):
    data = dict(row)
    if data["status"] == "pending" and time.time() - data["created_at"] > CANCEL_SECONDS:
        data["status"] = "dispatched"  # cancel window passed, no human action needed
    return data


def device_dict(row):
    data = dict(row)
    data["connected"] = bool(data["connected"])
    data["online"] = data["connected"] and time.time() - data["last_seen"] < ONLINE_SECONDS
    return data


@app.get("/health")
def health():
    return {"status": "ok", "time": time.time()}


@app.put("/api/devices/{device_id}/heartbeat", dependencies=[Depends(require_key)])
async def heartbeat(device_id: str, body: HeartbeatIn):
    with closing(connect()) as conn, conn:
        conn.execute(
            """INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen,
               connected = excluded.connected, rssi = excluded.rssi,
               alert_count = excluded.alert_count, last_probability = excluded.last_probability,
               model_version = excluded.model_version""",
            (device_id, time.time(), int(body.connected), body.rssi, body.alert_count,
             body.last_probability, body.model_version))
        row = conn.execute("SELECT * FROM devices WHERE device_id = ?", (device_id,)).fetchone()
    device = device_dict(row)
    await hub.broadcast({"type": "device", "data": device})
    return device


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
async def create_alert(body: AlertIn):
    alert_id, now = uuid.uuid4().hex[:12], time.time()
    with closing(connect()) as conn, conn:
        conn.execute("INSERT INTO alerts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (alert_id, body.device_id, body.probability, body.latitude, body.longitude,
                      body.occurred_at or now, now, "pending"))
        row = conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
    alert = alert_dict(row)
    await hub.broadcast({"type": "alert", "data": alert})
    return alert


@app.get("/api/alerts", dependencies=[Depends(require_key)])
def list_alerts(status: Optional[str] = None, device_id: Optional[str] = None,
                limit: int = Query(50, le=200)):
    with closing(connect()) as conn:
        rows = conn.execute("SELECT * FROM alerts ORDER BY created_at DESC LIMIT 500").fetchall()
    alerts = [alert_dict(r) for r in rows]
    if status:
        alerts = [a for a in alerts if a["status"] == status]
    if device_id:
        alerts = [a for a in alerts if a["device_id"] == device_id]
    return alerts[:limit]


def load_alert(conn, alert_id):
    row = conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Unknown alert")
    return alert_dict(row)


@app.get("/api/alerts/{alert_id}", dependencies=[Depends(require_key)])
def get_alert(alert_id: str):
    with closing(connect()) as conn:
        return load_alert(conn, alert_id)


async def change_status(alert_id: str, new_status: str, allowed: tuple):
    with closing(connect()) as conn, conn:
        current = load_alert(conn, alert_id)["status"]
        if current not in allowed:
            raise HTTPException(status_code=409, detail=f"Alert is already {current}")
        conn.execute("UPDATE alerts SET status = ? WHERE id = ?", (new_status, alert_id))
        alert = load_alert(conn, alert_id)
    await hub.broadcast({"type": "alert", "data": alert})
    return alert


@app.post("/api/alerts/{alert_id}/cancel", dependencies=[Depends(require_key)])
async def cancel_alert(alert_id: str):
    return await change_status(alert_id, "cancelled", ("pending",))


@app.post("/api/alerts/{alert_id}/resolve", dependencies=[Depends(require_key)])
async def resolve_alert(alert_id: str):
    return await change_status(alert_id, "resolved", ("pending", "dispatched"))


@app.post("/api/predict", dependencies=[Depends(require_key)])
def predict(body: WindowIn):
    if len(body.window) != 200 or any(len(row) != 2 for row in body.window):
        raise HTTPException(status_code=422, detail="window must be 200 rows of [acc_g, gyro_dps]")
    return predict_window(body.window)


@app.websocket("/ws")
async def live(websocket: WebSocket, key: str = ""):
    if API_KEY and key != API_KEY:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    hub.clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.clients.discard(websocket)