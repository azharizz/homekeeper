"""Cross-element validation for one architectural revision."""

import math
from typing import Literal

from pydantic import Field, model_validator

from ..photo_materials import PhotoMaterial
from .schema import (
    AssetInstance,
    Box,
    Component,
    Level,
    MeasuredDistance,
    ModelDimension,
    PhotoAlignment,
    Record,
    Slab,
    Solid,
    Stair,
    Staircase,
    Text,
    Wall,
)


class Architecture(Record):
    schema_version: Literal[1] = 1
    units: Literal["estimated_metres"] = "estimated_metres"
    title: Text
    notes: list[Text] = Field(min_length=1, max_length=100)
    levels: list[Level] = Field(min_length=1, max_length=20)
    elements: list[Component] = Field(min_length=1, max_length=1000)
    alignments: list[PhotoAlignment] = Field(default_factory=list, max_length=12)
    measurements: list[MeasuredDistance] = Field(default_factory=list, max_length=100)
    dimensions: list[ModelDimension] = Field(default_factory=list, max_length=100)
    photo_materials: list[PhotoMaterial] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def connected_identifiers(self):
        ids = [item.id for item in [*self.levels, *self.elements]]
        if len(ids) != len(set(ids)):
            raise ValueError("Level and element identifiers must be unique.")
        levels = {level.id: level for level in self.levels}
        elements = {item.id: item for item in self.elements}
        assemblies = {}
        joints = {}
        for element in self.elements:
            if any(
                region.source not in element.sources for region in element.observations
            ):
                raise ValueError(
                    "Object observation must reference one of its declared source photos."
                )
            if isinstance(element, AssetInstance) and (
                element.finish != "plain"
                or element.opacity != 1
                or element.metallic != 0
                or element.roughness != 0.85
            ):
                raise ValueError(
                    "Asset instances retain imported materials. Edit materials in a new asset, not primitive finish fields."
                )
            if element.level not in levels:
                raise ValueError(f"Unknown level on {element.id}.")
            if isinstance(element, Wall):
                for endpoint in ("start", "end"):
                    joint = getattr(element, endpoint + "_joint")
                    if joint:
                        value = (element.level, getattr(element, endpoint))
                        if joints.setdefault(joint, value) != value:
                            raise ValueError(
                                f"Joint {joint} has inconsistent wall endpoints. Move every member together."
                            )
            if isinstance(element, Staircase):
                if (
                    element.to_level not in levels
                    or abs(
                        sum(f.rise for f in element.flights)
                        - (
                            levels[element.to_level].elevation
                            - levels[element.level].elevation
                        )
                    )
                    > 1e-6
                ):
                    raise ValueError(
                        f"Staircase {element.id} flight rises must reach its destination elevation."
                    )
                for flight in element.flights:
                    if flight.opening:
                        slab = elements.get(flight.opening.slab)
                        if not isinstance(slab, Slab) or slab.level != element.to_level:
                            raise ValueError(
                                "Flight openings need an explicit destination-level slab."
                            )
            if element.assembly:
                previous = assemblies.setdefault(element.assembly, element.level)
                if previous != element.level:
                    raise ValueError("An assembly must belong to a single level.")
            attachment = getattr(element, "attachment", None)
            if attachment:
                host = elements.get(attachment.host)
                if not isinstance(host, (Wall, Slab)) or host.level != element.level:
                    raise ValueError(
                        f"Attachment on {element.id} needs a wall or slab on the same level."
                    )
                if attachment.opening and (
                    not isinstance(host, Wall)
                    or not any(o.id == attachment.opening for o in host.openings)
                ):
                    raise ValueError(f"Unknown host opening on {element.id}.")
            if isinstance(element, Stair):
                if element.to_level not in levels:
                    raise ValueError(f"Unknown stair destination on {element.id}.")
                rise = (
                    levels[element.to_level].elevation - levels[element.level].elevation
                )
                if rise <= 0 or math.dist(element.start, element.end) < 0.001:
                    raise ValueError(
                        "Stair must have a nonzero run and ascending level elevations."
                    )
                if element.tread_thickness > rise / element.risers:
                    raise ValueError(
                        "Open stair tread thickness must not exceed its riser height."
                    )
                if element.opening:
                    slab = elements.get(element.opening.slab)
                    if not isinstance(slab, Slab) or slab.level != element.to_level:
                        raise ValueError(
                            f"Stair {element.id} opening must reference a destination-level slab."
                        )
        sources = [item.source for item in self.alignments]
        if len(sources) != len(set(sources)):
            raise ValueError("Only one alignment per source image is allowed.")
        measurement_ids = [item.id for item in [*self.measurements, *self.dimensions]]
        if len(measurement_ids) != len(set(measurement_ids)):
            raise ValueError("Measurement IDs must be unique.")
        anchors = [
            match for alignment in self.alignments for match in alignment.matches
        ]
        anchors += [
            point
            for item in [*self.measurements, *self.dimensions]
            for point in (item.start, item.end)
        ]
        for point in anchors:
            if not isinstance(
                elements.get(point.element_id),
                (Wall, Slab, Box, Solid, AssetInstance, Stair, Staircase),
            ):
                raise ValueError(
                    "Anchors need a wall, slab, box, solid, asset or stair."
                )
            if point.feature:
                from .features import resolve_anchor

                resolve_anchor(self, point)
            elif isinstance(elements[point.element_id], Staircase):
                raise ValueError(
                    "Connected stairs require exact flight/landing features, not a bounding-box anchor."
                )
        from .features import dimension_report

        for dimension in self.dimensions:
            dimension_report(self, dimension)
        return self
