from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI

from app.config import Settings, get_settings

app = FastAPI(docs_url="/api/docs", openapi_url="/api/openapi.json")
api = APIRouter(prefix="/api")


@api.get("/health")
def health(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, str]:
    return {"status": "ok", "env": settings.env}


app.include_router(api)
