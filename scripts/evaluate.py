import numpy as np
import tensorflow as tf
from sklearn.metrics import average_precision_score, precision_recall_curve

PROC = "./processed"
TRAIN = ["train-00004-of-00011", "train-00006-of-00011", "train-00007-of-00011"]
VAL = ["validation-00001-of-00003"]
TEST = ["test-00000-of-00002", "test-00001-of-00002"]
TARGET_RECALL = 0.90


def load(names):
    parts = [np.load(f"{PROC}/{n}.npz") for n in names]
    features = np.concatenate([p["features"] for p in parts])
    is_crash = (np.concatenate([p["labels"] for p in parts]) == 0).astype(int)
    return features, is_crash


def report(name, y_val, s_val, y_test, s_test):
    precision, recall, thresholds = precision_recall_curve(y_val, s_val)
    threshold = thresholds[np.where(recall[:-1] >= TARGET_RECALL)[0][-1]]
    pred = s_test >= threshold
    tp = (pred & (y_test == 1)).sum()
    fp = (pred & (y_test == 0)).sum()
    print(f"{name}: AP {average_precision_score(y_test, s_test):.3f} | "
          f"recall {tp / (y_test == 1).sum():.1%} | precision {tp / max(tp + fp, 1):.1%} | "
          f"false alarms {fp / (y_test == 0).sum():.1%} of non-crash events")
    return pred


x_train, y_train = load(TRAIN)
x_val, y_val = load(VAL)
x_test, y_test = load(TEST)

# Baseline: peak acceleration (feature 0) against one threshold
report("Threshold baseline", y_val, x_val[:, 0], y_test, x_test[:, 0])

# Small neural network on the 11 features
mean, std = x_train.mean(axis=0), x_train.std(axis=0) + 1e-6
normalize = lambda x: (x - mean) / std

model = tf.keras.Sequential([
    tf.keras.layers.Input(shape=(x_train.shape[1],)),
    tf.keras.layers.Dense(16, activation="relu"),
    tf.keras.layers.Dense(8, activation="relu"),
    tf.keras.layers.Dense(1, activation="sigmoid"),
])
model.compile(optimizer="adam", loss="binary_crossentropy")

n_pos = y_train.sum()
class_weight = {0: 1.0, 1: (len(y_train) - n_pos) / n_pos}
model.fit(normalize(x_train), y_train, epochs=30, batch_size=256, class_weight=class_weight,
          validation_data=(normalize(x_val), y_val), verbose=2)

pred_nn = report("Small neural network", y_val, model.predict(normalize(x_val)).ravel(),
                 y_test, model.predict(normalize(x_test)).ravel())

# Shortcut check: results should be similar for standard and HD gyro events
hd_test = np.concatenate([np.load(f"{PROC}/{n}.npz")["gyro_is_hd"] for n in TEST])
for hd in (False, True):
    group = hd_test == hd
    crash = group & (y_test == 1)
    other = group & (y_test == 0)
    print(f"gyro_is_hd={hd}: events {group.sum()} | recall {pred_nn[crash].mean():.1%} | "
          f"false alarms {pred_nn[other].mean():.1%}")

np.savez("scaler.npz", mean=mean, std=std)  # needed later on the Nano
model.save("crash_model.keras")
