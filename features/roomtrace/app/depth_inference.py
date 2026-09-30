"""Isolated pretrained inference CLI. Do not import COLMAP in this process."""

MODEL_ID = "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf"
REVISION = "327deb803d09fac46b05f31a1ccc78a8470c7f6f"


def infer(input_path, output_path):
    import numpy as np
    import torch
    from PIL import Image
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    from . import config

    torch.set_num_threads(config.THREADS)
    cache = config.ROOT / "models"
    processor = AutoImageProcessor.from_pretrained(
        MODEL_ID, revision=REVISION, cache_dir=cache
    )
    # This published checkpoint uses the legacy key "depth_estimation" in config.json.
    # Transformers reads "depth_estimation_type"; explicitly select its trained metric sigmoid head.
    model = AutoModelForDepthEstimation.from_pretrained(
        MODEL_ID, revision=REVISION, cache_dir=cache, depth_estimation_type="metric"
    )
    model.to(config.DEPTH_DEVICE).eval()
    image = Image.open(input_path).convert("RGB")
    image.thumbnail((config.DENSE_SIZE, config.DENSE_SIZE), Image.Resampling.LANCZOS)
    with torch.inference_mode():
        inputs = processor(images=image, return_tensors="pt").to(config.DEPTH_DEVICE)
        predicted = model(**inputs).predicted_depth
        depth = (
            torch.nn.functional.interpolate(
                predicted.unsqueeze(1),
                size=(image.height, image.width),
                mode="bicubic",
                align_corners=False,
            )
            .squeeze()
            .cpu()
            .numpy()
        )
    np.save(output_path, depth)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("output")
    args = parser.parse_args()
    infer(args.image, args.output)
