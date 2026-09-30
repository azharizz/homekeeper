"""Server-only configuration. Never serialize the settings object."""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT.parents[1] / ".env", override=False)
DATA = Path(os.getenv("ROOMTRACE_DATA", str(ROOT / "data"))).resolve()
DATA.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD = int(os.getenv("MAX_UPLOAD_MB", "512")) * 1024 * 1024
MAX_IMAGES = 12
IMAGE_SIZE = int(os.getenv("MAX_IMAGE_SIZE", "1600"))
DENSE_SIZE = int(os.getenv("DENSE_IMAGE_SIZE", "640"))
THREADS = int(os.getenv("WORKER_THREADS", "4"))
DEVICE = os.getenv("COMPUTE_DEVICE", "cpu")
DEPTH_DEVICE = os.getenv("DEPTH_DEVICE", "cpu")
ACCESS_TOKEN = os.getenv("HOMEKEEPER_TOKEN", "")
HOST = os.getenv("ROOMTRACE_HOST", "127.0.0.1")

if DEVICE not in {"cpu", "cuda"} or DEPTH_DEVICE not in {"cpu", "cuda", "mps"}:
    raise ValueError(
        "Use cpu/cuda for COMPUTE_DEVICE and cpu/cuda/mps for DEPTH_DEVICE."
    )
if HOST not in {"127.0.0.1", "localhost", "::1"} and len(ACCESS_TOKEN) < 32:
    raise ValueError(
        "Nonlocal hosting requires HOMEKEEPER_TOKEN with at least 32 characters."
    )
