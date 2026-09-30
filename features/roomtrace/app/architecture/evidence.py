"""Reported measurements versus authored geometry. No inferred physical scale."""

import math

from .features import resolve_anchor, dimension_report


def measurement_checks(document):
    results = []
    for item in document.measurements:
        points = [resolve_anchor(document, p) for p in (item.start, item.end)]
        distance = math.dist(*points)
        if distance < 1e-8:
            raise ValueError(f"Measurement {item.id} needs two distinct model points.")
        residual = distance - item.distance_m
        results.append(
            item.model_dump()
            | {
                "world_points": [point.tolist() for point in points],
                "model_distance_m": distance,
                "residual_m": residual,
                "within_reported_uncertainty": abs(residual)
                <= item.uncertainty_m + 1e-9,
            }
        )
    return results


def accuracy_report(document, fits):
    return {
        "units": document.units,
        "physically_verified": False,
        "measurements": measurement_checks(document),
        "dimensions": [dimension_report(document, d) for d in document.dimensions],
        "photos": [
            {
                key: fit.get(key)
                for key in (
                    "source",
                    "rmse_px",
                    "max_error_px",
                    "fit_count",
                    "check_count",
                    "check_rmse_px",
                    "check_max_error_px",
                    "planar",
                )
            }
            for fit in fits
        ],
        "limits": "Measurements are reported evidence, not a survey certificate. Check landmarks are excluded from camera fitting but may still share authoring bias. Unmeasured geometry, unseen areas and live position remain unverified.",
    }
