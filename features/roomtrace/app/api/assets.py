"""Authored mesh asset routes."""

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.concurrency import run_in_threadpool

from .. import assets

router = APIRouter()


@router.get("/api/assets/schema")
def asset_schema():
    return {
        "spec": assets.AssetSpec.model_json_schema(),
        "mesh": assets.MeshAsset.model_json_schema(),
        "max_bytes": assets.MAX_BYTES,
        "max_triangles": assets.MAX_TRIANGLES,
        "instructions": "Create arbitrary indexed triangles or import an embedded static GLB. No category enum or preset lookup. Declare source up-axis and metres_per_unit. Normalization makes Y up, ground at Y=0 and X/Z centered, preserving proportions. Source-photo boxes use full decoded-image fractions. MeshPart.color is sRGB hex; imported glTF baseColorFactor must already be LINEAR, alpha remains linear, embedded base-color textures use sRGB. Local Python authors may use app.assets.linear_rgba(hex_color, opacity). Do not re-convert a valid GLB. Creation does not place an instance; publish an architecture asset element with the returned immutable ID. The agent must judge similarity and contradictions from images. No generator or recipe executes automatically.",
    }


@router.post("/api/assets", status_code=201)
async def import_model_asset(file: UploadFile = File(...), metadata: str = Form(...)):
    try:
        spec = assets.AssetSpec.model_validate_json(metadata)
        data = await file.read(assets.MAX_BYTES + 1)
        return await run_in_threadpool(assets.import_asset, data, spec)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    finally:
        await file.close()


@router.post("/api/assets/mesh", status_code=201)
def create_mesh_asset(body: assets.MeshAsset):
    try:
        return assets.create_mesh(body)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.get("/api/assets")
def list_assets(
    query: str = Query("", max_length=200),
    offset: int = Query(0, ge=0),
    limit: int = Query(12, ge=1, le=50),
):
    return assets.search_assets(query, offset, limit)


@router.get("/api/assets/{asset_id}")
def inspect_asset(asset_id: str):
    try:
        return assets.read_asset(asset_id)
    except ValueError as error:
        raise HTTPException(404, str(error)) from error


@router.get("/api/assets/{asset_id}/model")
def download_asset(asset_id: str, original: bool = False):
    try:
        path = assets.asset_file(asset_id, original)
    except ValueError as error:
        raise HTTPException(404, str(error)) from error
    return FileResponse(
        path,
        media_type="model/gltf-binary",
        filename=f"{asset_id}{'-source' if original else ''}.glb",
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@router.post("/api/asset-reference")
def asset_reference(region: assets.SourceRegion):
    try:
        return Response(assets.crop_reference(region), media_type="image/jpeg")
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
