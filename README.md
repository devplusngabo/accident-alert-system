# CrashGuard, Phase A

Prototype. The crash class is trained on surrogate impacts, not real crashes. Dispatch is a mock. The phone page must stay open with the screen on. Phase A is untested on hardware.

## Run the backend
    cd backend && python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env        # fill in Telegram values (optional)
    uvicorn app.main:app --host 0.0.0.0 --port 8000 --env-file .env

## Make it HTTPS (needed by Web Bluetooth, GPS and wake lock)
Demo day: `cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000` (check current commands). Open the https URL on the Android phone (Chrome) for `/` and on any device for `/dispatch`.

## Telegram (optional)
Create a bot with @BotFather, make a group, add the bot, send a message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to find the chat id. Put both in `.env`. Without them alerts are still stored and shown on `/dispatch`.

## Firmware
Open `firmware/crashguard_firmware`, set `IMU_REV` (1 or 2) at the top, install ArduinoBLE and the matching IMU library, upload. Serial (115200) prints the accelerometer range at boot. Check it says 16 g on Rev1. Rev2 stays at 4 g (saturation is flagged).

## Phone checklist
Chrome up to date, Bluetooth on, location on and allowed, battery saver off, data on, screen on, volume up.

## Test without hardware
`python backend/scripts/send_test_alert.py https://your-url`, or tap "Simulate crash (no device)".

## Decisions
DB column is `event_class` (SQL keyword avoidance); the API returns `event_class`. Request bodies still use `class`.
