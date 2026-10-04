"""Private, bounded inference API. Run one Uvicorn worker on loopback."""

import hmac
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from model import INFERENCE_SLOT, InferenceTimeout, ModelUnavailable, configured_predictor
from schemas import MAX_BODY_BYTES, PredictRequest, PredictResponse


def error(status: int, code: str):
    return JSONResponse({"error": {"code": code}}, status_code=status)


def create_app(*, predictor=None, token: str | None = None) -> FastAPI:
    """Only tests explicitly inject a fake predictor; production has no fallback."""

    @asynccontextmanager
    async def lifespan(application):
        configured_token = token if token is not None else os.getenv("TABPFN_SERVICE_TOKEN", "")
        application.state.token = configured_token.encode("utf-8")
        application.state.token_valid = 32 <= len(application.state.token) <= 4096
        application.state.predictor = predictor
        if predictor is None and application.state.token_valid:
            application.state.predictor = await run_in_threadpool(configured_predictor)
        yield
        if predictor is None and application.state.predictor is not None:
            await run_in_threadpool(application.state.predictor.close)

    application = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @application.exception_handler(RequestValidationError)
    @application.exception_handler(ValidationError)
    async def invalid_request(_request, _exception):
        return error(422, "INVALID_REQUEST")

    @application.exception_handler(HTTPException)
    async def http_error(_request, exception):
        return error(exception.status_code, "HTTP_ERROR")

    @application.exception_handler(Exception)
    async def unexpected_error(_request, _exception):
        return error(500, "INTERNAL_ERROR")

    def ready():
        p = application.state.predictor
        return application.state.token_valid and p is not None and p.ready

    @application.get("/health/live")
    async def live():
        return {"status": "ok"}

    @application.get("/health/ready")
    async def readiness():
        return JSONResponse(
            {"status": "ready" if ready() else "unavailable"}, status_code=200 if ready() else 503
        )

    @application.post("/v1/predict")
    async def predict(request: Request):
        if not application.state.token_valid:
            return error(503, "SERVICE_NOT_CONFIGURED")
        authorization = request.headers.get("authorization", "").encode("utf-8")
        expected = b"Bearer " + application.state.token
        if len(authorization) > 4103 or not hmac.compare_digest(authorization, expected):
            return error(401, "UNAUTHORIZED")
        if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
            return error(415, "UNSUPPORTED_MEDIA_TYPE")
        length = request.headers.get("content-length")
        if length is not None:
            try:
                if int(length) < 0:
                    return error(400, "INVALID_REQUEST")
                if int(length) > MAX_BODY_BYTES:
                    return error(413, "BODY_TOO_LARGE")
            except ValueError:
                return error(400, "INVALID_REQUEST")
        body = bytearray()
        try:
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_BODY_BYTES:
                    return error(413, "BODY_TOO_LARGE")
                body.extend(chunk)
            payload = PredictRequest.model_validate_json(body)
        except ValidationError:
            return error(422, "INVALID_REQUEST")
        except Exception:
            return error(400, "INVALID_REQUEST")
        if not ready():
            return error(503, "MODEL_UNAVAILABLE")
        if not INFERENCE_SLOT.acquire(blocking=False):
            return error(429, "INFERENCE_BUSY")
        started = time.perf_counter()
        try:
            p = application.state.predictor
            # Starlette shields thread completion from client cancellation. The
            # admission slot stays held until the worker returns or is terminated.
            delta = await run_in_threadpool(
                p.predict, payload.trainRows, payload.targets, payload.queryRow
            )
            response = PredictResponse(
                runId=payload.runId,
                dataHash=payload.dataHash,
                modelVersion=p.model_version,
                predictedDelta=delta,
                trainingRows=len(payload.trainRows),
                durationMs=(time.perf_counter() - started) * 1000,
            )
            return response.model_dump()
        except InferenceTimeout:
            return error(504, "INFERENCE_TIMEOUT")
        except ModelUnavailable:
            return error(503, "MODEL_UNAVAILABLE")
        except Exception:
            return error(502, "INVALID_MODEL_OUTPUT")
        finally:
            INFERENCE_SLOT.release()

    return application


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8001, workers=1, access_log=False)
