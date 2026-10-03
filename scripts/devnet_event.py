"""Create a test event on the presence_pay program (devnet) and print its address, the oracle's `event_id`.

    cd backend && uv run python ../scripts/devnet_event.py [--reward 0.01] [--max 3] [--hours 2] [--min-seen 3]
        [--oracle <pubkey> [--oracle <pubkey> ...]] [--threshold 1] [--program <program id>]

The organizer chooses the event's oracles (1-3, default: our backend's oracle key) and how many of them must report a
wallet (--threshold). Oracles only report sightings; the program pays once `threshold` of them saw the wallet for
`--min-seen` seconds. The fee per paid attendee is the program's FEE_LAMPORTS (0.002 SOL), frozen into the event;
it goes to the oracle whose report paid.

A test organizer keypair is kept at ~/.config/attend-now/organizer-devnet.json (created on first run, never in the
repo) and topped up from the devnet faucet when it runs low. The event starts now, so sightings count at once.
"""

import argparse
import base64
import hashlib
import json
import struct
import sys
import time
import urllib.request
from pathlib import Path

from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.system_program import ID as SYSTEM_PROGRAM
from solders.transaction import Transaction

RPC = "https://api.devnet.solana.com"
# OLD program id (superseded). Its create_event accounts do NOT match what this script builds (no Config account
# any more): replace with the new id after the redeploy, or pass --program <new id>.
DEFAULT_PROGRAM = "4YhphZrWqUUdjnyT3c8r6Wre2e27BZvqoCQWbEmcQdmf"
# Our backend's oracle (public key, see contracts/presence_pay/README.md).
DEFAULT_ORACLE = "5aCXNpzkmYiruMNobXCVBivoUPQPxrsogp3FMhxvf5Dt"
KEY_FILE = Path.home() / ".config/attend-now/organizer-devnet.json"
LAMPORTS = 1_000_000_000
FEE_LAMPORTS = 2_000_000  # lib.rs FEE_LAMPORTS: per paid attendee, frozen into the Event at creation


def rpc(method: str, params: list) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"content-type": "application/json"})
    reply = json.load(urllib.request.urlopen(req, timeout=30))
    if "error" in reply:
        raise RuntimeError(f"{method}: {reply['error'].get('message', reply['error'])}")
    return reply["result"]


def organizer() -> Keypair:
    if KEY_FILE.exists():
        return Keypair.from_bytes(bytes(json.loads(KEY_FILE.read_text())))
    kp = Keypair()
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    KEY_FILE.write_text(json.dumps(list(bytes(kp))))
    KEY_FILE.chmod(0o600)
    return kp


def balance(pk: Pubkey) -> int:
    return rpc("getBalance", [str(pk), {"commitment": "confirmed"}])["value"]


def wait_confirmed(sig: str, timeout: float = 60) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        st = rpc("getSignatureStatuses", [[sig]])["value"][0]
        if st and st.get("err"):
            raise RuntimeError(f"transaction failed: {st['err']}")
        if st and st.get("confirmationStatus") in ("confirmed", "finalized"):
            return
        time.sleep(1.5)
    raise TimeoutError(f"not confirmed after {timeout:.0f} s: {sig}")


def ensure_funds(pk: Pubkey, needed: int) -> None:
    have = balance(pk)
    if have >= needed:
        return
    print(f"Organizer has {have / LAMPORTS:.4f} SOL, needs {needed / LAMPORTS:.4f}; asking the devnet faucet ...")
    try:
        wait_confirmed(rpc("requestAirdrop", [str(pk), LAMPORTS]))
    except Exception as e:  # noqa: BLE001 - the public faucet is often rate-limited
        sys.exit(f"Airdrop failed ({e}). Fund {pk} at https://faucet.solana.com (devnet) and run again.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--reward", type=float, default=0.01, help="SOL per attendee")
    ap.add_argument("--max", type=int, default=3, help="max attendees paid")
    ap.add_argument("--hours", type=float, default=2.0, help="event length from now")
    ap.add_argument("--min-seen", type=int, default=3, help="seconds on camera (chain clock) before payout")
    ap.add_argument("--oracle", type=Pubkey.from_string, action="append", dest="oracles",
                    help="a key allowed to report sightings for this event; repeat for up to 3 "
                    "(default: our backend's oracle)")
    ap.add_argument("--threshold", type=int, default=1, help="how many different oracles must report a wallet")
    ap.add_argument("--program", type=Pubkey.from_string, default=Pubkey.from_string(DEFAULT_PROGRAM),
                    help="presence_pay program id (default: the OLD id until the new deploy)")
    args = ap.parse_args()
    program: Pubkey = args.program
    oracles: list[Pubkey] = args.oracles or [Pubkey.from_string(DEFAULT_ORACLE)]
    if not 1 <= len(oracles) <= 3 or len(set(oracles)) != len(oracles):
        sys.exit("--oracle: give 1 to 3 distinct keys")
    if not 1 <= args.threshold <= len(oracles):
        sys.exit(f"--threshold must be between 1 and {len(oracles)} (the number of oracles)")

    org = organizer()
    fee = FEE_LAMPORTS

    reward = round(args.reward * LAMPORTS)
    budget = args.max * (reward + fee)
    ensure_funds(org.pubkey(), budget + LAMPORTS // 100)  # + room for rent and fees

    event_id = int(time.time() * 1000)
    event, _ = Pubkey.find_program_address([b"event", bytes(org.pubkey()), struct.pack("<Q", event_id)], program)
    start = int(time.time()) - 60
    end = start + 60 + int(args.hours * 3600)
    # create_event(event_id u64, oracles Vec<Pubkey>, threshold u8, start i64, end i64, reward u64, max_paid u32,
    # min_seen_secs u32); a Borsh Vec is a u32 length followed by the items.
    data = (
        hashlib.sha256(b"global:create_event").digest()[:8]
        + struct.pack("<QI", event_id, len(oracles))
        + b"".join(bytes(o) for o in oracles)
        + struct.pack("<BqqQII", args.threshold, start, end, reward, args.max, args.min_seen)
    )
    ix = Instruction(
        program,
        data,
        [
            AccountMeta(org.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(event, is_signer=False, is_writable=True),
            AccountMeta(SYSTEM_PROGRAM, is_signer=False, is_writable=False),
        ],
    )
    blockhash = Hash.from_string(rpc("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"])
    tx = Transaction([org], Message([ix], org.pubkey()), blockhash)
    sig = rpc("sendTransaction", [base64.b64encode(bytes(tx)).decode(), {"encoding": "base64"}])
    wait_confirmed(sig)

    print(f"Event created: {event}")
    print(f"  reward {reward / LAMPORTS} SOL × {args.max}, fee {fee / LAMPORTS} SOL, min seen {args.min_seen} s")
    print(f"  oracles {', '.join(map(str, oracles))}, threshold {args.threshold} (program {program})")
    print(f"  ends {time.strftime('%H:%M', time.localtime(end))}; budget {budget / LAMPORTS:.4f} SOL in escrow")
    print(f"  tx https://explorer.solana.com/tx/{sig}?cluster=devnet")
    print(f"  event https://explorer.solana.com/address/{event}?cluster=devnet")


if __name__ == "__main__":
    main()
