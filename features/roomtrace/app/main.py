"""Single-user geometry API. HomeKeeper owns the browser application."""

import hmac
import os
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import pycolmap
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import assets, config, store
from .api import architecture as architecture_routes
from .api import assets as asset_routes
from .api import maps as map_routes


@asynccontextmanager
async def lifespan(app):
    for job_id in store.recover():
        map_routes.worker.submit(map_routes.reconstruct, job_id)
    yield
    map_routes.worker.shutdown(wait=True)


app = FastAPI(title="RoomTrace", lifespan=lifespan)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=os.getenv("APP_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]").split(
        ","
    ),
)


@app.middleware("http")
async def trust_boundary(request: Request, call_next):
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse(
                {"detail": "Cross-origin writes are not allowed."}, status_code=403
            )
    if request.url.path.startswith("/api/") and request.url.path not in {
        "/api/health",
        "/api/session",
    }:
        token = request.cookies.get("roomtrace_access", "") or request.headers.get(
            "authorization", ""
        ).removeprefix("Bearer ")
        if config.ACCESS_TOKEN and not hmac.compare_digest(token, config.ACCESS_TOKEN):
            return JSONResponse(
                {"detail": "Sign in with this server's access token."}, status_code=401
            )
    length = request.headers.get("content-length")
    if length is not None and not length.isdecimal():
        return JSONResponse({"detail": "Invalid Content-Length."}, status_code=400)
    if (
        request.method == "POST"
        and (
            request.url.path in {"/api/maps", "/api/assets", "/api/assets/mesh"}
            or request.url.path.endswith("/localize")
        )
        and length is None
    ):
        return JSONResponse(
            {"detail": "File uploads require Content-Length."}, status_code=411
        )
    if length and int(length) > config.MAX_UPLOAD + 1024 * 1024:
        return JSONResponse(
            {"detail": "Upload exceeds the server size limit."}, status_code=413
        )
    if (
        request.url.path in {"/api/assets", "/api/assets/mesh"}
        and length
        and int(length) > assets.MAX_BYTES + 1024 * 1024
    ):
        return JSONResponse(
            {"detail": "Asset request exceeds 64 MiB."}, status_code=413
        )
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=()"
    if request.url.path.startswith("/api/") and "Cache-Control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "compute_device": config.DEVICE,
        "cuda_available": pycolmap.has_cuda,
        "assistant_transport": "codex_mcp",
        "authentication_required": bool(config.ACCESS_TOKEN),
        "max_images": config.MAX_IMAGES,
        "max_upload_mb": config.MAX_UPLOAD // 1024 // 1024,
    }


class Login(BaseModel):
    token: str = Field(max_length=4096)


@app.post("/api/session")
def login(body: Login, request: Request):
    if not config.ACCESS_TOKEN or not hmac.compare_digest(
        body.token, config.ACCESS_TOKEN
    ):
        raise HTTPException(401, "Invalid access token.")
    response = JSONResponse({"authenticated": True})
    response.set_cookie(
        "roomtrace_access",
        body.token,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
    )
    return response


app.include_router(map_routes.router)
app.include_router(architecture_routes.router)
app.include_router(asset_routes.router)
