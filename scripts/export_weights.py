import re

import numpy as np
import tensorflow as tf

model = tf.keras.models.load_model("models/crash_model.keras")
scaler = np.load("models/scaler.npz")
dense_layers = [layer for layer in model.layers if isinstance(layer, tf.keras.layers.Dense)]
(w1, b1), (w2, b2), (w3, b3) = [layer.get_weights() for layer in dense_layers]

header = open("firmware/crash_detector/model_data.h").read()
threshold = float(re.search(r"CRASH_THRESHOLD = ([0-9.]+)f", header).group(1))

np.savez("backend/app/model_weights.npz", mean=scaler["mean"], std=scaler["std"],
         w1=w1, b1=b1, w2=w2, b2=b2, w3=w3, b3=b3, threshold=threshold)
print("Saved backend/app/model_weights.npz, threshold", threshold)
