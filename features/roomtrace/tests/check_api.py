"""Run trust-boundary checks in-process without replacing reconstruction or provider behavior."""

import asyncio
import secrets
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config
from app.main import app
from app import store


async def main():
    config.ACCESS_TOKEN = secrets.token_urlsafe(32)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://localhost", timeout=None
    ) as client:
        assert (await client.get("/api/health")).status_code == 200
        assert (await client.get("/api/health")).json()[
            "assistant_transport"
        ] == "codex_mcp"
        assert (await client.get("/api/maps")).status_code == 401
        assert (
            await client.post("/api/session", json={"token": "wrong"})
        ).status_code == 401
        response = await client.post(
            "/api/session", json={"token": config.ACCESS_TOKEN}
        )
        assert (
            response.status_code == 200 and "HttpOnly" in response.headers["set-cookie"]
        )
        assert (await client.get("/api/maps")).status_code == 200
        observed = next(
            (
                job
                for job in store.list_jobs()
                if job["status"] == "ready"
                and any((store.job_dir(job["id"]) / "queries").glob("*.json"))
            ),
            None,
        )
        if observed:
            base = f"/api/maps/{observed['id']}/observations/"
            latest = await client.get(base + "latest")
            assert latest.status_code == 200
            assert (
                await client.get(base + latest.json()["query_id"])
            ).json() == latest.json()
            assert (
                await client.get(base + latest.json()["query_id"] + "/image")
            ).headers["content-type"] == "image/jpeg"
            assert (await client.get(base + "invalid")).status_code == 404
            async with httpx.AsyncClient(
                transport=transport, base_url="http://localhost", timeout=None
            ) as stranger:
                assert (await stranger.get(base + "latest")).status_code == 401
                assert (await stranger.get(base + "latest/image")).status_code == 401
        assert (
            await client.post(
                "/api/maps",
                headers={"origin": "https://untrusted.example"},
                files={"files": ("test.png", b"bad")},
            )
        ).status_code == 403
        assert (await client.get("/api/maps/not-an-id")).status_code == 404
        assert (
            await client.post("/api/maps", files={"files": ("script.html", b"<html>")})
        ).status_code == 422
        assert (
            await client.post(
                "/api/maps",
                files={"files": ("image.png", b"bad")},
                data={
                    "calibration": '{"model":"NO_SUCH_CAMERA","width":640,"height":480,"params":[1]}'
                },
            )
        ).status_code == 422
        assert (
            await client.post(
                "/api/maps",
                content=b"",
                headers={"content-length": str(config.MAX_UPLOAD + 2 * 1024**2)},
            )
        ).status_code == 413
        assert (
            await client.get("/api/maps", headers={"host": "attacker.example"})
        ).status_code == 400
        assert (
            await client.post(
                "/api/maps", content=b"", headers={"content-length": "invalid"}
            )
        ).status_code == 400
        assert "NEBIUS_API_KEY" not in (await client.get("/api/health")).text
        assert not any(
            getattr(route, "path", "").endswith("/agent") for route in app.routes
        )
        for count in [2, 3, 13]:
            assert (
                await client.post(
                    "/api/maps",
                    files=[("files", (f"{i}.png", b"bad")) for i in range(count)],
                )
            ).status_code == 422
        assert (
            await client.post(
                "/api/maps",
                files={"files": ("image.png", b"bad")},
                data={"engine": "imaginary"},
            )
        ).status_code == 422
        malformed = await client.post(
            "/api/maps",
            files={"files": ("broken.png", b"not an image")},
            data={"engine": "mapanything"},
        )
        assert malformed.status_code == 202
        identifier = malformed.json()["id"]
        while store.get_job(identifier)["status"] in {"queued", "running"}:
            await asyncio.sleep(0.05)
        assert store.get_job(identifier)["status"] == "failed"
        assert "cannot be decoded" in store.get_job(identifier)["error"]
        # Remove this test-owned invalid upload and row, leaving real captures intact.
        import shutil

        shutil.rmtree(store.job_dir(identifier))
        with store.connect() as connection:
            connection.execute("DELETE FROM jobs WHERE id = ?", (identifier,))
        config.ACCESS_TOKEN = ""
    print(
        "PASS: authentication, cookie, origin, host, size, type, camera and path boundaries"
    )


if __name__ == "__main__":
    asyncio.run(main())
