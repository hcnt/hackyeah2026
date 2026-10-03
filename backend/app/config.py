from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "dev"
    oracle_consent_versions: list[str] = ["2026-10-03"]
    # "cuda" needs onnxruntime-gpu[cuda,cudnn] installed instead of onnxruntime (see scripts/oracle-gpu.sh).
    oracle_device: Literal["cpu", "cuda"] = "cpu"
    # Detector input size in px. 320 is about twice as fast as 640 and enough when faces are close (a pay lane
    # or kiosk); 640 finds smaller, more distant faces.
    oracle_det_size: int = Field(default=640, ge=160, le=1280, multiple_of=32)


@lru_cache
def get_settings() -> Settings:
    return Settings()
