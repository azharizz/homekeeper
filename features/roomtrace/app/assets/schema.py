"""Contracts for immutable, photo-linked mesh assets."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_BYTES = 64 * 1024**2
MAX_TRIANGLES = 250_000
MAX_SCENE_TRIANGLES = 2_000_000
AssetId = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Finite = Annotated[float, Field(allow_inf_nan=False, ge=-1e6, le=1e6)]
Fraction = Annotated[float, Field(allow_inf_nan=False, ge=0, le=1)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PhotoRegion(Contract):
    source: str = Field(min_length=1, max_length=255)
    box: tuple[Fraction, Fraction, Fraction, Fraction] | None = Field(
        default=None,
        description="Optional left, top, right, bottom in full decoded photo fractions.",
    )
    note: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def ordered(self):
        if self.box and (self.box[0] >= self.box[2] or self.box[1] >= self.box[3]):
            raise ValueError("Photo region must have positive width and height.")
        return self


class SourceRegion(PhotoRegion):
    map_id: str = Field(pattern=r"^[0-9a-f]{32}$")


class AssetSpec(Contract):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=4000)
    provenance: str = Field(min_length=1, max_length=4000)
    sources: list[SourceRegion] = Field(min_length=1, max_length=12)
    up_axis: Literal["y", "z"] = "y"
    metres_per_unit: float = Field(gt=0, le=10000, allow_inf_nan=False)
    dimension_basis: Literal["estimated", "measured"] = "estimated"
    dimension_note: str = Field(min_length=1, max_length=2000)
    authoring_source: str | None = Field(
        default=None,
        max_length=100_000,
        description="Optional reproducible code/notes, stored as inert text and never executed by the server.",
    )
    previous_asset: AssetId | None = None


class MeshPart(Contract):
    name: str = Field(min_length=1, max_length=100)
    vertices: list[tuple[Finite, Finite, Finite]] = Field(
        min_length=3, max_length=300_000
    )
    faces: list[tuple[int, int, int]] = Field(min_length=1, max_length=MAX_TRIANGLES)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    roughness: Fraction = 0.85
    metallic: Fraction = 0
    opacity: float = Field(gt=0, le=1, allow_inf_nan=False, default=1)

    @model_validator(mode="after")
    def indexed(self):
        if any(
            min(face) < 0 or max(face) >= len(self.vertices) or len(set(face)) != 3
            for face in self.faces
        ):
            raise ValueError("Faces must reference three distinct existing vertices.")
        return self


class MeshAsset(Contract):
    spec: AssetSpec
    parts: list[MeshPart] = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def budget(self):
        if sum(len(part.faces) for part in self.parts) > MAX_TRIANGLES:
            raise ValueError("Asset exceeds 250,000 triangles.")
        return self
