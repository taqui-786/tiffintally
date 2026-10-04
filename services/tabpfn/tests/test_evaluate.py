import copy
import json
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from evaluate import EvaluationDataset, evaluate, metrics
from schemas import FEATURE_NAMES


def dataset_json(count=40):
    first = datetime(2026, 1, 1, 9, tzinfo=timezone.utc)
    rows = []
    for index in range(count):
        origin = first + timedelta(days=index)
        rows.append(
            {
                "serviceDate": origin.date().isoformat(),
                "asOf": origin.isoformat(),
                "cutoffAt": (origin + timedelta(hours=2)).isoformat(),
                "outcomeAvailableAt": (origin + timedelta(hours=2)).isoformat(),
                "featuresAvailableAt": origin.isoformat(),
                "features": [origin.weekday(), 120, 100, 99, 40, 3, 1, 0, 1, 0, 1, 2, 2, 1],
                "targetDelta": 2,
            }
        )
    return {
        "schemaVersion": 1,
        "featureSchemaVersion": 1,
        "synthetic": True,
        "policyVersion": "synthetic-only-policy",
        "featuresProvenance": "as_of",
        "featureNames": FEATURE_NAMES,
        "rows": rows,
    }


def test_chronological_ablation_preserves_input_and_matches_origins(predictor):
    body = dataset_json()
    dataset = EvaluationDataset.model_validate_json(json.dumps(body))
    original = copy.deepcopy(dataset)
    result = evaluate(dataset, predictor)
    assert result["synthetic"] is True
    assert result["testDateCount"] == 10
    assert result["trainDateCounts"] == list(range(30, 40))
    assert result["modelVersion"] == "fixture-only-not-tabpfn"
    assert dataset == original
    assert len(predictor.calls) == 20
    for index in range(0, 20, 2):
        no_jev, with_jev = predictor.calls[index : index + 2]
        assert len(no_jev[0]) == len(with_jev[0]) == 30 + index // 2
        assert no_jev[1] == with_jev[1]
        for column in (0, 1, 2, 3, 4, 11, 12):
            assert no_jev[2][column] == with_jev[2][column]
        for column in (5, 6, 7, 8, 9, 10, 13):
            assert no_jev[2][column] is None
            assert all(row[column] is None for row in no_jev[0])
    assert result["systems"]["noChange"]["maeMeals"] == 2
    assert result["systems"]["sameWeekdayMean"]["maeMeals"] == 0
    assert result["systems"]["withJev"]["signedBiasMeals"] == -0.75


def test_future_prior_outcome_excluded_from_both_model_splits(predictor):
    body = dataset_json(42)
    body["rows"][0]["outcomeAvailableAt"] = "2027-01-01T00:00:00+00:00"
    dataset = EvaluationDataset.model_validate_json(json.dumps(body))
    result = evaluate(dataset, predictor)
    assert result["trainDateCounts"][0] == 31
    assert len(predictor.calls[0][0]) == len(predictor.calls[1][0]) == 31


@pytest.mark.parametrize(
    "mutation",
    [
        lambda b: b["rows"].reverse(),
        lambda b: b["rows"][1].update(serviceDate=b["rows"][0]["serviceDate"]),
        lambda b: b["rows"][0].update(featuresAvailableAt="2027-01-01T00:00:00+00:00"),
        lambda b: b["rows"][0].update(asOf="2026-01-01T09:00:00"),
        lambda b: b.update(featuresProvenance="retrospective"),
        lambda b: b.update(synthetic="true"),
    ],
)
def test_bad_evaluation_evidence_rejected(mutation):
    body = dataset_json()
    mutation(body)
    with pytest.raises(ValidationError):
        EvaluationDataset.model_validate_json(json.dumps(body))


def test_provisional_gate_and_availability(predictor):
    with pytest.raises(ValueError, match="insufficient"):
        evaluate(EvaluationDataset.model_validate_json(json.dumps(dataset_json(39))), predictor)
    body = dataset_json()
    body["rows"][0]["outcomeAvailableAt"] = "2027-01-01T00:00:00+00:00"
    with pytest.raises(ValueError, match="available at prediction origin"):
        evaluate(EvaluationDataset.model_validate_json(json.dumps(body)), predictor)
    assert predictor.calls == []


def test_bias_under_over_metrics():
    result = metrics([-2.0, 0.0, 4.0])
    assert result["maeMeals"] == 2
    assert result["signedBiasMeals"] == pytest.approx(2 / 3)
    assert result["underpredictionCount"] == result["overpredictionCount"] == 1
    assert result["meanUnderpredictionMeals"] == pytest.approx(2 / 3)
    assert result["meanOverpredictionMeals"] == pytest.approx(4 / 3)
