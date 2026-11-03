"""Manage responder stations. Run from the backend folder so DB_PATH matches the server.

    python scripts/manage_stations.py list
    python scripts/manage_stations.py add "Remera Station" --area Gasabo --lat -1.9577 --lng 30.1127
    python scripts/manage_stations.py set-pin 2
    python scripts/manage_stations.py remove 2

The PIN is asked for interactively so it never lands in shell history.
"""
import argparse, getpass, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import DB_PATH, add_station, db, hash_pin  # noqa: E402  (importing also creates the tables)
import secrets  # noqa: E402


def ask_pin():
    pin = getpass.getpass("New PIN (4 to 12 digits): ")
    if pin != getpass.getpass("Repeat PIN: "):
        sys.exit("PINs do not match")
    return pin


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    a = sub.add_parser("add")
    a.add_argument("name")
    a.add_argument("--area")
    a.add_argument("--lat", type=float)
    a.add_argument("--lng", type=float)
    sp = sub.add_parser("set-pin")
    sp.add_argument("id", type=int)
    rm = sub.add_parser("remove")
    rm.add_argument("id", type=int)
    args = p.parse_args()
    print(f"Database: {DB_PATH}")

    with db() as c:
        if args.cmd == "list":
            for r in c.execute("SELECT id,name,area,lat,lng FROM stations ORDER BY id"):
                print(f"  {r['id']:>3}  {r['name']:<28} {r['area'] or '':<14} {r['lat']}, {r['lng']}")
        elif args.cmd == "add":
            try:
                sid = add_station(c, args.name, args.area, args.lat, args.lng, ask_pin())
            except ValueError as e:
                sys.exit(str(e))
            print(f"Added station {sid}: {args.name}")
        elif args.cmd == "set-pin":
            pin = ask_pin()
            if not (4 <= len(pin) <= 12 and pin.isdigit()):
                sys.exit("PIN must be 4 to 12 digits")
            salt = secrets.token_hex(16)
            if not c.execute("UPDATE stations SET pin_salt=?, pin_hash=? WHERE id=?", (salt, hash_pin(pin, salt), args.id)).rowcount:
                sys.exit("No such station")
            c.execute("DELETE FROM sessions WHERE station_id=?", (args.id,))  # sign out everywhere
            print("PIN changed, existing sessions signed out")
        elif args.cmd == "remove":
            if c.execute("SELECT 1 FROM alerts WHERE assigned_station_id=? LIMIT 1", (args.id,)).fetchone():
                sys.exit("Station has incidents on record; keep it for history (change its PIN instead)")
            c.execute("DELETE FROM sessions WHERE station_id=?", (args.id,))
            if not c.execute("DELETE FROM stations WHERE id=?", (args.id,)).rowcount:
                sys.exit("No such station")
            print("Removed")


if __name__ == "__main__":
    main()
