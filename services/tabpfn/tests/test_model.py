import time
from pathlib import Path

import pytest

import model


def sleeping_worker(connection, *_args):
    """No torch/checkpoint; fixture proves OS process termination, not inference."""
    connection.send(("ready", None))
    connection.recv()
    time.sleep(60)


def test_timeout_terminates_and_reaps_worker(monkeypatch):
    monkeypatch.setattr(model, "_worker", sleeping_worker)
    predictor = model.WorkerPredictor(Path("fixture-not-a-checkpoint"), "a" * 64, 0.05)
    assert predictor.ready
    with pytest.raises(model.InferenceTimeout):
        predictor.predict([[0] * 14] * 2, [0, 1], [0] * 14)
    assert not predictor.ready
    assert not predictor.process.is_alive()
    assert predictor.process.exitcode is not None
    predictor.close()


def test_untrusted_checkpoint_rejected_before_heavy_import(tmp_path):
    checkpoint = tmp_path / model.CHECKPOINT_NAME
    checkpoint.write_bytes(b"fixture-only-not-weights")
    with pytest.raises(ValueError, match="digest mismatch"):
        model.load_regressor(checkpoint, "0" * 64)
    with pytest.raises(ValueError, match="configuration"):
        model.load_regressor(tmp_path / "untrusted.ckpt", "0" * 64)


@pytest.mark.parametrize(
    "setting,value",
    [
        ("TABPFN_ENABLE_MODEL", "false"),
        ("TABPFN_CHECKPOINT_PATH", "relative/tabpfn-v2-regressor.ckpt"),
        ("TABPFN_CHECKPOINT_SHA256", "not-a-digest"),
        ("TABPFN_INFERENCE_TIMEOUT_SECONDS", "nan"),
        ("TABPFN_INFERENCE_TIMEOUT_SECONDS", "121"),
        ("TABPFN_DEVICE", "cuda"),
    ],
)
def test_missing_invalid_configuration_never_starts_model(monkeypatch, tmp_path, setting, value):
    checkpoint = tmp_path / model.CHECKPOINT_NAME
    checkpoint.write_bytes(b"fixture-only-not-weights")
    monkeypatch.setenv("TABPFN_ENABLE_MODEL", "true")
    monkeypatch.setenv("TABPFN_CHECKPOINT_PATH", str(checkpoint))
    monkeypatch.setenv("TABPFN_CHECKPOINT_SHA256", "0" * 64)
    monkeypatch.setenv(setting, value)

    def forbidden(*_args):
        pytest.fail("invalid configuration started a model worker")

    monkeypatch.setattr(model, "WorkerPredictor", forbidden)
    assert model.configured_predictor() is None
