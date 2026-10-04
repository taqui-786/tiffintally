"""A single, offline CPU worker. Only operator configuration selects weights."""

import hashlib
import importlib.metadata
import math
import multiprocessing
import os
import re
import threading
from pathlib import Path

TABPFN_VERSION = "2.2.1"
CHECKPOINT_NAME = "tabpfn-v2-regressor.ckpt"
# ponytail: one process-wide admission slot; scale with measured need, never Uvicorn workers.
INFERENCE_SLOT = threading.BoundedSemaphore(1)


def load_regressor(checkpoint: Path, digest: str):
    """Verify bytes before the trusted (pickle-based) checkpoint loader is called."""
    if (
        checkpoint.name != CHECKPOINT_NAME
        or not checkpoint.is_file()
        or not re.fullmatch(r"[a-f0-9]{64}", digest)
    ):
        raise ValueError("invalid checkpoint configuration")
    with checkpoint.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != digest:
            raise ValueError("checkpoint digest mismatch")
    if importlib.metadata.version("tabpfn") != TABPFN_VERSION:
        raise ValueError("unsupported model package")

    # These settings live only inside the dedicated worker, before TabPFN imports.
    os.environ["TABPFN_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["OMP_NUM_THREADS"] = "2"
    os.environ["MKL_NUM_THREADS"] = "2"
    import torch
    from tabpfn import TabPFNRegressor
    from tabpfn.base import RegressorModelSpecs
    from tabpfn.model_loading import load_model_criterion_config

    torch.set_num_threads(2)
    weights, criterion, config = load_model_criterion_config(
        model_path=checkpoint,
        check_bar_distribution_criterion=True,
        cache_trainset_representation=False,
        which="regressor",
        version="v2",
        download=False,
    )
    if not isinstance(weights, torch.nn.Module) or not any(
        parameter.numel() for parameter in weights.parameters()
    ):
        raise ValueError("checkpoint weights unavailable")
    # The pinned 2.2.1 constructor accepts loaded RegressorModelSpecs. Passing the
    # loaded weights, rather than a path, also prevents fit() from auto-downloading.
    return TabPFNRegressor(
        model_path=RegressorModelSpecs(weights, config, criterion),
        device="cpu",
        categorical_features_indices=[0, 13],
        n_estimators=4,
        n_jobs=1,
        random_state=0,
        fit_mode="low_memory",
        ignore_pretraining_limits=True,  # API separately enforces <= 2,000 rows.
    )


def _worker(connection, checkpoint: str, digest: str):
    # Do not emit library diagnostics containing operator paths, data or secrets.
    with open(os.devnull, "w") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        regressor = load_regressor(Path(checkpoint), digest)
        import numpy as np

        connection.send(("ready", None))
        while True:
            rows, targets, query = connection.recv()
            try:
                x = np.asarray(
                    [[np.nan if value is None else value for value in row] for row in rows],
                    dtype=float,
                )
                q = np.asarray(
                    [[np.nan if value is None else value for value in query]], dtype=float
                )
                regressor.fit(x, np.asarray(targets, dtype=float))
                prediction = float(regressor.predict(q)[0])
                if not math.isfinite(prediction) or abs(prediction) > 100000:
                    raise ValueError("invalid prediction")
                connection.send(("result", prediction))
            except Exception:
                connection.send(("error", None))
    except (Exception, KeyboardInterrupt):
        try:
            connection.send(("error", None))
        except (BrokenPipeError, OSError):
            pass
    finally:
        connection.close()


class ModelUnavailable(Exception):
    pass


class InferenceTimeout(Exception):
    pass


class WorkerPredictor:
    def __init__(self, checkpoint: Path, digest: str, timeout_seconds: float = 20):
        self.model_version = f"tabpfn-{TABPFN_VERSION}:v2-regressor:sha256:{digest}"
        self.timeout_seconds = timeout_seconds
        context = multiprocessing.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(
            target=_worker, args=(child, str(checkpoint), digest), daemon=True
        )
        self.loaded = False
        self.process.start()
        child.close()
        try:
            if self.connection.poll(60):
                self.loaded = self.connection.recv()[0] == "ready"
        except (EOFError, OSError):
            pass
        if not self.loaded:
            self.close()

    @property
    def ready(self) -> bool:
        return self.loaded and self.process.is_alive()

    def predict(self, rows, targets, query) -> float:
        if not self.ready:
            raise ModelUnavailable()
        try:
            self.connection.send((rows, targets, query))
            if not self.connection.poll(self.timeout_seconds):
                # Terminate and reap before releasing admission; no orphan CPU work.
                self.close()
                raise InferenceTimeout()
            state, value = self.connection.recv()
            if state != "result":
                raise ModelUnavailable()
            return value
        except (EOFError, OSError):
            self.close()
            raise ModelUnavailable() from None

    def close(self):
        self.loaded = False
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join()
        else:
            self.process.join()
        self.connection.close()


def configured_predictor():
    if os.getenv("TABPFN_ENABLE_MODEL") != "true":
        return None
    try:
        path = Path(os.environ["TABPFN_CHECKPOINT_PATH"])
        digest = os.environ["TABPFN_CHECKPOINT_SHA256"]
        timeout = float(os.getenv("TABPFN_INFERENCE_TIMEOUT_SECONDS", "20"))
        if (
            not path.is_absolute()
            or path.name != CHECKPOINT_NAME
            or not path.is_file()
            or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or not math.isfinite(timeout)
            or not 1 <= timeout <= 120
            or os.getenv("TABPFN_DEVICE", "cpu") != "cpu"
        ):
            return None
        return WorkerPredictor(path, digest, timeout)
    except Exception:
        return None
