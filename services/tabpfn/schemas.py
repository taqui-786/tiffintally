"""Strict mirror of the private Node → Python numeric-only contract."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

FEATURE_NAMES = [
    "weekday",
    "minutesToCutoff",
    "baselineMeals",
    "confirmedMeals",
    "activeCustomers",
    "receivedSourceCount",
    "pauseIntentCount",
    "resumeIntentCount",
    "quantityChangeIntentCount",
    "unclearSourceCount",
    "pendingChangeCount",
    "recentMeanDelta",
    "recentSameWeekdayDelta",
    "messageFeaturesAvailable",
]
MAX_BODY_BYTES = 2 * 1024 * 1024
Number = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-100000, le=100000)]
Row = Annotated[list[Number | None], Field(min_length=14, max_length=14)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class PredictRequest(StrictModel):
    schemaVersion: Literal[1]
    runId: Annotated[str, Field(min_length=1, max_length=128)]
    dataHash: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    featureSchemaVersion: Literal[1]
    model: Literal["tabpfn"]
    featureNames: Annotated[list[str], Field(min_length=14, max_length=14)]
    trainRows: Annotated[list[Row], Field(min_length=2, max_length=2000)]
    targets: Annotated[list[Number], Field(min_length=2, max_length=2000)]
    queryRow: Row

    @field_validator("schemaVersion", "featureSchemaVersion", mode="before")
    @classmethod
    def integer_version(cls, value):
        # Literal[1] otherwise also accepts true/1.0 in Pydantic.
        if type(value) is not int:
            raise ValueError("integer versions required")
        return value

    @model_validator(mode="after")
    def compatible_columns(self) -> Self:
        if self.featureNames != FEATURE_NAMES or len(self.targets) != len(self.trainRows):
            raise ValueError("incompatible feature or target dimensions")
        return self


class PredictResponse(StrictModel):
    schemaVersion: Literal[1] = 1
    runId: str
    dataHash: str
    featureSchemaVersion: Literal[1] = 1
    modelVersion: Annotated[str, Field(min_length=1, max_length=256)]
    predictedDelta: Number
    trainingRows: Annotated[int, Field(ge=2, le=2000)]
    durationMs: Annotated[float, Field(ge=0, le=86400000, allow_inf_nan=False)]
