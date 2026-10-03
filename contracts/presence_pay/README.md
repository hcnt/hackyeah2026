# presence_pay: Solana program

Escrow for Attend Now. An organizer funds an event, sets its terms and chooses its oracles; the oracles (by default
our backend) only **report sightings** ("I see wallet W now"); the **program decides** when a wallet is paid.

**Trust model.** The oracle is a sensor, not a judge (the Pyth/Chainlink pattern: oracles sign facts, the consumer
program decides). There is no instruction that pays directly: `report_sighting` pays only when the rules fixed at
creation hold — at least `threshold` of the event's 1–3 oracles reported the wallet (M-of-N), the wallet has been seen
for `min_seen_secs` on the **chain clock** (a gap of more than `SIGHTING_GAP_SECS` = 60 s between reports restarts
the dwell), `start ≤ now ≤ end`, `paid_count < max_paid`, and the wallet was not paid before. A dishonest backend can
still lie about what the camera sees, but it can no longer decide the payout terms, and with `threshold ≥ 2` one
oracle alone cannot pay anyone.

**Guarantees.** The organizer chooses the oracles and the threshold per event. The oracles, threshold, treasury, fee,
reward, payout cap and `min_seen_secs` are fixed per event at creation, and the times can only be moved by the organizer before the start;
nobody, including the platform admin, can change anything about a running event. `update_config` only affects
events created afterwards. After the final deploy, run `solana program set-upgrade-authority <PROGRAM_ID> --final`
so the code itself can never change (irreversible: do it only when the program is final).

| | |
|---|---|
| Cluster | **devnet** |
| Program ID | new id after redeploy (TBD) |
| Admin | `41XRq2v3ss42Nkp4aHQo8njX7uPgRRofHjp2Nz3T5jMo` |
| Oracle (our backend's signer, the default organizers pass in `create_event`'s `oracles`) | `5aCXNpzkmYiruMNobXCVBivoUPQPxrsogp3FMhxvf5Dt` |
| Treasury (platform fees, default in `Config`) | `CVSGhXL42rMpbk7sJVEXsu7bQooQd1YYxJ9rz5uCTi8N` |
| Platform fee | 0.002 SOL per payout |
| Framework | Anchor with the `init-if-needed` feature. The sightings version was built with `cargo build-sbf` against anchor-lang 0.31.2 and tested in LiteSVM (`backend/tests/chain/test_program_litesvm.py`); earlier versions were built in Solana Playground with Anchor 0.29 |

The previous devnet program `4YhphZrWqUUdjnyT3c8r6Wre2e27BZvqoCQWbEmcQdmf` (global oracle in `Config`, oracle-decided
`pay_attendee`) stays deployed but is superseded: its account layout and instructions differ from this `lib.rs`.
`declare_id!` and `idl.json` still carry the old id until the new deploy.

Files: `lib.rs` (the program), `idl.json` (interface for clients), `anchor.test.ts` (Playground test).

**Keypairs are never committed.** The oracle key goes to the server's `.env` only.

## Accounts

| Account | PDA seeds | Fields |
|---|---|---|
| `Config` | `["config"]` | `admin`, `treasury`, `fee` (lamports), `bump`: defaults for events created later |
| `Event` | `["event", organizer, event_id as u64 LE]` | `organizer`, `oracles` (`[Pubkey; 3]`, unused slots = default key), `oracle_count`, `threshold`, `treasury`, `event_id`, `start`, `end` (unix s), `reward`, `fee` (lamports), `max_paid`, `paid_count`, `min_seen_secs`, `bump` |
| `Sighting` | `["sighting", event, attendee]` | `first_seen`, `last_seen` (chain clock), `reporters` (bitmask over oracle slots), `paid`, `payer` (the oracle that paid its rent), `event_end`, `bump` |
| `OracleInfo` | `["oracle", oracle]` | `oracle`, `name` (String, ≤ 32 bytes), `url` (String, ≤ 128 bytes), `bump`: the oracle registry, see below |

The `Event` account is also the vault: it holds the event's budget as lamports. A wallet's `Sighting` is created by
the first report (rent ≈ 0.00136 SOL, paid by the reporting oracle, reclaimable after the end with `close_sighting`);
its `paid` flag is set in the paying transaction and checked first on every report, which is what makes a second
payout impossible. `event_end` is copied from the Event so a Sighting can still be closed after `withdraw_remaining`
closed the Event.

Mapping to `docs/oracle-api.md`: `event_id` in the API is the **address of the `Event` account**;
`reward_lamports` = `reward`, `max_payouts` = `max_paid`, `paid` = `paid_count`,
`spots_left` = `max_paid - paid_count`, `min_seen_secs` = `min_seen_secs`, `starts_at`/`ends_at` = `start`/`end`.
Name and venue are not on-chain.

## Instructions

| Instruction | Signer | Allowed when | Does |
|---|---|---|---|
| `init_config(treasury, fee)` | admin | once | creates `Config` |
| `update_config(treasury, fee)` | admin | any time | changes treasury / fee for events created afterwards only |
| `create_event(event_id, oracles: Vec<Pubkey>, threshold: u8, start, end, reward, max_paid, min_seen_secs)` | organizer | any time | creates `Event` with 1–3 distinct non-default oracles and `1 ≤ threshold ≤ oracles.len()`, transfers `max_paid × (reward + fee)` into it; treasury and fee are copied from `Config` and frozen per event |
| `update_event_times(start, end)` | organizer | before start | moves the times; amounts cannot change |
| `report_sighting()` | one of the event's oracles | `start ≤ now ≤ end` | records the sighting (creates the `Sighting` on first report); **pays** `reward` to the attendee and `fee` to the event's treasury when ≥ `threshold` oracles reported, `last_seen − first_seen ≥ min_seen_secs` and the wallet is unpaid; fails with `CapReached` if those hold but `max_paid` is reached; a no-op once paid |
| `withdraw_remaining()` | organizer | before start (cancel) or after end | closes `Event`, returns everything left to the organizer |
| `close_sighting()` | the sighting's payer | after the event's end | closes a `Sighting`, returns its rent to the oracle that paid it |
| `register_oracle(name, url)` | the oracle | once per key | creates its `OracleInfo` (the oracle pays the rent) |
| `update_oracle(name, url)` | the oracle (`has_one = oracle`) | any time | changes its name / url |
| `close_oracle()` | the oracle (`has_one = oracle`) | any time | deletes its `OracleInfo`, rent back to the oracle |

`report_sighting` rules, with `now` = the chain clock: if the wallet was already paid, return Ok (no change). On the
first report, or when `now − last_seen > SIGHTING_GAP_SECS` (60), the run restarts: `first_seen = now`,
`reporters = 0`. Then `last_seen = now` and the reporting oracle's slot bit is set in `reporters`. `min_seen_secs = 0`
with `threshold = 1` pays on the first sighting.

`report_sighting` accounts, in order: `oracle` (signer, writable, pays the sighting rent; must be in
`event.oracles`), `event` (w), `sighting` (w), `attendee` (w), `treasury` (w; must equal `event.treasury`),
`system_program`. `close_sighting` accounts: `payer` (signer, w; must equal `sighting.payer`), `sighting` (w).

`register_oracle` accounts: `oracle` (signer, w), `oracle_info` (w), `system_program`. `update_oracle`: `oracle`
(signer), `oracle_info` (w). `close_oracle`: `oracle` (signer, w), `oracle_info` (w). Strings are Borsh (u32 LE
length + UTF-8 bytes).

Instruction data = Anchor discriminator `sha256("global:<snake_case_name>")[:8]` + Borsh args (little-endian).
Account data starts with `sha256("account:<Name>")[:8]`.

## Oracle registry

Each event lists up to 3 oracle keys, and with `threshold ≥ 2` a wallet is paid only when several oracles have seen
it, so every one of them needs the attendee's join (selfie + signed join message). The attendee's widget therefore
reads the event's `oracles` **from the chain**, derives each oracle's `OracleInfo` PDA (`["oracle", oracle_key]`) and
sends the same signed join to every oracle's `url` (`POST {url}/api/v1/events/{event}/attendance`). Our API is not
asked which oracles exist, so we do not decide whom an attendee talks to; and the consent screen names every oracle
(`name` and the host of `url`) that will process the face signature.

The entry is written by the oracle's own key (`register_oracle`, rent ≈ 0.0023 SOL) and only that key can change or
delete it. It is informational: payouts never read it. Validation: `name` 1–32 bytes without control characters
(`BadName`); `url` starts with `https://` or `http://`, has something after the scheme, at most 128 bytes, no spaces or
control characters (`BadUrl`). The url is the oracle's base origin, without `/api/v1` and without a trailing slash.
An oracle without an entry cannot receive joins from the widget.

## Errors

| Code | Name | Meaning |
|---|---|---|
| 6000 | `BadTimes` | end is not after start |
| 6001 | `BadAmounts` | reward or max_paid is 0 |
| 6002 | `Overflow` | budget overflow |
| 6003 | `AlreadyStarted` | times changed after start |
| 6004 | `NotStarted` | sighting before start |
| 6005 | `Ended` | sighting after end |
| 6006 | `CapReached` | the wallet qualifies but `max_paid` payouts were already made |
| 6007 | `EventRunning` | withdraw or close_sighting while the event runs |
| 6008 | `BadOracles` | not 1–3 oracles, a duplicate, or the default key |
| 6009 | `BadThreshold` | threshold is 0 or more than the number of oracles |
| 6010 | `NotOracle` | `report_sighting` signer is not one of the event's oracles |
| 6011 | `BadName` | oracle name empty, over 32 bytes or with a control character |
| 6012 | `BadUrl` | oracle url not `http(s)://…`, over 128 bytes, or with spaces / control characters |
| 2001 | `ConstraintHasOne` | treasury is not the one stored in the `Event`, close_sighting signer is not the `Sighting`'s payer, admin is not the one in `Config`, or update/close_oracle signer is not the entry's oracle |

## Build, deploy, test (Solana Playground)

`report_sighting` uses `init_if_needed`, which needs the anchor-lang feature in the program's `Cargo.toml`:

```toml
anchor-lang = { version = "0.31.2", features = ["init-if-needed"] }
```

1. https://beta.solpg.io → new Anchor project → replace `src/lib.rs` with `lib.rs`, and enable the `init-if-needed`
   feature of `anchor-lang` in the project's `Cargo.toml` (above); without it the build fails.
2. Wallet on **devnet** with ~3 SOL (https://faucet.solana.com), then `build` and `deploy` in the terminal.
3. Paste `anchor.test.ts` into `tests/` and run `test`.
4. **Each oracle registers once** under the new program id, signed by its own key, so widgets can find it:
   `cd backend && ORACLE_KEYPAIR=… uv run python ../scripts/register_oracle.py --program <PROGRAM_ID> --name OnSight
   --url https://hackyeah.kindhome.io` (it calls `update_oracle` instead when the entry already exists). Other
   oracles run the same with their own key, name and url.

Locally: `cargo build-sbf` in an Anchor project with this `lib.rs` (and a `declare_id!` matching the deploy keypair),
then `cd backend && PRESENCE_SO=<path>/presence_pay.so uv run pytest tests/chain/test_program_litesvm.py` runs the
program in LiteSVM with the chain clock warped (the program id is read from `presence_pay-keypair.json` next to the
.so, or from `PRESENCE_SO_PROGRAM_ID`).

**Running the test changes `Config`**: it sets a random treasury (its events use the Playground wallet as oracle).
After running it, call `update_config` again with the treasury and fee above.

Changing the fields of `Config`, `Event`, `Sighting` or `OracleInfo` after deploy breaks existing accounts: deploy a new program
ID instead, then update this README and `idl.json`.
