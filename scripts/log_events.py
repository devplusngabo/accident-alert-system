import os
import sys
import time

import numpy as np
import serial

port, label = sys.argv[1], sys.argv[2]
os.makedirs("own_data", exist_ok=True)
path = f"own_data/{label}_{int(time.time())}.npy"
events = []
crash_verdicts = 0
start = time.time()

try:
    with serial.Serial(port, 115200, timeout=1) as ser:
        print(f"Logging '{label}' on {port}. Ctrl+C to stop.")
        while True:
            line = ser.readline().decode(errors="ignore").strip()
            if line.startswith("EVENT,"):
                values = np.array(line.split(",")[1:], dtype=np.float32)
                if values.size == 400:
                    window = values.reshape(200, 2)
                    events.append(window)
                    np.save(path, np.stack(events))  # saved after every event
                    rest = np.median(window[:100, 0])
                    print(f"event {len(events)}: rest level {rest:.2f} g (should be about 1.0)")
            elif line:
                print(line)
                if ">>> CRASH" in line:
                    crash_verdicts += 1
except KeyboardInterrupt:
    pass
except serial.SerialException as error:
    print("Connection lost:", error)

hours = (time.time() - start) / 3600
print(f"Session {hours * 60:.1f} min | events {len(events)} | CRASH verdicts {crash_verdicts} "
      f"({crash_verdicts / max(hours, 1e-6):.1f} per hour)")
if events:
    print(f"Saved {len(events)} events to {path}")
    