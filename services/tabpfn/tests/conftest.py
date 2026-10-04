import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import create_app

TOKEN = "synthetic-test-only-token-32-characters"


class FakePredictor:
    """Injected fixture only; never advertised as real model inference."""

    ready = True
    model_version = "fixture-only-not-tabpfn"

    def __init__(self):
        self.calls = []
        self.result = 1.25

    def predict(self, rows, targets, query):
        self.calls.append((rows, targets, query))
        return self.result


@pytest.fixture
def payload():
    return json.loads((Path(__file__).parent / "fixtures/predict.synthetic.json").read_text())


@pytest.fixture
def predictor():
    return FakePredictor()


@pytest.fixture
def client(predictor):
    with TestClient(create_app(predictor=predictor, token=TOKEN)) as test_client:
        test_client.headers.update({"Authorization": f"Bearer {TOKEN}"})
        yield test_client
