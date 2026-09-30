"""Single-host durable jobs and atomic artifact metadata."""

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from .config import DATA


@contextmanager
def connect():
    connection = sqlite3.connect(DATA / "jobs.sqlite3")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)"
    )
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def atomic_json(path: Path, value):
    temporary = path.with_name(path.name + "." + uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def job_dir(job_id: str) -> Path:
    # IDs, never user filenames, own directories.
    if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
        raise ValueError("Invalid map identifier.")
    return DATA / job_id


def create_job(name: str, options: dict) -> dict:
    job = {
        "id": uuid4().hex,
        "name": name,
        "options": options,
        "status": "uploading",
        "stage": "Receiving capture",
        "created_at": time.time(),
        "updated_at": time.time(),
        "error": None,
        "scale": None,
    }
    job_dir(job["id"]).mkdir()
    with connect() as connection:
        connection.execute(
            "INSERT INTO jobs VALUES (?, ?)", (job["id"], json.dumps(job))
        )
    return job


def get_job(job_id: str) -> dict:
    job_dir(job_id)
    with connect() as connection:
        row = connection.execute(
            "SELECT payload FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
    if row is None:
        raise KeyError("Map not found.")
    return json.loads(row[0])


def list_jobs() -> list[dict]:
    with connect() as connection:
        rows = connection.execute(
            "SELECT payload FROM jobs ORDER BY rowid DESC"
        ).fetchall()
    return [json.loads(row[0]) for row in rows]


def update_job(job_id: str, **changes) -> dict:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT payload FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        if row is None:
            raise KeyError("Map not found.")
        job = json.loads(row[0]) | changes | {"updated_at": time.time()}
        connection.execute(
            "UPDATE jobs SET payload = ? WHERE id = ?", (json.dumps(job), job_id)
        )
    return job


def recover() -> list[str]:
    queued = []
    for job in list_jobs():
        if job["status"] in {"running", "uploading"}:
            update_job(
                job["id"],
                status="interrupted",
                stage="Interrupted",
                error="The server stopped during this capture. Retry to rebuild from retained uploads.",
            )
        elif job["status"] == "queued":
            queued.append(job["id"])
    return queued


def artifact_dir(job: dict, revision: str | None = None) -> Path:
    root = job_dir(job["id"])
    selected = revision or job.get("artifact_revision")
    if selected:
        if len(selected) != 32 or any(c not in "0123456789abcdef" for c in selected):
            raise ValueError("Invalid artifact revision.")
        return root / "architecture" / selected
    return root


def publish_revision(job_id: str, expected: int, artifact_revision: str, summary: dict):
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT payload FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        if row is None:
            raise KeyError("Map not found.")
        job = json.loads(row[0])
        if job.get("revision", 0) != expected:
            raise ValueError(
                "Revision conflict. Read the current architecture before editing again."
            )
        job |= {
            "revision": expected + 1,
            "artifact_revision": artifact_revision,
            "status": "ready",
            "stage": "Architectural draft ready",
            "error": None,
            "summary": summary,
            "updated_at": time.time(),
        }
        connection.execute(
            "UPDATE jobs SET payload = ? WHERE id = ?", (json.dumps(job), job_id)
        )
    return job
