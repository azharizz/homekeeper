"""Real MapAnything inference process, isolated from COLMAP's native runtime."""

MODEL_ID = "facebook/map-anything-apache"
REVISION = "00f9c245bbcb60522d1ed7f9e9d88462c6e3f38a"


def infer(directory, calibration=None):
    import os
    import numpy as np
    import torch
    from pathlib import Path
    from PIL import Image
    from mapanything.models import MapAnything
    from mapanything.utils.image import preprocess_inputs, rgb
    from . import config

    torch.set_num_threads(config.THREADS)
    torch.hub.set_dir(str(config.ROOT / "models/torch_hub"))
    device = config.DEPTH_DEVICE
    model = (
        MapAnything.from_pretrained(
            MODEL_ID, revision=REVISION, cache_dir=config.ROOT / "models"
        )
        .to(device)
        .eval()
    )
    size = int(os.getenv("MULTIVIEW_IMAGE_SIZE", "392"))
    paths = sorted((Path(directory) / "images").glob("*.jpg"))
    inputs = []
    for path in paths:
        image = Image.open(path).convert("RGB")
        view = {"img": image}
        if calibration:
            params = calibration["params"]
            fx, fy, cx, cy = (
                params if calibration["model"] == "PINHOLE" else [params[0], *params]
            )
            k = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float32)
            view["intrinsics"] = (
                np.diag(
                    [
                        image.width / calibration["width"],
                        image.height / calibration["height"],
                        1,
                    ]
                )
                @ k
            ).astype(np.float32)
        inputs.append(view)
    views = preprocess_inputs(inputs, resize_mode="longest_side", size=size)
    with torch.inference_mode():
        predictions = model.infer(
            views,
            memory_efficient_inference=True,
            minibatch_size=1,
            use_amp=device == "cuda",
            amp_dtype="bf16",
            apply_mask=True,
            mask_edges=True,
            apply_confidence_mask=True,
            confidence_percentile=10,
        )
    output = Path(directory) / "predictions"
    output.mkdir(exist_ok=True)
    for path, view, prediction in zip(paths, views, predictions):

        def array(key):
            return prediction[key][0].detach().cpu().numpy()

        np.savez_compressed(
            output / f"{path.stem}.npz",
            depth=array("depth_z").squeeze(),
            points=array("pts3d"),
            intrinsics=array("intrinsics"),
            camera_to_world=array("camera_poses"),
            mask=array("mask").squeeze(),
            confidence=array("conf").squeeze(),
            rgb=(rgb(view["img"], "dinov2")[0] * 255).astype(np.uint8),
        )
    print(f"MapAnything completed {len(paths)} views on {device}", flush=True)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("--calibration")
    import json

    args = parser.parse_args()
    infer(args.directory, json.loads(args.calibration) if args.calibration else None)
