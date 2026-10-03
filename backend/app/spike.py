"""Oracle spike endpoints: enroll a face from a photo, then recognise faces in a live stream."""

from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from app.face import analyze, decode_jpeg, gallery, recognize_frame

router = APIRouter(prefix="/spike", tags=["spike"])


@router.get("", include_in_schema=False)
def page() -> FileResponse:
    return FileResponse(Path(__file__).parent / "static" / "spike.html")


@router.post("/enroll")
async def enroll(name: Annotated[str, Form(min_length=1, max_length=40)], image: Annotated[UploadFile, File()]) -> dict:
    data = await image.read()
    try:
        img = decode_jpeg(data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    faces = await run_in_threadpool(analyze, img)
    if len(faces) != 1:
        raise HTTPException(422, f"Expected exactly one face in the photo, found {len(faces)}.")
    face = faces[0]
    gallery.add(name.strip(), face.embedding)
    return {"name": name.strip(), "bbox": face.bbox, "det_score": round(face.det_score, 3)}


@router.get("/people")
def people() -> list[str]:
    return gallery.names()


@router.delete("/people/{name}")
def remove(name: str) -> dict:
    if not gallery.remove(name):
        raise HTTPException(404, "No such person.")
    return {"removed": name}


@router.websocket("/stream")
async def stream(ws: WebSocket) -> None:
    """Client sends one JPEG frame (binary), waits for the JSON result, then sends the next."""
    await ws.accept()
    try:
        while True:
            data = await ws.receive_bytes()
            try:
                result = await run_in_threadpool(recognize_frame, data)
            except ValueError as e:
                result = {"error": str(e)}
            await ws.send_json(result)
    except WebSocketDisconnect:
        pass
