# presence_pay: Solana program

Escrow for Attend Now. An organizer funds an event and sets its terms; the oracle (our backend) triggers a payout
for each recognised attendee; the program enforces the terms on-chain.

| | |
|---|---|
| Cluster | **devnet** |
| Program ID | `4YhphZrWqUUdjnyT3c8r6Wre2e27BZvqoCQWbEmcQdmf` |
| Admin | `41XRq2v3ss42Nkp4aHQo8njX7uPgRRofHjp2Nz3T5jMo` |
| Oracle (backend signer) | `5aCXNpzkmYiruMNobXCVBivoUPQPxrsogp3FMhxvf5Dt` |
| Treasury (platform fees) | `CVSGhXL42rMpbk7sJVEXsu7bQooQd1YYxJ9rz5uCTi8N` |
| Platform fee | 0.002 SOL per payout |
| Framework | Anchor (built in Solana Playground with Anchor 0.29; also compiles with 0.31 and 1.2) |

Explorer: https://explorer.solana.com/address/4YhphZrWqUUdjnyT3c8r6Wre2e27BZvqoCQWbEmcQdmf?cluster=devnet

Files: `lib.rs` (the program), `idl.json` (interface for clients), `anchor.test.ts` (Playground test).

**Keypairs are never committed.** The oracle key goes to the server's `.env` only.

## Accounts

| Account | PDA seeds | Fields |
|---|---|---|
| `Config` | `["config"]` | `admin`, `oracle`, `treasury`, `fee` (lamports), `bump` |
| `Event` | `["event", organizer, event_id as u64 LE]` | `organizer`, `event_id`, `start`, `end` (unix s), `reward`, `fee` (lamports), `max_paid`, `paid_count`, `min_seen_secs`, `bump` |
| `Receipt` | `["paid", event, attendee]` | `event_end`, `bump` |

The `Event` account is also the vault: it holds the event's budget as lamports. A `Receipt` exists exactly when that
wallet has been paid for that event, which is what makes a second payout impossible.

Mapping to `docs/oracle-api.md`: `event_id` in the API is the **address of the `Event` account**;
`reward_lamports` = `reward`, `max_payouts` = `max_paid`, `paid` = `paid_count`,
`spots_left` = `max_paid - paid_count`, `min_seen_secs` = `min_seen_secs`, `starts_at`/`ends_at` = `start`/`end`.
Name and venue are not on-chain.

## Instructions

| Instruction | Signer | Allowed when | Does |
|---|---|---|---|
| `init_config(oracle, treasury, fee)` | admin | once | creates `Config` |
| `update_config(oracle, treasury, fee)` | admin | any time | changes oracle / treasury / fee |
| `create_event(event_id, start, end, reward, max_paid, min_seen_secs)` | organizer | any time | creates `Event` and transfers `max_paid × (reward + fee)` into it; the fee is frozen per event |
| `update_event_times(start, end)` | organizer | before start | moves the times; amounts cannot change |
| `pay_attendee()` | oracle | `start ≤ now ≤ end`, `paid_count < max_paid` | creates `Receipt`, sends `reward` to the attendee and `fee` to the treasury |
| `withdraw_remaining()` | organizer | before start (cancel) or after end | closes `Event`, returns everything left to the organizer |
| `close_receipt()` | oracle | after the event's end | closes a `Receipt`, returns its rent to the oracle |

`pay_attendee` accounts, in order: `oracle` (signer, writable, pays the receipt rent), `config`, `event` (w),
`receipt` (w), `attendee` (w), `treasury` (w), `system_program`.

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
| 2001 | `ConstraintHasOne` | signer is not the oracle/admin stored in `Config` |
| — | "already in use" | `Receipt` exists: this wallet was already paid for this event |

## Build, deploy, test (Solana Playground)

1. https://beta.solpg.io → new Anchor project → replace `src/lib.rs` with `lib.rs`.
2. Wallet on **devnet** with ~3 SOL (https://faucet.solana.com), then `build` and `deploy` in the terminal.
3. Paste `anchor.test.ts` into `tests/` and run `test`.

**Running the test changes `Config`**: it sets the oracle to the Playground wallet and a random treasury. After
running it, call `update_config` again with the oracle and treasury above.

Changing the fields of `Config`, `Event` or `Receipt` after deploy breaks existing accounts: deploy a new program
ID instead, then update this README and `idl.json`.
