# presence_pay: Solana program

Escrow for Attend Now. An organizer funds an event, sets its terms and chooses its oracle; the oracle (by default
our backend) triggers a payout for each recognised attendee; the program enforces the terms on-chain.

**Guarantees.** The organizer chooses the oracle per event. The oracle, treasury, fee, reward, payout cap and
`min_seen_secs` are fixed per event at creation, and the times can only be moved by the organizer before the start;
nobody, including the platform admin, can change anything about a running event. `update_config` only affects
events created afterwards. After the final deploy, run `solana program set-upgrade-authority <PROGRAM_ID> --final`
so the code itself can never change (irreversible: do it only when the program is final).

| | |
|---|---|
| Cluster | **devnet** |
| Program ID | new id after redeploy (TBD) |
| Admin | `41XRq2v3ss42Nkp4aHQo8njX7uPgRRofHjp2Nz3T5jMo` |
| Oracle (our backend's signer, the default organizers pass to `create_event`) | `5aCXNpzkmYiruMNobXCVBivoUPQPxrsogp3FMhxvf5Dt` |
| Treasury (platform fees, default in `Config`) | `CVSGhXL42rMpbk7sJVEXsu7bQooQd1YYxJ9rz5uCTi8N` |
| Platform fee | 0.002 SOL per payout |
| Framework | Anchor (built in Solana Playground with Anchor 0.29; also compiles with 0.31 and 1.2; the per-event-oracle version was checked with `cargo check` against 0.31.2 only) |

The previous devnet program `4YhphZrWqUUdjnyT3c8r6Wre2e27BZvqoCQWbEmcQdmf` (global oracle in `Config`) stays
deployed but is superseded: its account layout differs from this `lib.rs`. `declare_id!` and `idl.json` still carry
the old id until the new deploy.

Files: `lib.rs` (the program), `idl.json` (interface for clients), `anchor.test.ts` (Playground test).

**Keypairs are never committed.** The oracle key goes to the server's `.env` only.

## Accounts

| Account | PDA seeds | Fields |
|---|---|---|
| `Config` | `["config"]` | `admin`, `treasury`, `fee` (lamports), `bump`: defaults for events created later |
| `Event` | `["event", organizer, event_id as u64 LE]` | `organizer`, `oracle`, `treasury`, `event_id`, `start`, `end` (unix s), `reward`, `fee` (lamports), `max_paid`, `paid_count`, `min_seen_secs`, `bump` |
| `Receipt` | `["paid", event, attendee]` | `event_end`, `oracle` (who paid its rent), `bump` |

The `Event` account is also the vault: it holds the event's budget as lamports. A `Receipt` exists exactly when that
wallet has been paid for that event, which is what makes a second payout impossible.

Mapping to `docs/oracle-api.md`: `event_id` in the API is the **address of the `Event` account**;
`reward_lamports` = `reward`, `max_payouts` = `max_paid`, `paid` = `paid_count`,
`spots_left` = `max_paid - paid_count`, `min_seen_secs` = `min_seen_secs`, `starts_at`/`ends_at` = `start`/`end`.
Name and venue are not on-chain.

## Instructions

| Instruction | Signer | Allowed when | Does |
|---|---|---|---|
| `init_config(treasury, fee)` | admin | once | creates `Config` |
| `update_config(treasury, fee)` | admin | any time | changes treasury / fee for events created afterwards only |
| `create_event(event_id, oracle, start, end, reward, max_paid, min_seen_secs)` | organizer | any time | creates `Event` with the chosen oracle and transfers `max_paid × (reward + fee)` into it; treasury and fee are copied from `Config` and frozen per event |
| `update_event_times(start, end)` | organizer | before start | moves the times; amounts cannot change |
| `pay_attendee()` | the event's oracle | `start ≤ now ≤ end`, `paid_count < max_paid` | creates `Receipt`, sends `reward` to the attendee and `fee` to the event's treasury |
| `withdraw_remaining()` | organizer | before start (cancel) or after end | closes `Event`, returns everything left to the organizer |
| `close_receipt()` | the receipt's oracle | after the event's end | closes a `Receipt`, returns its rent to the oracle |

`pay_attendee` accounts, in order: `oracle` (signer, writable, pays the receipt rent; must equal `event.oracle`),
`event` (w), `receipt` (w), `attendee` (w), `treasury` (w; must equal `event.treasury`), `system_program`.
`close_receipt` accounts: `oracle` (signer, w; must equal `receipt.oracle`), `receipt` (w).

Instruction data = Anchor discriminator `sha256("global:<snake_case_name>")[:8]` + Borsh args (little-endian).
Account data starts with `sha256("account:<Name>")[:8]`.

## Errors

| Code | Name | Meaning |
|---|---|---|
| 6000 | `BadTimes` | end is not after start |
| 6001 | `BadAmounts` | reward or max_paid is 0 |
| 6002 | `Overflow` | budget overflow |
| 6003 | `AlreadyStarted` | times changed after start |
| 6004 | `NotStarted` | payout before start |
| 6005 | `Ended` | payout after end |
| 6006 | `CapReached` | `max_paid` payouts already made |
| 6007 | `EventRunning` | withdraw or close_receipt while the event runs |
| 2001 | `ConstraintHasOne` | signer/treasury is not the one stored in the `Event` / `Receipt`, or admin is not the one in `Config` |
| — | "already in use" | `Receipt` exists: this wallet was already paid for this event |

## Build, deploy, test (Solana Playground)

1. https://beta.solpg.io → new Anchor project → replace `src/lib.rs` with `lib.rs`.
2. Wallet on **devnet** with ~3 SOL (https://faucet.solana.com), then `build` and `deploy` in the terminal.
3. Paste `anchor.test.ts` into `tests/` and run `test`.

**Running the test changes `Config`**: it sets a random treasury (its events use the Playground wallet as oracle).
After running it, call `update_config` again with the treasury and fee above.

Changing the fields of `Config`, `Event` or `Receipt` after deploy breaks existing accounts: deploy a new program
ID instead, then update this README and `idl.json`.
