"""One error shape for every non-2xx oracle response: {"error": {"code", "message", "issues"?}}.

Scoped to the oracle's v1 routes through `OracleRoute` (a custom APIRoute), so other routers keep FastAPI's
default error format.
"""

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute


class OracleError(Exception):
    def __init__(self, status: int, code: str, message: str, issues: list[dict] | None = None) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message
        self.issues = issues

    def response(self) -> JSONResponse:
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.issues is not None:
            body["issues"] = self.issues
        return JSONResponse({"error": body}, status_code=self.status)


def invalid_request(message: str) -> OracleError:
    return OracleError(400, "invalid_request", message)


_HTTP_CODES = {400: "invalid_request", 401: "bad_signature", 404: "event_not_found", 413: "too_large"}


class OracleRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def wrapped(request: Request) -> Response:
            try:
                return await handler(request)
            except OracleError as e:
                return e.response()
            except RequestValidationError:
                return invalid_request("The request is malformed.").response()
            except HTTPException as e:
                code = _HTTP_CODES.get(e.status_code, "invalid_request")
                return OracleError(e.status_code, code, str(e.detail)).response()

        return wrapped
