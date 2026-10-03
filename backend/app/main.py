from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI

from app.config import Settings, get_settings
from app.oracle.cors import OracleCORSMiddleware
from app.oracle.routes import router as oracle_router

app = FastAPI(docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(OracleCORSMiddleware)
api = APIRouter(prefix="/api")


@api.get("/health")
def health(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, str]:
    return {"status": "ok", "env": settings.env}


api.include_router(oracle_router)
app.include_router(api)
