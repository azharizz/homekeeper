# Third-party engines and assets

This app calls the installed engines below. It does not copy desktop applications or redistribute all 19 research repositories. Their relevant logic, licenses and exclusions are documented in the original RoomTrace repository's `LIST_CORE_ENGINE_LOGIC_REFERENCES.md`. Retain each installed distribution's complete license and notices when redistributing a deployment; this inventory is not a replacement for them.

| Component | Version or revision used | License / source |
| --- | --- | --- |
| MapAnything code | `3d10cf7a3016fc0f9bb13a071ee66c47b10be0d9` | [Apache-2.0 source license](https://github.com/facebookresearch/map-anything/blob/3d10cf7a3016fc0f9bb13a071ee66c47b10be0d9/LICENSE) |
| MapAnything Apache weights | `facebook/map-anything-apache`, `00f9c245bbcb60522d1ed7f9e9d88462c6e3f38a` | [Apache-2.0 model card](https://huggingface.co/facebook/map-anything-apache). This specific variant was selected. |
| Uniception | 0.1.7 | BSD-3-Clause, installed package metadata. Its DINOv2 loader uses Torch Hub. |
| DINOv2 backbone code | Cached upstream Torch Hub source | [Apache-2.0](https://github.com/facebookresearch/dinov2). Its default main-branch loader is a reproducibility limit described in README. |
| Depth Anything V2 Small, metric indoor conversion | `327deb803d09fac46b05f31a1ccc78a8470c7f6f` | [Converted checkpoint](https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf); upstream [Small Apache-2.0 terms](https://github.com/DepthAnything/Depth-Anything-V2#license). The conversion card identifies the model but does not separately restate a license. Preserve upstream attribution and verify the conversion terms before redistribution. |
| COLMAP / PyCOLMAP | 4.2.0 | BSD-3-Clause; [official source](https://github.com/colmap/colmap). CUDA profile uses the separate `pycolmap-cuda12` wheel. |
| Open3D | 0.19.0 | MIT; [official source](https://github.com/isl-org/Open3D). Version 0.20 returned an empty TSDF in the local regression case. |
| OpenCV headless | 4.10.0.84 | Apache-2.0 core with wheel-specific third-party notices; [packaging source](https://github.com/opencv/opencv-python). |
| Shapely / GEOS | 2.1.2 | Shapely BSD-3-Clause; bundled GEOS LGPL-2.1-or-later. Preserve wheel licenses. |
| mapbox-earcut | 2.1.0 | ISC; triangulates slab polygons and holes. |
| trimesh | 5.1.0 | MIT, installed package metadata. |
| PyTorch | 2.14.0 | Installed wheel includes Apache, BSD, MIT, BSL and LLVM-exception component notices. Preserve the wheel notices. |
| Transformers | 5.17.0 | Apache-2.0. |
| MCP Python SDK | 2.2.0 | MIT. Standard stdio transport; no Blender connection. |
| FastAPI, React, Three.js, React Three Fiber, Drei, TanStack Query, Vite | Exact installation in requirements and npm lockfile | Permissive upstream licenses, primarily MIT. Preserve dependency license files. |

The generated test photographs were produced for this task with the image-generation tool. They depict fictional scenes and have no measured camera poses or surveyed geometry. Their source records and hashes remain in the original RoomTrace repository's `datasets/generated/manifest.json`; they are not bundled into HomeKeeper. They are not a public real-home dataset and do not establish physical accuracy. The originally downloaded public dataset captures have been removed; historical numerical reports identify their original provenance.

The earlier Nebius integration was removed at the user's request. Existing private credentials are unused. Codex accesses local source and observation images only through requested MCP tool calls. The backend has no conversational provider dependency.

Homebuddy and Pascal are research references, not bundled source dependencies. The architecture contract, mesher and MCP operations here were implemented independently. Procedural material images are authored in this app, embedded in GLB, and labeled illustrative rather than extracted from source photographs.
