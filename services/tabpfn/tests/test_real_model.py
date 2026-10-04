"""Opt-in only: never fetches a checkpoint, never substitutes a fixture model."""

import os

import pytest

from model import configured_predictor
from schemas import PredictResponse


@pytest.mark.skipif(
    os.getenv("TABPFN_TEST_REAL_MODEL") != "true",
    reason="approved local checkpoint / real inference not enabled",
)
def test_real_checkpoint_and_synthetic_inference(payload):
    predictor = configured_predictor()
    assert predictor is not None and predictor.ready, "approved checkpoint failed to load"
    try:
        # Library smoke uses 30 synthetic rows, not seller history.
        rows = payload["trainRows"] * 15
        targets = payload["targets"] * 15
        delta = predictor.predict(rows, targets, payload["queryRow"])
        PredictResponse(
            runId=payload["runId"],
            dataHash=payload["dataHash"],
            modelVersion=predictor.model_version,
            predictedDelta=delta,
            trainingRows=len(rows),
            durationMs=0.0,
        )
    finally:
        predictor.close()
