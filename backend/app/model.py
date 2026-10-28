import os

import numpy as np

FS = 100
_params = np.load(os.path.join(os.path.dirname(__file__), "model_weights.npz"))
MEAN, STD = _params["mean"], _params["std"]
W1, B1, W2, B2, W3, B3 = (_params[k] for k in ("w1", "b1", "w2", "b2", "w3", "b3"))
THRESHOLD = float(_params["threshold"])


def make_features(window):
    a, w = window[:, 0], window[:, 1]
    jerk = np.abs(np.diff(a)) * FS
    return np.array([
        a.max(), a.min(), a.mean(), a.std(), np.sqrt(np.mean((a - 1) ** 2)),
        jerk.max(), w.max(), w.mean(), w.std(),
        a[-50:].std(), w[-50:].mean(),
    ], dtype=np.float32)


def predict_window(rows):
    window = np.asarray(rows, dtype=np.float32)
    x = (make_features(window) - MEAN) / STD
    h1 = np.maximum(x @ W1 + B1, 0)
    h2 = np.maximum(h1 @ W2 + B2, 0)
    probability = float(1 / (1 + np.exp(-(h2 @ W3 + B3)[0])))
    return {"probability": probability, "is_crash": probability >= THRESHOLD, "threshold": THRESHOLD}
