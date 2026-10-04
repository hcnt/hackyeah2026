from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI

from app import spike
from app.config import Settings, get_settings
from app.oracle.cors import OracleCORSMiddleware
from app.oracle.interfaces import install
from app.oracle.routes import router as oracle_router


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # With an oracle key, events come from and sightings go to the on_sight program on Solana; without one
    # the oracle keeps its in-memory dev event source and sighting sink (which simulates the program rules).
    settings = get_settings()
    key = settings.oracle_keypair.get_secret_value() if settings.oracle_keypair else ""
    if not key:
        yield
        return
    from app.chain.adapters import ChainEventSource, SolanaSightingSink
    from app.chain.presence_chain import PresenceChain, keypair_from_json

    chain = PresenceChain(settings.solana_rpc_url)
    install(event_source=ChainEventSource(chain), sighting_sink=SolanaSightingSink(chain, keypair_from_json(key)))
    try:
        yield
    finally:
        await chain.close()


app = FastAPI(docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
app.add_middleware(OracleCORSMiddleware)
api = APIRouter(prefix="/api")


@api.get("/health")
def health(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, str]:
    return {"status": "ok", "env": settings.env}


# The spike page enrolls faces with no login: a local test tool, never mounted outside dev.
if get_settings().env == "dev":
    api.include_router(spike.router)
api.include_router(oracle_router)
app.include_router(api)
