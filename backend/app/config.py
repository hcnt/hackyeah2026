from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "dev"
    oracle_consent_versions: list[str] = ["2026-10-03"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
