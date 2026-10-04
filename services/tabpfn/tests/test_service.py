import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app import create_app
from model import InferenceTimeout
from schemas import MAX_BODY_BYTES, PredictResponse
from tests.conftest import TOKEN


def test_contract_and_health(client, predictor, payload):
    assert client.get("/health/live").json() == {"status": "ok"}
    assert client.get("/health/ready").status_code == 200
    assert predictor.calls == []  # Health never fits or predicts.
    response = client.post("/v1/predict", json=payload)
    assert response.status_code == 200
    result = PredictResponse.model_validate(response.json())
    assert result.runId == payload["runId"]
    assert result.dataHash == payload["dataHash"]
    assert result.predictedDelta == 1.25 and result.trainingRows == 2
    assert result.modelVersion == "fixture-only-not-tabpfn"
    assert predictor.calls[0][0][0][11] is None
    for route in ("/docs", "/redoc", "/openapi.json", "/fit", "/train"):
        assert client.get(route).status_code == 404


@pytest.mark.parametrize("authorization", ["", "Bearer wrong", "Bearer " + "x" * 5000])
def test_auth_before_parsing(client, predictor, authorization):
    response = client.post(
        "/v1/predict", content=b"malformed-private-marker", headers={"Authorization": authorization}
    )
    assert response.status_code == 401
    assert "private-marker" not in response.text
    assert predictor.calls == []


@pytest.mark.parametrize("token", ["", "short"])
def test_token_config_required(predictor, token):
    with TestClient(create_app(predictor=predictor, token=token)) as client:
        assert client.get("/health/live").status_code == 200
        assert client.get("/health/ready").status_code == 503
        assert client.post("/v1/predict").status_code == 503
    assert predictor.calls == []


def test_no_boot_model_without_opt_in(monkeypatch, payload):
    monkeypatch.delenv("TABPFN_ENABLE_MODEL", raising=False)
    with TestClient(create_app(token=TOKEN)) as client:
        assert client.get("/health/ready").status_code == 503
        assert (
            client.post(
                "/v1/predict", json=payload, headers={"Authorization": f"Bearer {TOKEN}"}
            ).status_code
            == 503
        )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p: p.update(checkpointPath="/private/model"),
        lambda p: p.update(model="https://untrusted.example/model"),
        lambda p: p.update(schemaVersion=True),
        lambda p: p.update(featureSchemaVersion=1.0),
        lambda p: p.update(dataHash="not-a-hash"),
        lambda p: p.update(runId=""),
        lambda p: p["featureNames"].reverse(),
        lambda p: p["trainRows"].pop(),
        lambda p: p["trainRows"][0].pop(),
        lambda p: p["queryRow"].append(1),
        lambda p: p["targets"].append(3),
        lambda p: p["queryRow"].__setitem__(0, "2"),
        lambda p: p["queryRow"].__setitem__(0, True),
        lambda p: p["queryRow"].__setitem__(0, float("nan")),
        lambda p: p["targets"].__setitem__(0, float("inf")),
        lambda p: p["targets"].__setitem__(0, 100001),
        lambda p: p.update(trainRows=[p["queryRow"]] * 2001, targets=[0] * 2001),
    ],
)
def test_invalid_contract_is_sanitized(client, predictor, payload, mutation):
    mutation(payload)
    response = client.post(
        "/v1/predict", content=json.dumps(payload), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert response.json() == {"error": {"code": "INVALID_REQUEST"}}
    assert predictor.calls == []


def test_malformed_and_size(client, predictor):
    assert (
        client.post(
            "/v1/predict", content="{bad", headers={"Content-Type": "application/json"}
        ).status_code
        == 422
    )
    assert client.post("/v1/predict", content="{}").status_code == 415
    assert (
        client.post(
            "/v1/predict",
            content="{}",
            headers={"Content-Type": "application/json", "Content-Length": str(MAX_BODY_BYTES + 1)},
        ).status_code
        == 413
    )

    # A chunked stream with no content-length must still be bounded.
    def chunks():
        yield b" " * MAX_BODY_BYTES
        yield b"x"

    assert (
        client.post(
            "/v1/predict", content=chunks(), headers={"Content-Type": "application/json"}
        ).status_code
        == 413
    )
    assert predictor.calls == []


def test_one_inference_at_a_time(client, predictor, payload):
    entered = threading.Event()
    release = threading.Event()

    def blocked(*_args):
        entered.set()
        assert release.wait(5)
        return 0.0

    predictor.predict = blocked
    with ThreadPoolExecutor() as pool:
        first = pool.submit(client.post, "/v1/predict", json=payload)
        assert entered.wait(5)
        try:
            assert client.post("/v1/predict", json=payload).status_code == 429
            assert client.get("/health/live").status_code == 200
        finally:
            release.set()
        assert first.result().status_code == 200
    assert client.post("/v1/predict", json=payload).status_code == 200


@pytest.mark.parametrize("prediction", [float("nan"), float("inf"), 100001, "1", True])
def test_invalid_model_output(client, predictor, payload, prediction):
    predictor.result = prediction
    response = client.post("/v1/predict", json=payload)
    assert response.status_code == 502
    assert response.json() == {"error": {"code": "INVALID_MODEL_OUTPUT"}}


def test_timeout_sanitized_and_slot_released(client, predictor, payload):
    def timeout(*_args):
        predictor.ready = False
        raise InferenceTimeout("do-not-disclose-private-marker")

    predictor.predict = timeout
    response = client.post("/v1/predict", json=payload)
    assert response.status_code == 504
    assert "private-marker" not in response.text
    assert client.get("/health/ready").status_code == 503


def test_failure_does_not_log_or_echo_payload(client, predictor, payload, caplog):
    def failed(*_args):
        raise RuntimeError("private-marker-model-payload")

    predictor.predict = failed
    response = client.post("/v1/predict", json=payload)
    assert response.status_code == 502
    assert "private-marker" not in response.text + caplog.text
