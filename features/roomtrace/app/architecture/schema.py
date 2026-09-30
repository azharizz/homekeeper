"""Validated architectural document and stable feature references."""

import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from shapely.geometry import Polygon
from shapely.geometry import box as rectangle

from .. import assets

Number = Annotated[float, Field(allow_inf_nan=False, ge=-10000, le=10000)]
Positive = Annotated[float, Field(gt=0, le=10000, allow_inf_nan=False)]
Point = tuple[Number, Number]
Ring = Annotated[list[Point], Field(min_length=3, max_length=256)]
Identifier = Annotated[str, Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")]
Text = Annotated[str, Field(min_length=1, max_length=2000)]


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Level(Record):
    id: Identifier
    name: Text
    elevation: Number = Field(description="Absolute Y elevation, not a storey offset.")


class Element(Record):
    id: Identifier
    label: Text
    level: Identifier
    sources: list[str] = Field(min_length=1, max_length=12)
    evidence: Text = Field(
        description="What is visible, what is estimated, and any contradictions."
    )
    observations: list[assets.PhotoRegion] = Field(
        default_factory=list,
        max_length=12,
        description="Optional photo regions identifying this particular instance, not a class template.",
    )
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    assembly: Text | None = Field(
        default=None,
        description="Identity of one multipart physical object on one level, never a category. Moves as a unit. Two similar objects need separate IDs/assemblies.",
    )
    roughness: float = Field(default=0.85, ge=0, le=1, allow_inf_nan=False)
    metallic: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    opacity: float = Field(default=1, gt=0, le=1, allow_inf_nan=False)
    finish: Literal["plain", "wood", "brick", "tile", "fabric"] = "plain"
    texture_scale: Positive = Field(
        default=1,
        description="Estimated metres per procedural texture repeat. These are illustrative finishes, not recovered photo textures.",
    )
    cutaway: bool = Field(
        default=False,
        description="Clip wall-attached frames or doors with cutaway walls.",
    )


class Opening(Record):
    id: Identifier | None = None
    kind: Literal["door", "window", "passage"]
    offset: Number = Field(
        ge=0, description="Distance from wall start along its length."
    )
    width: Positive
    sill: Number = Field(ge=0)
    height: Positive
    swing: (
        Literal["left_positive", "left_negative", "right_positive", "right_negative"]
        | None
    ) = Field(
        default=None,
        description="Observed single-leaf hinge and swing side in host-wall coordinates. None means unknown, not no clearance required.",
    )
    swing_degrees: float | None = Field(
        default=None,
        gt=0,
        le=180,
        allow_inf_nan=False,
        description="Authored sweep extent. Supply with hinge/side; never infer an unknown door movement.",
    )

    @model_validator(mode="after")
    def valid_swing(self):
        if (self.swing is None) != (self.swing_degrees is None) or (
            self.swing and (self.kind != "door" or self.id is None)
        ):
            raise ValueError(
                "Door sweep requires a stable door ID, hinge/side and explicit angle together."
            )
        return self


class Wall(Element):
    kind: Literal["wall"]
    start: Point
    end: Point
    bottom: Number = 0
    height: Positive
    thickness: Positive
    openings: list[Opening] = Field(default_factory=list, max_length=32)
    start_joint: Identifier | None = None
    end_joint: Identifier | None = None

    @model_validator(mode="after")
    def valid_openings(self):
        length = math.dist(self.start, self.end)
        if length < 0.001:
            raise ValueError("Wall endpoints must differ.")
        ids = [opening.id for opening in self.openings if opening.id]
        if len(ids) != len(set(ids)):
            raise ValueError("Opening identifiers must be unique within their wall.")
        profiles = []
        for opening in self.openings:
            if (
                opening.offset + opening.width > length + 1e-8
                or opening.sill + opening.height > self.height + 1e-8
            ):
                raise ValueError("Wall openings must fit the wall.")
            profile = rectangle(
                opening.offset,
                opening.sill,
                opening.offset + opening.width,
                opening.sill + opening.height,
            )
            if any(profile.intersection(other).area > 1e-10 for other in profiles):
                raise ValueError("Wall openings must not overlap in area.")
            profiles.append(profile)
        return self


class Slab(Element):
    kind: Literal["slab"]
    polygon: Ring
    holes: list[Ring] = Field(default_factory=list, max_length=32)
    top: Number = Field(
        default=0, description="Top relative to level; slab extends downward."
    )
    thickness: Positive
    vertex_ids: list[Identifier] = Field(
        default_factory=list,
        max_length=256,
        description="Stable IDs for outer polygon vertices, kept with each vertex when reordered.",
    )

    @model_validator(mode="after")
    def valid_polygon(self):
        if self.vertex_ids and (
            len(self.vertex_ids) != len(self.polygon)
            or len(set(self.vertex_ids)) != len(self.vertex_ids)
        ):
            raise ValueError(
                "Slab vertex IDs must uniquely identify every outer vertex."
            )
        shape = Polygon(self.polygon, self.holes)
        if not shape.is_valid or shape.area < 1e-6:
            raise ValueError(
                "Slab outline and holes must form a valid polygon with positive area."
            )
        return self


class Attachment(Record):
    host: Identifier
    opening: Identifier | None = Field(
        default=None,
        description="Stable opening ID on a wall. Origin becomes the opening center.",
    )


class Box(Element):
    kind: Literal["box"]
    position: tuple[Number, Number, Number] = Field(
        description="Center; Y relative to level."
    )
    size: tuple[Positive, Positive, Positive]
    yaw: Number = Field(
        default=0, description="Radians about positive Y, Three.js convention."
    )
    pitch: Number = 0
    roll: Number = 0
    attachment: Attachment | None = Field(
        default=None,
        description="Position and yaw become host-local. Wall: X along wall, Y above base, Z normal. Slab: X/Z plan, Y above its top.",
    )
    radius: Number = Field(
        default=0,
        ge=0,
        description="Rounded edge radius, at most half the smallest dimension.",
    )

    @model_validator(mode="after")
    def valid_radius(self):
        if self.radius > min(self.size) / 2:
            raise ValueError("Rounded edge radius exceeds half the smallest dimension.")
        return self


class Solid(Element):
    kind: Literal["solid"]
    shape: Literal["ellipsoid", "cylinder"]
    position: tuple[Number, Number, Number]
    size: tuple[Positive, Positive, Positive]
    yaw: Number = 0
    pitch: Number = 0
    roll: Number = 0
    attachment: Attachment | None = None


class AssetInstance(Element):
    kind: Literal["asset"]
    asset_id: assets.AssetId
    position: tuple[Number, Number, Number] = Field(
        description="Normalized asset base center; Y relative to level, or host-local when attached."
    )
    scale: Positive = Field(
        default=1,
        description="Uniform scale preserves proportions. Shape changes require a new asset revision.",
    )
    yaw: Number = 0
    pitch: Number = 0
    roll: Number = 0
    attachment: Attachment | None = None


class StairOpening(Record):
    slab: Identifier
    mode: Literal["cut", "edge"] = Field(
        default="cut",
        description="Cut a flight-derived opening, or link to a landing edge when the stair occupies an existing open void.",
    )
    from_fraction: float = Field(default=0, ge=0, lt=1, allow_inf_nan=False)
    to_fraction: float = Field(default=1, gt=0, le=1, allow_inf_nan=False)
    margin: Number = Field(default=0, ge=0, le=1)

    @model_validator(mode="after")
    def ordered(self):
        if self.from_fraction >= self.to_fraction:
            raise ValueError("Stair opening fractions must ascend.")
        return self


class Stair(Element):
    kind: Literal["stair"]
    to_level: Identifier
    start: Point
    end: Point
    width: Positive
    risers: int = Field(ge=2, le=100)
    tread_thickness: Positive
    closed: bool = True
    opening: StairOpening | None = None


class Flight(Record):
    id: Identifier
    start: Point
    end: Point
    rise: Positive
    width: Positive
    risers: int = Field(ge=2, le=100)
    opening: StairOpening | None = None


class Landing(Record):
    id: Identifier
    polygon: Ring
    thickness: Positive


class Staircase(Element):
    kind: Literal["staircase"]
    to_level: Identifier
    flights: list[Flight] = Field(min_length=2, max_length=20)
    landings: list[Landing] = Field(min_length=1, max_length=19)
    tread_thickness: Positive
    closed: bool = True

    @model_validator(mode="after")
    def connected_flights(self):
        from .structure import validate_staircase

        validate_staircase(self)
        return self


class Rail(Element):
    kind: Literal["rail"]
    start: tuple[Number, Number, Number]
    end: tuple[Number, Number, Number]
    radius: Positive

    @model_validator(mode="after")
    def nonzero_length(self):
        if math.dist(self.start, self.end) < 0.001:
            raise ValueError("Rail endpoints must differ.")
        return self


class Zone(Element):
    kind: Literal["zone"]
    polygon: Ring

    @model_validator(mode="after")
    def valid_polygon(self):
        shape = Polygon(self.polygon)
        if not shape.is_valid or shape.area < 1e-6:
            raise ValueError("Room zone must be a valid polygon with positive area.")
        return self


Component = Annotated[
    Wall | Slab | Box | Solid | AssetInstance | Stair | Staircase | Rail | Zone,
    Field(discriminator="kind"),
]

Fraction = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class FeatureReference(Record):
    id: str = Field(
        min_length=1,
        max_length=256,
        description="Exact feature ID returned by inspect_architecture_structure. No label matching.",
    )
    uv: tuple[Fraction, Fraction] = (0.5, 0.5)


class ModelAnchor(Record):
    element_id: Identifier
    anchor: tuple[Fraction, Fraction, Fraction] | None = Field(
        default=None,
        description="Normalized component-local bounds. Box/solid/asset: XYZ. Asset bounds use its normalized base-centered geometry and uniform scale. Wall/stair: along, height, thickness/width. Slab: plan X, thickness bottom-to-top, plan Z.",
    )
    feature: FeatureReference | None = None

    @model_validator(mode="after")
    def one_reference(self):
        if (self.anchor is None) == (self.feature is None):
            raise ValueError(
                "Choose one normalized anchor or one exact feature reference."
            )
        return self


class ModelDimension(Record):
    id: Identifier
    label: Text
    start: ModelAnchor
    end: ModelAnchor
    convention: Literal["point_distance", "wall_faces", "wall_centerlines"] = (
        "point_distance"
    )


class PhotoMatch(ModelAnchor):
    image: tuple[Fraction, Fraction] = Field(
        description="Full source image u/v, top-left origin, divided by width/height."
    )
    note: Text
    role: Literal["fit", "check"] = Field(
        default="fit",
        description="Check points are excluded from camera optimization. Select them before fitting; they check projection consistency, not physical accuracy.",
    )


class MeasuredDistance(Record):
    id: Identifier
    label: Text
    start: ModelAnchor
    end: ModelAnchor
    distance_m: Positive
    uncertainty_m: Positive = Field(
        description="Reported absolute measurement uncertainty in metres, not a model-selected passing threshold."
    )
    provenance: Text = Field(
        description="Who measured what, with which instrument/source and when. Never substitute a photo estimate or a model dimension."
    )


class PhotoCalibration(Record):
    width: int = Field(ge=1, le=40000)
    height: int = Field(ge=1, le=40000)
    fx: Positive
    fy: Positive
    cx: Number
    cy: Number
    distortion: tuple[Number, Number, Number, Number, Number] = (0, 0, 0, 0, 0)
    provenance: Text = Field(
        description="Calibration source for this exact image crop and lens. OpenCV k1,k2,p1,p2,k3. Resize is handled, crop must already be reflected in cx/cy."
    )


class PhotoAlignment(Record):
    source: str = Field(min_length=1, max_length=255)
    fov_y: float = Field(
        ge=10,
        le=150,
        allow_inf_nan=False,
        description="Estimated vertical field of view in degrees. Pinhole camera, centered principal point, no distortion correction.",
    )
    matches: list[PhotoMatch] = Field(min_length=6, max_length=64)
    calibration: PhotoCalibration | None = None
