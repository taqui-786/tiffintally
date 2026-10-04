"""Offline rolling-origin comparison; consumes immutable, declared as-of features."""

import argparse
import hashlib
import json
import statistics
import time
from datetime import date, datetime
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from model import configured_predictor
from schemas import FEATURE_NAMES, MAX_BODY_BYTES, Number, Row, StrictModel


class EvaluationRow(StrictModel):
    serviceDate: date
    asOf: datetime
    cutoffAt: datetime
    outcomeAvailableAt: datetime
    featuresAvailableAt: datetime
    features: Row
    targetDelta: Number

    @model_validator(mode="after")
    def availability(self) -> Self:
        timestamps = (self.asOf, self.cutoffAt, self.outcomeAvailableAt, self.featuresAvailableAt)
        if any(value.utcoffset() is None for value in timestamps):
            raise ValueError("timezone-aware evidence required")
        if not (self.featuresAvailableAt <= self.asOf < self.cutoffAt <= self.outcomeAvailableAt):
            raise ValueError("invalid evidence availability")
        return self


class EvaluationDataset(StrictModel):
    schemaVersion: Literal[1]
    featureSchemaVersion: Literal[1]
    synthetic: bool
    policyVersion: Annotated[str, Field(min_length=1, max_length=100)]
    featuresProvenance: Literal["as_of"]
    featureNames: list[str]
    rows: Annotated[list[EvaluationRow], Field(min_length=2, max_length=2000)]

    @model_validator(mode="after")
    def chronological(self) -> Self:
        dates = [row.serviceDate for row in self.rows]
        origins = [row.asOf for row in self.rows]
        if (
            self.featureNames != FEATURE_NAMES
            or dates != sorted(set(dates))
            or origins != sorted(set(origins))
        ):
            raise ValueError("ordered unique service dates and origins required")
        return self


def metrics(errors: list[float]):
    return {
        "count": len(errors),
        "maeMeals": statistics.fmean(abs(value) for value in errors),
        "signedBiasMeals": statistics.fmean(errors),
        "underpredictionCount": sum(value < 0 for value in errors),
        "overpredictionCount": sum(value > 0 for value in errors),
        "meanUnderpredictionMeals": statistics.fmean(max(-value, 0) for value in errors),
        "meanOverpredictionMeals": statistics.fmean(max(value, 0) for value in errors),
    }


def without_messages(features):
    # Preserve the wire schema and caller's immutable rows; exclude JEV/source/review
    # counts and their availability flag rather than fabricating zero counts.
    return [
        None if index in (5, 6, 7, 8, 9, 10, 13) else value for index, value in enumerate(features)
    ]


def evaluate(dataset: EvaluationDataset, predictor, *, holdout=10, minimum_train=30):
    if len(dataset.rows) < minimum_train + holdout:
        raise ValueError("insufficient eligible chronological history")
    if not predictor.ready:
        raise ValueError("approved checkpoint not ready")
    errors = {name: [] for name in ("noChange", "sameWeekdayMean", "noJev", "withJev")}
    by_weekday = {name: {} for name in errors}
    train_counts = []
    inference_ms = {"noJev": [], "withJev": []}
    for index in range(len(dataset.rows) - holdout, len(dataset.rows)):
        query = dataset.rows[index]
        train = [row for row in dataset.rows[:index] if row.outcomeAvailableAt <= query.asOf]
        if len(train) < minimum_train:
            raise ValueError("insufficient outcomes available at prediction origin")
        train_counts.append(len(train))
        same_weekday = [row.targetDelta for row in train if row.features[0] == query.features[0]][
            -6:
        ]
        predictions = {
            "noChange": 0.0,
            "sameWeekdayMean": statistics.fmean(same_weekday) if same_weekday else 0.0,
        }
        for name, transform in (("noJev", without_messages), ("withJev", list)):
            started = time.perf_counter()
            predictions[name] = predictor.predict(
                [transform(row.features) for row in train],
                [row.targetDelta for row in train],
                transform(query.features),
            )
            inference_ms[name].append((time.perf_counter() - started) * 1000)
            # Validate the same finite, bounded output accepted by the service.
            from schemas import PredictResponse

            PredictResponse(
                runId="offline-evaluation",
                dataHash="0" * 64,
                modelVersion=predictor.model_version,
                predictedDelta=predictions[name],
                trainingRows=len(train),
                durationMs=inference_ms[name][-1],
            )
        for name, prediction in predictions.items():
            residual = prediction - query.targetDelta
            errors[name].append(residual)
            weekday = str(query.features[0])
            by_weekday[name].setdefault(weekday, []).append(residual)
    systems = {}
    for name, residuals in errors.items():
        systems[name] = metrics(residuals)
        systems[name]["byWeekday"] = {
            day: metrics(values) for day, values in by_weekday[name].items() if len(values) >= 3
        }
        if name in inference_ms:
            systems[name]["meanInferenceMs"] = statistics.fmean(inference_ms[name])
    return {
        "schemaVersion": 1,
        "featureSchemaVersion": 1,
        "modelVersion": predictor.model_version,
        "synthetic": dataset.synthetic,
        "policyVersion": dataset.policyVersion,
        "featuresProvenance": dataset.featuresProvenance,
        "split": "rolling_origin_final_holdout",
        "eligibleDateCount": len(dataset.rows),
        "testDateCount": holdout,
        "trainDateCounts": train_counts,
        "missingFeatureCellCount": sum(
            value is None for row in dataset.rows for value in row.features
        ),
        "sameWeekdayLookback": 6,
        "systems": systems,
        "compute": "local_cpu",
        "externalInferenceCost": 0,
        "note": (
            "Small holdout; no operational validation or improvement claim. "
            "Synthetic data demonstrates plumbing only. Availability is declared input evidence."
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    args = parser.parse_args()
    predictor = None
    try:
        with args.dataset.open("rb") as source:
            body = source.read(MAX_BODY_BYTES + 1)
        if len(body) > MAX_BODY_BYTES:
            raise ValueError("dataset too large")
        dataset = EvaluationDataset.model_validate_json(body)
        predictor = configured_predictor()
        if predictor is None:
            raise ValueError("approved model configuration required")
        result = evaluate(dataset, predictor)
        result["dataHash"] = hashlib.sha256(body).hexdigest()
        print(json.dumps(result, allow_nan=False))
    except Exception:
        parser.exit(
            1, "Evaluation unavailable: check dataset eligibility and approved checkpoint.\n"
        )
    finally:
        if predictor is not None:
            predictor.close()


if __name__ == "__main__":
    main()
