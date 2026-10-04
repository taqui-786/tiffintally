# Private TabPFN service

Built with PriorLabs-TabPFN.

Python 3.12, `tabpfn==2.2.1`, v2 `tabpfn-v2-regressor.ckpt`, CPU-only
`torch==2.8.0+cpu`. `uv.lock` locks base, development and optional model
dependencies. No hosted model call, checkpoint download or fake fallback exists.

## Contract checks (no torch or weights)

```sh
cd services/tabpfn
uv sync --locked
uv run --locked pytest
uv run --locked ruff check .
uv run --locked python -m compileall -q app.py schemas.py model.py evaluate.py tests
```

Tests inject `fixture-only-not-tabpfn` explicitly. The real-model smoke is skipped
unless `TABPFN_TEST_REAL_MODEL=true`; contract checks do not establish real model
inference, capacity, latency or forecasting usefulness.

## Operator-approved local model setup

1. Review [Prior Labs' package license](https://priorlabs.ai/tabpfn-license/)
   (2.2.1: Prior Labs License 1.1, Apache-derived with added attribution), and the
   selected [v2 regressor model repository](https://huggingface.co/Prior-Labs/TabPFN-v2-reg)
   terms/access. Preserve notices and required attribution before distribution.
2. Obtain the approved `tabpfn-v2-regressor.ckpt` separately from an immutable
   trusted source revision. This project supplies no weights and assumes no
   approval or gate acceptance. Record that revision and independently verified
   SHA-256; checkpoints use a pickle-based loader and must never be uploads.
3. Mount it read-only in the private runtime. Install optional model dependencies
   only on approved hardware: `uv sync --locked --extra model`. The explicit
   PyTorch CPU index avoids CUDA dependencies.
4. Configure the following in the service's private environment (no real secrets
   in shell history or committed files):

| Variable | Requirement |
| --- | --- |
| `TABPFN_SERVICE_TOKEN` | Private shared bearer credential, 32–4096 UTF-8 bytes |
| `TABPFN_ENABLE_MODEL` | Exactly `true` to opt into loading |
| `TABPFN_CHECKPOINT_PATH` | Absolute, trusted local path ending in `tabpfn-v2-regressor.ckpt` |
| `TABPFN_CHECKPOINT_SHA256` | Approved lowercase 64-character digest; checked before loading |
| `TABPFN_DEVICE` | Optional; only `cpu` is supported |
| `TABPFN_INFERENCE_TIMEOUT_SECONDS` | Default 20; finite 1–120 seconds |
| `TABPFN_TEST_REAL_MODEL` | Exactly `true` only for an approved real smoke test |

```sh
uv run --locked --extra model python app.py
# Opt-in, synthetic inputs, after the environment and checkpoint are approved:
uv run --locked --extra model pytest tests/test_real_model.py
```

`python app.py` binds only `127.0.0.1:8001`, uses one Uvicorn worker and disables
access logs. Keep it private. Use TLS on untrusted links. Do not increase Uvicorn
workers: the admission semaphore is process-global, not a distributed lock.
The API disables `/docs`, `/redoc` and `/openapi.json`; it has no training/upload
or arbitrary path/model endpoint. Do not enable payload/header/exception logging.

`GET /health/live` only reports process liveness. `GET /health/ready` is 200 only
with a valid credential and a live worker that has verified and actually loaded
approved weights/criterion. Startup load is bounded to 60 seconds. Invalid or
missing settings/weights give generic 503 readiness, with no fit/predict on GET.

`POST /v1/predict` requires `Authorization: Bearer …` and `application/json`.
Authentication precedes body parsing; both declared and streamed body sizes are
bounded to 2 MiB. `schemas.py` defines exact camelCase versions, ordered 14
features, 2–2000 rows, nullable finite numeric cells and matched finite targets.
Numbers and output deltas are bounded to ±100000. Unknown fields are rejected.
Errors contain only an allowlisted code. `tests/fixtures/predict.synthetic.json`
is the shared synthetic wire fixture; missing numeric features are JSON `null`.

Each accepted call fits and predicts in one dedicated spawned process, with two
torch CPU threads, one preprocessing job, four estimators and a fixed seed.
Repeated run IDs are **not** deduplicated here: Node owns idempotency/persistence.
Concurrent inference is rejected with 429. The parent enforces a real worker
timeout, terminates/reaps the process before releasing admission, returns 504,
and stays unready until an operator restarts the service. It never restarts or
retries inference automatically. A client HTTP timeout/disconnect is not itself
cancellation; Node must preserve uncertain run status and query its stored run.
For a stuck service, stop/restart the managed service process; the worker is
daemonized. Size the runtime's OS/container RAM and CPU limits after measuring
the approved checkpoint. No capacity on free/shared hosting is claimed. CPU
2,000-row inference may exceed budget; that fails the synchronous runtime gate.

## Offline chronological evaluation

```sh
uv run --locked --extra model python evaluate.py /approved/private/history.json
```

Input is a bounded JSON object with `schemaVersion: 1`, `featureSchemaVersion: 1`,
explicit `synthetic: true|false`, a single `policyVersion`,
`featuresProvenance: "as_of"`, exact `featureNames` and chronological unique
`rows`. Each row supplies `serviceDate`, aware `asOf`, `cutoffAt`,
`outcomeAvailableAt`, `featuresAvailableAt`, the immutable 14-cell `features`
and finite `targetDelta`. Only comparable, complete, as-of evidence belongs in
this input. Late/backfilled classification features must not be relabelled
as-of. The evaluator verifies declared timestamps; source provenance is owned
by the Node history builder, not reconstructed in Python.

The final 10 dates are rolling-origin tests; each system gets the same earlier
rows whose outcomes were available at that origin, with at least 30 eligible
training dates. Supplied time/history features are kept immutable, not recomputed
from future outcomes. Baselines are zero change and the last six available
same-weekday deltas. No-JEV masks source/intent/review counts and message
availability as missing; with-JEV uses the supplied features. All preprocessing
is fitted inside TabPFN on each training split. No random shuffle or holdout
tuning occurs. JSON output reports MAE, signed bias, under/over counts and meal
magnitudes, weekday metrics when n≥3, missingness, eligible counts, inference
latency, hash, synthetic flag and package/checkpoint identity. There is no
automatic validation gate or improvement claim; real history evaluation remains
an operator task.

## Current verification gap

The pinned package constructor/loader/fit/predict signatures were checked against
the published 2.2.1 wheel and current Context7 documentation. No approved
checkpoint was provided, no torch/model installation was performed, and real
weight loading/inference is untested. Package/checkpoint licensing, checkpoint
source revision/hash, hardware capacity and real forecasting usefulness still
need operator approval and the opt-in smoke/evaluation above.
