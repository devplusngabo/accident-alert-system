"""Usage: python send_test_alert.py https://your-url"""
import json, sys, urllib.request
from datetime import datetime, timezone
body = {"vehicle_label": "Script test", "countdown_s": 0, "client_time_iso": datetime.now(timezone.utc).isoformat(),
        "event": {"class": 3, "severity": 2, "peak_g": 9.4, "confidence": 0.93, "flags": 2, "device_ms": 1, "seq": 1},
        "location": {"lat": -1.9441, "lng": 30.0619, "accuracy_m": 12, "fix_age_s": 1}}
req = urllib.request.Request(sys.argv[1].rstrip("/") + "/api/alerts", json.dumps(body).encode(),
                             {"Content-Type": "application/json"})
print(urllib.request.urlopen(req).read().decode())
