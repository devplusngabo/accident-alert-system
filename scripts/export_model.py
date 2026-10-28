import numpy as np
import tensorflow as tf
from sklearn.metrics import precision_recall_curve

PROC = "./processed"
TRAIN = ["train-00004-of-00011", "train-00006-of-00011", "train-00007-of-00011"]
VAL = "validation-00001-of-00003"
TEST = "test-00000-of-00002"
TARGET_RECALL = 0.90
OUT_HEADER = "model_data.h"


def c_array(name, values):
    flat = np.asarray(values, dtype=np.float32).ravel()
    body = ", ".join(f"{v:.8e}f" for v in flat)
    return f"const float {name}[{flat.size}] = {{{body}}};\n"


model = tf.keras.models.load_model("crash_model.keras")
scaler = np.load("scaler.npz")
mean, std = scaler["mean"], scaler["std"]
normalize = lambda x: (x - mean) / std

# TFLite file, only to report the model size
tflite = tf.lite.TFLiteConverter.from_keras_model(model).convert()
with open("crash_model.tflite", "wb") as f:
    f.write(tflite)
print("TFLite size:", len(tflite), "bytes")

# Decision threshold: 90% recall on validation
val = np.load(f"{PROC}/{VAL}.npz")
y_val = (val["labels"] == 0).astype(int)
scores = model.predict(normalize(val["features"]), verbose=0).ravel()
precision, recall, thresholds = precision_recall_curve(y_val, scores)
threshold = float(thresholds[np.where(recall[:-1] >= TARGET_RECALL)[0][-1]])
print("Decision threshold:", round(threshold, 4))

# Help choosing the trigger: peak jerk (g/s) of training crashes
train = [np.load(f"{PROC}/{n}.npz") for n in TRAIN]
crash_jerk = np.concatenate([t["features"][t["labels"] == 0][:, 5] for t in train])
print("Crash peak jerk percentiles (1, 5, 25, 50):", np.percentile(crash_jerk, [1, 5, 25, 50]).round(1))

# Two test windows (one crash, one normal) to compare C++ against Python
test = np.load(f"{PROC}/{TEST}.npz")
idx = [int(np.where(test["labels"] == 0)[0][0]), int(np.where(test["labels"] == 2)[0][0])]
test_windows = test["windows"][idx]
test_features = test["features"][idx]
test_prob = model.predict(normalize(test_features), verbose=0).ravel()

dense = [layer for layer in model.layers if isinstance(layer, tf.keras.layers.Dense)]
(w1, b1), (w2, b2), (w3, b3) = [layer.get_weights() for layer in dense]

# Bias arrays are named BIAS1..3 because Arduino already defines B1, B2 and B3
with open(OUT_HEADER, "w") as f:
    f.write("#pragma once\n\n")
    f.write(f"const int N_FEATURES = {len(mean)};\n")
    f.write(f"const float CRASH_THRESHOLD = {threshold:.6f}f;\n\n")
    for name, arr in [("MEAN", mean), ("STD", std), ("W1", w1), ("BIAS1", b1),
                      ("W2", w2), ("BIAS2", b2), ("W3", w3), ("BIAS3", b3),
                      ("TEST_WINDOWS", test_windows), ("TEST_FEATURES", test_features),
                      ("TEST_PROB", test_prob)]:
        f.write(c_array(name, arr))
print("Wrote", OUT_HEADER)
