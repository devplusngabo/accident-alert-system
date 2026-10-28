# accident-alert-system

Edge-AI crash detection on an Arduino Nano 33 BLE. A 3.4 KB neural network tells real crashes
from bumps, door slams and hard braking, so an alert can be sent to emergency services
without human intervention.

## How it works
Nano 33 BLE (IMU + model) -> BLE -> phone app (GPS, internet) -> police / emergency contacts

- 100 Hz accelerometer and gyroscope, 2 s window around a jerk trigger (40 g/s)
- 11 orientation-independent features, small neural network (11-16-8-1) in plain C++
- Trained on VZCrash (real vehicle crashes) plus own recordings from the Nano

## Results
| Test | Method | Recall | False alarms |
|---|---|---|---|
| VZCrash test set | g-force threshold | 89.7% | 5.6% |
| VZCrash test set | neural network | 89.5% | 4.1% |

Model size 3.4 KB. The Nano C++ matches the Python model exactly (feature difference 0.00000).
Limitations: crash proxies on own data, no motorcycles or slow rollovers, field test per hour pending.

## Repository
- `scripts/`: preprocessing, training, export and data logging (run from the repo root)
- `firmware/crash_detector/`: Arduino sketch and exported model
- `models/`: trained models and scalers
- `own_data/`: labeled recordings from the Nano

## Run
1. Request access to VZCrash on Hugging Face and download the data shards into `data/`
2. `pip install -r requirements.txt`
3. `python3 scripts/preprocess.py`, then `python3 scripts/retrain.py`, then `python3 scripts/export_model.py`
4. Copy `model_data.h` into `firmware/crash_detector/` and upload the sketch with the Arduino IDE

## Data and citation
VZCrash is not included (gated, CC BY-NC 4.0). Bianconcini, T., Monteagudo, H. P., Pjetri, A.,
Trinci, T., & Taccari, L. "VZCrash: A Large-Scale IMU Dataset of Ego-Vehicle Crashes",
IEEE ITSC 2026.