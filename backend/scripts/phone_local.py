"""Use a real phone against the server on this computer, without a tunnel.

    python scripts/phone_local.py            # port 8000
    python scripts/phone_local.py 8080

Option A, USB (recommended): forwards the phone's localhost:<port> to this computer with `adb reverse`.
Chrome treats http://localhost as secure, so Web Bluetooth, GPS and wake lock all work, with no certificate,
no Chrome flag and no internet needed.

Option B, same Wi-Fi or the phone's hotspot: prints this computer's network addresses. Over plain http on an
IP address Chrome blocks Bluetooth and GPS, so the script also prints the one Chrome flag that allows it.
"""
import os, shutil, socket, subprocess, sys
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
IS_WSL = "microsoft" in Path("/proc/version").read_text().lower() if Path("/proc/version").exists() else False


def find_adb():
    for name in ("adb", "adb.exe"):
        if shutil.which(name):
            return shutil.which(name)
    home = Path.home()
    candidates = [home / "AppData/Local/Android/Sdk/platform-tools/adb.exe",
                  home / "Library/Android/sdk/platform-tools/adb",
                  home / "Android/Sdk/platform-tools/adb"]
    if os.getenv("ANDROID_HOME"):
        candidates.insert(0, Path(os.environ["ANDROID_HOME"]) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb"))
    if IS_WSL:  # the Windows SDK, seen from WSL
        candidates += sorted(Path("/mnt/c/Users").glob("*/AppData/Local/Android/Sdk/platform-tools/adb.exe"))
    return next((str(p) for p in candidates if p.exists()), None)


def lan_ips():
    ips = set()
    if IS_WSL:  # WSL's own address is internal; the phone needs the Windows one
        try:
            out = subprocess.run(["ipconfig.exe"], capture_output=True, text=True, timeout=5).stdout
            ips |= {l.split(":")[-1].strip() for l in out.splitlines() if "IPv4" in l}
        except Exception:
            pass
    else:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
            s.close()
        except Exception:
            pass
    # Skip virtual adapters (WSL/Hyper-V 172.x, VirtualBox 192.168.56.x)
    return sorted(ip for ip in ips if ip and not ip.startswith(("127.", "172.", "192.168.56.", "169.254.")))


def server_up():
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            return True
    except OSError:
        return False


def main():
    print(f"\nAccidentAlert AI: phone on localhost (port {PORT})\n")
    if not server_up():
        print(f"  ! Nothing is listening on port {PORT} yet. Start the server first:")
        print(f"      uvicorn app.main:app --host 0.0.0.0 --port {PORT}\n")

    print("A) USB cable (recommended)")
    adb = find_adb()
    if not adb:
        print("   adb not found. Install Android 'platform-tools' and run this again.")
    else:
        devs = subprocess.run([adb, "devices"], capture_output=True, text=True).stdout.splitlines()[1:]
        devs = [l.split() for l in devs if l.strip()]
        ready = [d[0] for d in devs if len(d) > 1 and d[1] == "device"]
        if any(len(d) > 1 and d[1] == "unauthorized" for d in devs):
            print("   The phone is asking 'Allow USB debugging?'. Tap Allow, then run this again.")
        elif not ready:
            print("   No phone found. On the phone: Settings > About phone > tap 'Build number' 7 times,")
            print("   then Developer options > turn on 'USB debugging'. Plug in the cable and run this again.")
        for serial in ready:
            r = subprocess.run([adb, "-s", serial, "reverse", f"tcp:{PORT}", f"tcp:{PORT}"], capture_output=True, text=True)
            if r.returncode == 0:
                print(f"   ✓ Phone {serial} connected. On the phone, open Chrome at:")
                print(f"       http://localhost:{PORT}/            driver app (Bluetooth + GPS work)")
                print(f"       http://localhost:{PORT}/dispatch    responder portal")
            else:
                print(f"   adb reverse failed for {serial}: {r.stderr.strip()}")
        if ready:
            print("   Run this script again after unplugging the phone or restarting adb.")

    print("\nB) Same Wi-Fi, or the computer joined to the phone's hotspot")
    ips = lan_ips()
    if not ips:
        print("   No network address found. Connect this computer to Wi-Fi or the phone's hotspot.")
    for ip in ips:
        print(f"   http://{ip}:{PORT}/   and   http://{ip}:{PORT}/dispatch")
    if ips:
        print("   The portal works as is. For the driver app, Bluetooth and GPS need one Chrome setting on the phone:")
        print("     chrome://flags/#unsafely-treat-insecure-origin-as-secure")
        print(f"     add  http://{ips[0]}:{PORT}  , set it to Enabled, tap Relaunch.")
        print("   If the phone can't open the page, allow port", PORT, "through the computer's firewall.")
        if IS_WSL:
            print("   WSL: the phone can't reach WSL directly. Either turn on mirrored networking")
            print("   (add  [wsl2]  networkingMode=mirrored  to %UserProfile%\\.wslconfig, then  wsl --shutdown),")
            print("   or use option A, which works with WSL as it is.")
    print()


if __name__ == "__main__":
    main()
