"""CORS for the public oracle API only: every origin, no credentials, limited to paths under /api/v1."""

from starlette.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

V1_PREFIX = "/api/v1"


class OracleCORSMiddleware(CORSMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], allow_credentials=False)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] == "http" and (path == V1_PREFIX or path.startswith(V1_PREFIX + "/")):
            await super().__call__(scope, receive, send)
        else:
            await self.app(scope, receive, send)
