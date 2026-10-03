"""Publish this oracle's name and API URL in the presence_pay oracle registry (OracleInfo, PDA ["oracle", key]).

    cd backend && ORACLE_KEYPAIR=... uv run python ../scripts/register_oracle.py --name OnSight \
        --url https://hackyeah.kindhome.io [--program <program id>] [--rpc <url>]

Attendees' widgets read the event's oracle keys from the chain and send their join to each oracle's registered URL,
so every oracle runs this once per program deploy; running it again with another name or URL updates the entry (the
program's register_oracle creates or updates). The oracle key comes from ORACLE_KEYPAIR (environment or backend/.env,
as for the server); it signs, pays the rent (~0.0023 SOL) on the first run and is never printed. --program and --rpc default to PRESENCE_PROGRAM_ID / SOLANA_RPC_URL from the same settings.
"""

import argparse
import asyncio
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from solders.pubkey import Pubkey

from app.chain.presence_chain import (
    MAX_ORACLE_NAME,
    MAX_ORACLE_URL,
    PresenceChain,
    PresenceError,
    explorer_address,
    explorer_tx,
    keypair_from_json,
    oracle_info_pda,
    register_oracle_ix,
)
from app.config import get_settings


def _control(c: str) -> bool:
    return unicodedata.category(c) == "Cc"  # Rust char::is_control


def check(name: str, url: str) -> None:
    """The program's own rules (lib.rs check_oracle_info), so a bad value fails here instead of on chain."""
    if not 1 <= len(name.encode()) <= MAX_ORACLE_NAME or any(map(_control, name)):
        sys.exit(f"--name must be 1-{MAX_ORACLE_NAME} bytes without control characters")
    rest = url.removeprefix("https://") if url.startswith("https://") else url.removeprefix("http://")
    if (
        not url.startswith(("https://", "http://"))
        or not rest
        or len(url.encode()) > MAX_ORACLE_URL
        or any(c.isspace() or _control(c) for c in rest)
    ):
        sys.exit(f"--url must be http(s)://host[:port][/path], at most {MAX_ORACLE_URL} bytes, no spaces")
    if url.endswith(("/", "/api/v1")):
        sys.exit("--url is the oracle's base origin: no trailing slash and no /api/v1 (the widget appends it)")


async def main() -> None:
    settings = get_settings()
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--name", required=True, help="shown to attendees on the consent screen")
    p.add_argument("--url", required=True, help="base URL of this oracle's API, e.g. https://hackyeah.kindhome.io")
    p.add_argument("--program", default=settings.presence_program_id, help="presence_pay program id")
    p.add_argument("--rpc", default=settings.solana_rpc_url)
    args = p.parse_args()
    check(args.name, args.url)

    secret = settings.oracle_keypair.get_secret_value() if settings.oracle_keypair else ""
    if not secret:
        sys.exit("ORACLE_KEYPAIR is not set (JSON array of 64 numbers, in the environment or backend/.env)")
    oracle = keypair_from_json(secret)
    del secret
    program = Pubkey.from_string(args.program)
    info_addr = oracle_info_pda(oracle.pubkey(), program)

    ix = register_oracle_ix(oracle.pubkey(), args.name, args.url, program)
    async with PresenceChain(args.rpc) as chain:
        try:
            sig = await chain._send([ix], oracle)
        except PresenceError as e:
            sys.exit(f"failed: {e}")
    print(f"registered oracle {oracle.pubkey()} as {args.name!r} at {args.url}")
    print(f"  entry {explorer_address(info_addr)}")
    print(f"  tx    {explorer_tx(sig)}")


if __name__ == "__main__":
    asyncio.run(main())
