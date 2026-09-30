"""One server, one reconstruction worker. Configuration comes from the project .env."""

import os

import uvicorn

from app import config

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=config.HOST,
        port=int(os.getenv("ROOMTRACE_PORT", "8790")),
        workers=1,
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1",
    )
