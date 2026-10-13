"""Mock reconstruction inputs only; temporary captures, no saved demo/media/hardware."""

import copy
import itertools
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import store
from app.architecture import Architecture, publish
from app.architecture.landmarks import guidance
from app.capture_calibration import ScaleReference, measured_scale, registered_index, similarity
from app.reconstruction import reconstruct


class Camera:
    model_name, width, height = "PINHOLE", 800, 600
    params = np.array([800., 800., 400., 300.])

    def img_from_cam(self, points):
        points = np.asarray(points)
        return points[..., :2] / points[..., 2:] * 800 + [400, 300]


def fixture():
    camera = Camera()
    xyz = np.array([*itertools.product([-.5, .5], repeat=3), (.2, .1, .3), (-.2, .3, .1)])
    points = {i: SimpleNamespace(xyz=p, error=0., track=SimpleNamespace(length=lambda: 4)) for i, p in enumerate(xyz)}
    images, alignments, pixels = {}, [], []
    for index in range(4):
        pose = np.eye(4)[:3]
        pose[:, 3] = [index * .3, 0, 4]
        uv = camera.img_from_cam(xyz + pose[:, 3])
        pixels.append(uv / [800, 600])
        observations = [SimpleNamespace(xy=p, point3D_id=i, has_point3D=lambda: True) for i, p in enumerate(uv)]
        image = SimpleNamespace(name=f"{index:05d}.jpg", image_id=index, camera_id=1,
                                has_pose=True, points2D=observations,
                                cam_from_world=lambda pose=pose: SimpleNamespace(matrix=lambda: pose))
        images[index] = image
        alignments.append({"source": image.name, "fov_y": 40., "matches": [
            {"element_id": "anchors", "anchor": (p + .5).tolist(), "image": pixel.tolist(),
             "note": "Synthetic mock observation only", "role": "check" if i >= 8 else "fit"}
            for i, (p, pixel) in enumerate(zip(xyz, pixels[-1]))]})
    model = Architecture.model_validate({
        "title": "New isolated mock capture", "levels": [{"id": "ground", "name": "Ground", "elevation": 0}],
        "notes": ["Synthetic mocked feature/camera evidence only; no physical trial or saved capture."],
        "elements": [{"id": "anchors", "kind": "box", "level": "ground", "label": "Mock anchors",
                      "position": [2, 1, 3], "size": [3, 3, 3], "color": "#aaaaaa",
                      "sources": [image.name for image in images.values()], "evidence": "Synthetic fixture, not physical evidence"}],
        "alignments": alignments,
    })
    reconstruction = SimpleNamespace(images=images, cameras={1: camera}, points3D=points,
                                     num_reg_images=lambda: 4, num_points3D=lambda: 10,
                                     compute_mean_reprojection_error=lambda: 0.)
    reference = {"source_a": "00000.jpg", "source_b": "00001.jpg",
                 "pixels_a": pixels[0][:2].tolist(), "pixels_b": pixels[1][:2].tolist(),
                 "distance_m": 2., "uncertainty_m": .02,
                 "provenance": "Mock reported tape measurement, synthetic endpoints; not a hardware trial"}
    return reconstruction, model, reference


class Database:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read_descriptors(self, identifier):
        descriptors = np.random.default_rng(identifier).random((10, 128)).astype(np.float32)
        return SimpleNamespace(to_float=lambda: SimpleNamespace(data=descriptors))


def rejects(action, fragment):
    try:
        action()
    except ValueError as error:
        assert fragment in str(error), str(error)
    else:
        raise AssertionError("Invalid evidence accepted")


def check():
    reconstructed, document, reference = fixture()
    assert measured_scale(reconstructed, reference)["meters_per_unit"] == 2.
    for update, message in [({"source_b": "00000.jpg"}, "distinct"),
                            ({"distance_m": float("nan")}, "finite"),
                            ({"uncertainty_m": 3.}, "uncertainty"),
                            ({"provenance": "  "}, "provenance")]:
        rejects(lambda update=update: ScaleReference.model_validate(reference | update), message)
    wrong = copy.deepcopy(reference)
    wrong["pixels_b"].reverse()
    rejects(lambda: measured_scale(reconstructed, wrong), "same two")
    rejects(lambda: similarity(np.zeros((4, 3)), np.zeros((4, 3))), "non-coplanar")
    original = store.DATA
    with tempfile.TemporaryDirectory() as temporary:
        store.DATA = Path(temporary)
        try:
            job = store.create_job("New isolated mock capture", {"engine": "architecture", "source": "photos",
                                                                  "scale_reference": reference})
            root = store.job_dir(job["id"])
            (root / "images").mkdir()
            frames = [{"name": f"{i:05d}.jpg", "size": [800, 600]} for i in range(4)]
            for frame in frames:
                Image.new("RGB", (800, 600), "gray").save(root / "images" / frame["name"])
            store.atomic_json(root / "frames.json", frames)
            with patch("app.reconstruction.prepare_frames", return_value=frames), \
                 patch("app.reconstruction.run_sfm", return_value=(reconstructed, 1)):
                reconstruct(job["id"])
            job = store.get_job(job["id"])
            assert job["status"] == "awaiting_agent"
            report = json.loads((root / "capture_reconstruction.json").read_text())
            assert report["scale"]["meters_per_unit"] == 2.
            assert "estimate" in report["cameras"]["00000.jpg"]["provenance"]
            with patch("app.capture_calibration.pycolmap.Reconstruction", return_value=reconstructed), \
                 patch("app.capture_calibration.pycolmap.Database", SimpleNamespace(open=lambda path: Database())):
                job = publish(job, document, 0)
                target = store.artifact_dir(job)
                scene = json.loads((target / "scene.json").read_text())
                index = guidance(target)
                assert scene["guide_readiness"]["ready"] and scene["guide_readiness"]["validation"]["status"] == "passed"
                assert index["feature_extractor"] == "colmap_sift" and index["landmark_count"] == 8
                assert np.isclose(scene["capture_registration"]["scale"], 3.)
                assert np.isclose(scene["reported_scale"]["meters_per_model_unit"], 2 / 3)
                assert scene["scale"] is None and not index["physically_verified"]
                with np.load(target / index["index_file"]) as data:
                    assert not set(data["point_ids"]) & {8, 9}
                    assert np.allclose(data["xyz"][0], reconstructed.points3D[int(data["point_ids"][0])].xyz * 3 + [2, 1, 3])
                preserved = (target / "scene.json").read_bytes()
                no_anchors = document.model_copy(update={"alignments": []})
                job = publish(job, no_anchors, 1)
                absent = json.loads((store.artifact_dir(job) / "scene.json").read_text())
                assert not absent["guide_readiness"]["ready"] and "anchors" in " ".join(absent["guide_readiness"]["reasons"])
                assert (target / "scene.json").read_bytes() == preserved
                bad = document.model_copy(deep=True)
                bad.alignments[0].matches[-1].image = (.1, .1)
                rejects(lambda: registered_index(job, store.artifact_dir(job), scene | {"architecture": bad.model_dump()}, 4.), "unambiguous")
            failed = store.create_job("New failed mock capture", {"engine": "architecture", "source": "photos"})
            with patch("app.reconstruction.prepare_frames", return_value=frames), \
                 patch("app.reconstruction.run_sfm", side_effect=ValueError("No translated overlapping features")):
                reconstruct(failed["id"])
            assert store.get_job(failed["id"])["status"] == "awaiting_agent"
            missing = json.loads((store.job_dir(failed["id"]) / "capture_reconstruction.json").read_text())
            assert missing["status"] == "unavailable" and "translated" in missing["reason"]
        finally:
            store.DATA = original
    print("PASS: isolated mock capture calibration, checked frame registration, held-out tracks, measured-reference provenance and absent-evidence refusal")


if __name__ == "__main__":
    check()
