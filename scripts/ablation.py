import numpy as np
import tensorflow as tf
from sklearn.metrics import average_precision_score, precision_recall_curve

PROC = "./processed"
TRAIN = ["train-00004-of-00011", "train-00006-of-00011", "train-00007-of-00011"]
VAL = ["validation-00001-of-00003"]
TEST = ["test-00000-of-00002", "test-00001-of-00002"]
TARGET_RECALL = 0.90
GYRO_FEATURES = [6, 7, 8, 10]


def load(names):
    parts = [np.load(f"{PROC}/{n}.npz") for n in names]
    features = np.concatenate([p["features"] for p in parts])
    is_crash = (np.concatenate([p["labels"] for p in parts]) == 0).astype(int)
    is_hd = np.concatenate([p["gyro_is_hd"] for p in parts])
    return features, is_crash, is_hd


def report(name, y_val, s_val, y_test, s_test, hd_test):
    precision, recall, thresholds = precision_recall_curve(y_val, s_val)
    threshold = thresholds[np.where(recall[:-1] >= TARGET_RECALL)[0][-1]]
    pred = s_test >= threshold
    tp = (pred & (y_test == 1)).sum()
    fp = (pred & (y_test == 0)).sum()
    print(f"{name}: AP {average_precision_score(y_test, s_test):.3f} | "
          f"recall {tp / (y_test == 1).sum():.1%} | precision {tp / max(tp + fp, 1):.1%} | "
          f"false alarms {fp / (y_test == 0).sum():.1%}")
    for hd in (False, True):
        group = hd_test == hd
        crash = group & (y_test == 1)
        other = group & (y_test == 0)
        print(f"   gyro_is_hd={hd}: recall {pred[crash].mean():.1%} | false alarms {pred[other].mean():.1%}")


def train_and_report(name, columns, data):
    x_train, y_train, x_val, y_val, x_test, y_test, hd_test = data
    x_train, x_val, x_test = x_train[:, columns], x_val[:, columns], x_test[:, columns]

    mean, std = x_train.mean(axis=0), x_train.std(axis=0) + 1e-6
    normalize = lambda x: (x - mean) / std

    tf.keras.utils.set_random_seed(42)
    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(len(columns),)),
        tf.keras.layers.Dense(16, activation="relu"),
        tf.keras.layers.Dense(8, activation="relu"),
        tf.keras.layers.Dense(1, activation="sigmoid"),
    ])
    model.compile(optimizer="adam", loss="binary_crossentropy")

    n_pos = y_train.sum()
    class_weight = {0: 1.0, 1: (len(y_train) - n_pos) / n_pos}
    model.fit(normalize(x_train), y_train, epochs=30, batch_size=256,
              class_weight=class_weight, validation_data=(normalize(x_val), y_val), verbose=0)

    report(name, y_val, model.predict(normalize(x_val), verbose=0).ravel(),
           y_test, model.predict(normalize(x_test), verbose=0).ravel(), hd_test)


x_train, y_train, _ = load(TRAIN)
x_val, y_val, _ = load(VAL)
x_test, y_test, hd_test = load(TEST)
data = (x_train, y_train, x_val, y_val, x_test, y_test, hd_test)

all_columns = list(range(x_train.shape[1]))
no_gyro_columns = [c for c in all_columns if c not in GYRO_FEATURES]

train_and_report("All 11 features", all_columns, data)
train_and_report("Without gyro features", no_gyro_columns, data)
