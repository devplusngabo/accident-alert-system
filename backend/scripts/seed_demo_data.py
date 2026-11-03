"""Fill a SEPARATE database with a year of synthetic incidents so the analytics have something to show.

    DB_PATH=./demo.db DEMO_STATION_PIN=2468 python scripts/seed_demo_data.py
    DB_PATH=./demo.db DEMO_STATION_PIN=2468 uvicorn app.main:app --port 8000

Refuses to touch a database that already holds alerts, so real data is never mixed with fake data.
"""
import os, random, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

if not os.getenv("DB_PATH") or Path(os.environ["DB_PATH"]).name == "crashguard.db":
    sys.exit("Set DB_PATH to a separate demo database, e.g. DB_PATH=./demo.db")
if not os.getenv("DEMO_STATION_PIN"):
    sys.exit("Set DEMO_STATION_PIN so the demo stations are created, e.g. DEMO_STATION_PIN=2468")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import DB_PATH, TZ, db, iso  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 650
random.seed(7)
# Busy Kigali corridors (lat, lng, weight)
SPOTS = [(-1.9536, 30.0928, 5), (-1.9706, 30.1044, 4), (-1.9441, 30.0619, 4), (-1.9787, 30.0435, 3),
         (-1.9355, 30.0820, 2), (-1.9905, 30.1100, 2), (-1.9577, 30.1127, 3), (-1.9300, 30.1500, 1)]
HOUR_W = [1, 1, 1, 1, 1, 2, 4, 7, 8, 5, 4, 4, 5, 5, 5, 6, 8, 10, 11, 8, 6, 4, 3, 2]
DOW_W = [5, 5, 5, 6, 8, 9, 6]  # Mon..Sun
PLATES = [f"RA{random.choice('BCDE')} {random.randint(100, 999)}{random.choice('ABCDEFGH')}" for _ in range(60)]

with db() as c:
    if c.execute("SELECT 1 FROM alerts LIMIT 1").fetchone():
        sys.exit(f"{DB_PATH} already has alerts; use a fresh file")
    stations = [dict(r) for r in c.execute("SELECT id, lat, lng FROM stations")]
    now = datetime.now(TZ)
    made = 0
    while made < N:
        day = now - timedelta(days=random.uniform(0, 400))
        if random.random() > DOW_W[day.weekday()] / 9:
            continue
        hour = random.choices(range(24), HOUR_W)[0]
        t = day.replace(hour=hour, minute=random.randint(0, 59), second=random.randint(0, 59))
        if t > now:
            continue
        lat0, lng0, _ = random.choices(SPOTS, [s[2] for s in SPOTS])[0]
        lat, lng = lat0 + random.gauss(0, .004), lng0 + random.gauss(0, .004)
        sev = random.choices([1, 2, 3], [5, 3, 2])[0]
        peak = {1: random.uniform(3.5, 4.0), 2: random.uniform(4, 8), 3: random.uniform(8, 16)}[sev]
        aid = c.execute("""INSERT INTO alerts(created_at_utc,vehicle_label,event_class,severity,peak_g,confidence,flags,
            device_ms,seq,lat,lng,accuracy_m,fix_age_s,client_time_iso,countdown_s,telegram_status,status,updated_at_utc)
            VALUES(?,?,3,?,?,?,0,0,0,?,?,?,?,?,15,'disabled','new',?)""",
            (iso(t), random.choice(PLATES), sev, round(peak, 2), round(random.uniform(.8, .99), 2), lat, lng,
             random.randint(4, 40), random.uniform(0, 5), iso(t), iso(t))).lastrowid
        made += 1
        if (now - t).total_seconds() < 1800 and random.random() < .6:
            continue  # leave a few recent ones unassigned
        lead = min(stations, key=lambda s: (s["lat"] - lat) ** 2 + (s["lng"] - lng) ** 2) if random.random() < .8 else random.choice(stations)
        step = t + timedelta(minutes=random.lognormvariate(.8, .6))
        updates = [("status", "acknowledged", step)]
        if random.random() < .1:
            updates.append(("status", "false_alarm", step + timedelta(minutes=random.uniform(3, 15))))
        else:
            for s in ("en_route", "on_scene", "resolved"):
                step += timedelta(minutes=random.uniform(3, 25))
                updates.append(("status", s, step))
        if sev == 3 and random.random() < .5:
            helper = random.choice([s for s in stations if s["id"] != lead["id"]])
            c.execute("INSERT INTO alert_updates(alert_id,station_id,action,note,created_at_utc) VALUES(?,?,?,?,?)",
                      (aid, helper["id"], "assist", "Sending an ambulance", iso(t + timedelta(minutes=6))))
        for action, status, when in updates:
            if when > now:
                break
            c.execute("INSERT INTO alert_updates(alert_id,station_id,action,status,created_at_utc) VALUES(?,?,?,?,?)",
                      (aid, lead["id"], action, status, iso(when)))
            c.execute("""UPDATE alerts SET status=?, assigned_station_id=?, updated_at_utc=?,
                acknowledged_at_utc=COALESCE(acknowledged_at_utc, ?),
                closed_at_utc=CASE WHEN ? IN ('resolved','false_alarm') THEN ? ELSE NULL END WHERE id=?""",
                      (status, lead["id"], iso(when), iso(when), status, iso(when), aid))
    # Driver cancellations and ignored bumps, so the cancel-rate metric has data
    for _ in range(N // 3):
        t = now - timedelta(days=random.uniform(0, 400), hours=random.uniform(0, 24))
        c.execute("INSERT INTO events(created_at_utc,type,vehicle_label,event_class,severity,peak_g,flags,client_time_iso) "
                  "VALUES(?,?,?,3,1,?,0,?)", (iso(t), random.choice(["cancelled", "cancelled", "ignored_event"]),
                                              random.choice(PLATES), round(random.uniform(3.5, 5), 2), iso(t)))
print(f"Seeded {N} incidents into {DB_PATH}")
