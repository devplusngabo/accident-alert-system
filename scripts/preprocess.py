import glob
import os
import numpy as np
import pyarrow.parquet as pq

DATA_DIR = "./data"
OUT_DIR = "./processed"
FS = 100
HALF = FS  # 1 s on each side gives a 2 s window
COLUMNS = ["event_id", "label", "gyro_is_hd", "gsensor", "gyro"]


def make_window(acc, gyro):
    """Return a (200, 2) window of [acc_mag, gyro_mag], or None if the event is too short."""
    if len(acc) < 2 * HALF:
        return None
    acc_mag = np.linalg.norm(acc, axis=1)
    gyro_mag = np.linalg.norm(np.round(gyro), axis=1)  # same precision for standard and HD
    peak = int(np.argmax(np.abs(np.diff(acc_mag)))) + 1
    start = min(max(peak - HALF, 0), len(acc_mag) - 2 * HALF)
    end = start + 2 * HALF
    return np.stack([acc_mag[start:end], gyro_mag[start:end]], axis=1).astype(np.float32)


def make_features(window):
    a, w = window[:, 0], window[:, 1]
    jerk = np.abs(np.diff(a)) * FS
    return np.array([
        a.max(), a.min(), a.mean(), a.std(), np.sqrt(np.mean((a - 1) ** 2)),
        jerk.max(), w.max(), w.mean(), w.std(),
        a[-50:].std(), w[-50:].mean(),  # stillness after the impact
    ], dtype=np.float32)


def process_shard(path):
    windows, features, labels, hd_flags = [], [], [], []
    for batch in pq.ParquetFile(path).iter_batches(batch_size=64, columns=COLUMNS):
        for row in batch.to_pylist():
            acc = np.asarray(row["gsensor"], dtype=np.float32)
            gyro = np.asarray(row["gyro"], dtype=np.float32)
            window = make_window(acc, gyro)
            if window is None:
                continue
            windows.append(window)
            features.append(make_features(window))
            labels.append(row["label"])
            hd_flags.append(row["gyro_is_hd"])
    return (np.stack(windows), np.stack(features),
            np.array(labels, dtype=np.int8), np.array(hd_flags, dtype=bool))


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "*.parquet"))):
        if os.path.getsize(path) < 1_000_000:  # skip 134-byte pointer files
            continue
        name = os.path.basename(path).replace(".parquet", "")
        windows, features, labels, hd_flags = process_shard(path)
        np.savez_compressed(os.path.join(OUT_DIR, f"{name}.npz"),
                            windows=windows, features=features,
                            labels=labels, gyro_is_hd=hd_flags)
        print(name, windows.shape, np.bincount(labels, minlength=3))
