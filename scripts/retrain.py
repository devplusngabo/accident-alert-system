import glob
import os
import shutil

import numpy as np
import tensorflow as tf
from sklearn.metrics import precision_recall_curve

from preprocess import make_features

PROC = "./processed"
OWN_DIR = "./own_data"
TRAIN = ["train-00004-of-00011", "train-00006-of-00011", "train-00007-of-00011"]
VAL = ["validation-00001-of-00003"]
TEST = ["test-00000-of-00002", "test-00001-of-00002"]
OWN_WEIGHT = 5.0
TARGET_RECALL = 0.90
MIN_CRASH_PEAK = 4.0  # g, a crash proxy must show a clear impact


def load_shards(names):
    parts = [np.load(f"{PROC}/{n}.npz") for n in names]
    x = np.concatenate([p["features"] for p in parts])
    y = (np.concatenate([p["labels"] for p in parts]) == 0).astype(int)
    return x, y


def load_own():
    """Every third recording is held out for testing, never used in training."""
    features, labels, names, held_out = [], [], [], []
    for i, path in enumerate(sorted(glob.glob(f"{OWN_DIR}/*.npy"))):
        name = os.path.basename(path).rsplit("_", 1)[0]
        is_crash = name.startswith("crash")
        for window in np.load(path):
            if is_crash and window[:, 0].max() < MIN_CRASH_PEAK:
                continue  # too gentle to be an impact, probably handling
            features.append(make_features(window))
            labels.append(int(is_crash))
            names.append(name)
            held_out.append(i % 3 == 2)
    return np.array(features), np.array(labels), np.array(names), np.array(held_out)


x_train, y_train = load_shards(TRAIN)
x_val, y_val = load_shards(VAL)
x_test, y_test = load_shards(TEST)
x_own, y_own, names_own, held_out = load_own()
if len(x_own) == 0:
    raise SystemExit("No recordings found in own_data/")

print(f"Own events: {len(x_own)} ({held_out.sum()} held out for testing)")
for name in sorted(set(names_own)):
    sel = names_own == name
    print(f"  {name}: {sel.sum()} events ({(sel & held_out).sum()} held out)")

x_fit = np.concatenate([x_train, x_own[~held_out]])
y_fit = np.concatenate([y_train, y_own[~held_out]])
is_own = np.concatenate([np.zeros(len(x_train)), np.ones((~held_out).sum())])

n_pos = y_fit.sum()
weights = np.where(y_fit == 1, (len(y_fit) - n_pos) / n_pos, 1.0)
weights = weights * np.where(is_own == 1, OWN_WEIGHT, 1.0)

mean, std = x_fit.mean(axis=0), x_fit.std(axis=0) + 1e-6
normalize = lambda x: (x - mean) / std

tf.keras.utils.set_random_seed(42)
model = tf.keras.Sequential([
    tf.keras.layers.Input(shape=(x_fit.shape[1],)),
    tf.keras.layers.Dense(16, activation="relu"),
    tf.keras.layers.Dense(8, activation="relu"),
    tf.keras.layers.Dense(1, activation="sigmoid"),
])
model.compile(optimizer="adam", loss="binary_crossentropy")
model.fit(normalize(x_fit), y_fit, sample_weight=weights, epochs=30, batch_size=256,
          validation_data=(normalize(x_val), y_val), verbose=0)

predict = lambda x: model.predict(normalize(x), verbose=0).ravel()

precision, recall, thresholds = precision_recall_curve(y_val, predict(x_val))
threshold = thresholds[np.where(recall[:-1] >= TARGET_RECALL)[0][-1]]
pred_test = predict(x_test) >= threshold
print(f"Threshold {threshold:.3f} | VZCrash test: recall {pred_test[y_test == 1].mean():.1%}, "
      f"false alarms {pred_test[y_test == 0].mean():.1%}")

print("Your held-out recordings (crash verdicts / events):")
scores_own = predict(x_own[held_out])
names_held = names_own[held_out]
for name in sorted(set(names_held)):
    sel = names_held == name
    print(f"  {name}: {(scores_own[sel] >= threshold).sum()} / {sel.sum()}")

for src, backup in [("crash_model.keras", "crash_model_vzcrash.keras"),
                    ("scaler.npz", "scaler_vzcrash.npz")]:
    if os.path.exists(src) and not os.path.exists(backup):
        shutil.copy(src, backup)  # keep the VZCrash-only model
model.save("crash_model.keras")
np.savez("scaler.npz", mean=mean, std=std)

y_held = y_own[held_out]
pred_nn = scores_own >= threshold
print(f"Neural network on your held-out: recall {pred_nn[y_held == 1].mean():.1%}, "
      f"false alarms {pred_nn[y_held == 0].mean():.1%}")

# Baseline: one peak-acceleration threshold, chosen on VZCrash validation
precision_b, recall_b, thresholds_b = precision_recall_curve(y_val, x_val[:, 0])
threshold_b = thresholds_b[np.where(recall_b[:-1] >= TARGET_RECALL)[0][-1]]
pred_b = x_own[held_out][:, 0] >= threshold_b
print(f"Peak threshold {threshold_b:.2f} g on your held-out: recall {pred_b[y_held == 1].mean():.1%}, "
      f"false alarms {pred_b[y_held == 0].mean():.1%}")

own_train = ~held_out
precision_c, recall_c, thresholds_c = precision_recall_curve(y_own[own_train], x_own[own_train][:, 0])
threshold_c = thresholds_c[np.where(recall_c[:-1] >= TARGET_RECALL)[0][-1]]
pred_c = x_own[held_out][:, 0] >= threshold_c
print(f"Peak threshold {threshold_c:.2f} g tuned on your own data: recall {pred_c[y_held == 1].mean():.1%}, "
      f"false alarms {pred_c[y_held == 0].mean():.1%}")

print("Peak acceleration per label (median / 90th percentile / max, in g):")
for name in sorted(set(names_own)):
    peaks = x_own[names_own == name][:, 0]
    print(f"  {name}: {np.median(peaks):.1f} / {np.percentile(peaks, 90):.1f} / {peaks.max():.1f}")
    