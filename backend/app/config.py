from functools import lru_cache
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "dev"
    oracle_consent_versions: list[str] = ["2026-10-03"]
    # "cuda" needs onnxruntime-gpu[cuda,cudnn] installed instead of onnxruntime (see scripts/oracle-gpu.sh).
    oracle_device: Literal["cpu", "cuda"] = "cpu"
    # Solana: the presence_pay program (contracts/presence_pay). Without oracle_keypair the oracle keeps the
    # in-memory dev event source and payout sink.
    solana_rpc_url: str = "https://api.devnet.solana.com"
    solana_cluster: str = "devnet"
    presence_program_id: str = "4YhphZrWqUUdjnyT3c8r6Wre2e27BZvqoCQWbEmcQdmf"
    oracle_keypair: SecretStr | None = None  # JSON array of 64 numbers (solana-keygen format)


@lru_cache
def get_settings() -> Settings:
    return Settings()
