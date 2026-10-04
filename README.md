# OnSight: seen on site, paid on chain

Superteam Poland challenge "Finance Without Intermediaries", HackYeah 2026.

**Attendance giveaways without a middleman.** An attendance giveaway is a sponsor's promise to reward the people
who actually come to an event: "the first 100 people at the venue get 0.01 SOL", a coffee, a T-shirt. It's how
events fight no-shows, and today it only works if everyone trusts whoever holds the prizes and the guest list.

With OnSight, an organizer or sponsor locks the giveaway budget in a Solana program. Attendees opt in with their
wallet and one selfie, through a widget on the event's own page. At the venue, a camera at a check-in point streams
footage of attendees to face-recognition **oracles**. The oracles only report "I see this wallet now". The
**program** decides who gets paid, and pays each attendee once, straight from the escrow to their wallet.

**Who it's for:** organizers and sponsors of events (meetups, hackathons, product launches, conference side events)
who run attendance giveaways to make sign-ups actually come, and their attendees. Attendees never see blockchain
terms beyond "connect your wallet and sign".

## Try it yourself (devnet, about 5 minutes)

Everything runs on Solana devnet, so it costs nothing real. You play both sides: the organizer who funds the
giveaway and the attendee who gets paid.

**You need:** a laptop with a webcam, a phone, MetaMask with Solana enabled and switched to **devnet**, and about
0.3 devnet SOL from [faucet.solana.com](https://faucet.solana.com).

1. **Create the event.** Open [onsight.site](https://onsight.site), sign
   in with MetaMask and click **Create event**. Enter a name. The defaults are made for this test: it starts
   now and ends in 15 minutes, 0.02 SOL for each of 10 attendees, 5 seconds on camera, and two oracles (OnSight
   and OnSight 2) that must both agree. Click **Save terms**, then **Launch event** and approve the transaction:
   about 0.222 SOL is now locked in the program (rewards, oracle fees and the account deposit).
2. **Add the camera.** Click **Open dashboard**. Under **Cameras**, click **Pair cameras** (one free signature),
   then the QR icon next to **Add a camera**, and scan it with the phone. The phone now streams to the oracle.
3. **Join as an attendee.** On the dashboard, click **Attendee page**. In the widget, connect MetaMask, take a
   selfie, accept the consent and sign the join message. Joining is free: it's a signature, not a transaction.
4. **Get seen.** Point the phone at your face. After 5 seconds on camera, the payout appears under **Payouts**
   with an Explorer link, and 0.02 SOL arrives in the wallet you joined with. Nobody approved it: the program paid
   because the oracle's reports met the terms you locked in step 1.
5. **After the end**, open the event's settings (the cog) and withdraw what's left. While the event runs, the program
   refuses.

**If something doesn't work:** the public devnet RPC sometimes rate-limits; wait a moment and retry. The oracle
needs a clearly lit face looking at the camera.

## Design rationale

### The financial relationship: an attendance giveaway

A sponsor wants people in the room and is willing to pay for it, so the event announces an attendance giveaway:
"the first 100 people who come get 0.01 SOL". Today that promise runs through intermediaries:

- **The attendee trusts the organizer** to really pay out after the event, to the people who really came, and
  not to change the terms ("we ran out", "only the first 50").
- **The sponsor trusts the organizer**, or a check-in agency or ticketing platform, that the claimed attendance is
  real and that their budget went to real attendees and not to friends or to nobody.
- **Someone in the middle holds the money and keeps the list**: checks people in at the door, decides who
  counts, and pays out by hand. That person can be wrong, slow or dishonest, and nobody outside can verify them.

### What changes when the intermediary is removed

| Before | With OnSight |
|---|---|
| The organizer holds the reward budget. | The budget is **locked in the program's escrow** when the event is created. Nobody, us included, can take it while the event runs (as long as the program isn't upgraded, see Limitations); what is not paid out goes back to the organizer after the end. |
| Rules live in a promise ("first 100, arrive before 18:00"). | Rules are **frozen in the Event account**: reward, cap, time window, how long a person must be seen, which oracles count and how many must agree. |
| Staff decide who came. | Independent **oracles report sightings**; the **program** checks them against the frozen rules on the chain's clock and pays. |
| Payouts happen later, by hand, if at all. | The payout is **in the same transaction** as the report that satisfies the rules: seconds after the person is seen. |
| Nobody can audit the list. | Every payout is a **public transaction**. A sponsor can count them on Solana Explorer. |
| The organizer can add their own friends. | A report is only accepted with the **attendee's own wallet signature** over the join message for this event, checked on chain. An oracle cannot report someone who never signed up. |

The oracles are the one part that stays off chain, because a program can't see faces. They work like price
oracles (Pyth, Switchboard): they supply facts, and the program decides. Their power is narrow by construction:

- they can only report wallets that signed up for this event themselves;
- an event can require several oracles to agree (M-of-N);
- the time spent on camera is measured on the chain's clock, not taken from the oracle;
- they can't pay anyone, change an amount, or touch the budget.

Running an oracle is a business anyone can enter: the program pays the oracle 0.002 SOL for each attendee its
report pays, which covers its transaction fees and deposits.

### Why a blockchain and not a database

- The sponsor's money sits under rules that neither the organizer nor we can change after creation.
- Attendees don't have to trust the organizer to pay; the payout is automatic.
- Payouts are public and auditable by the sponsor without asking anyone.
- Several independent oracles can check each other only if the decision lives somewhere none of them controls.
- Paying 0.01 SOL costs about 0.00001 SOL in fees, so small per-person rewards make sense.

### Where exactly the intermediary disappears

In `report_sighting` (`contracts/on_sight/lib.rs`). An oracle can only *report* that it sees a wallet; this
instruction decides whether that pays. It accepts the report only from one of the event's oracles, only with the
attendee's own signed join (`check_join_proof`), and only during the event. It pays only once enough different
oracles have seen the person for long enough on the chain's clock, and only while the cap isn't reached. Then
the reward goes straight from the escrow to the attendee in the same transaction. No person approves anything.

The money side: `create_event` locks the whole budget and freezes the rules, and `withdraw_remaining` returns the
rest to the organizer only before the start or after the end.

### The web apps are not a source of truth

The events app, the widget and the camera page are static files with no OnSight server or database behind them.
They read the program's accounts from a Solana RPC, sign with the user's wallet, and talk to the oracles listed on
the event; the only thing they keep is a cache in the browser. Anyone can build `frontend/` and host it themselves,
or point it at their own RPC with `?rpc=<url>`. If onsight.site went down, events, budgets and payouts
would carry on.

## How it works

1. **Organizer creates the event on chain** in the events app (`create_event`): name, venue, reward, cap,
   window, minimum time on camera, oracles, threshold. The budget moves into escrow.
2. **Attendee joins** on the event's page through the widget: connects MetaMask (Solana), takes one selfie,
   accepts the consent and signs one message. Free, no transaction. The widget reads the event's terms and
   oracles from the chain and sends the join to every oracle.
3. **At the venue**, the organizer opens the event dashboard, signs once, and a phone scans a QR code to become the
   camera. It streams to every oracle.
4. **Oracles recognize** guests (only people on the guest list can be matched) and report each recognized wallet
   every 2 s: one transaction with the attendee's signature check followed by `report_sighting`.
5. **The program pays** when the rules hold. The dashboard shows the payout with an Explorer link.
6. **After the end**, oracles destroy the guest list, and the organizer withdraws what's left.

## What is where

| Path | What |
|---|---|
| `contracts/on_sight/` | The Anchor program (`lib.rs`), its IDL and a Solana Playground test. |
| `backend/app/oracle/` | The oracle: join API (signature and photo checks), encrypted in-memory guest lists, face recognition (InsightFace), tracking, camera and stage WebSockets. |
| `backend/app/chain/` | Solana client for the program: reads events, sends reports with the join proof, finds payout transactions. |
| `backend/tests/` | Tests, including the compiled program run in LiteSVM (`tests/chain/test_program_litesvm.py`). |
| `frontend/src/widget/` | The embeddable widget (`<attend-now-widget>`, built to `widget.js`): wallet, selfie, consent, join to every oracle. |
| `frontend/src/dapp/` | The organizer's events app (`events.html`): create and fund events, follow payouts and oracles, pair cameras, withdraw. |
| `frontend/src/organizer/` | The client for the program's instructions (`program.ts`): create, fund and withdraw. |
| `frontend/src/venue/` | Camera page (`camera.html`) a phone opens from the dashboard's QR code, and the older stage screen (`stage.html#<event>`). |
| `frontend/src/event-page/` | An example host page with the widget embedded. |
| `scripts/` | `devnet_event.py` creates a devnet event; `register_oracle.py` publishes an oracle's name and URL on chain. |

Embedding the widget on any page:

```html
<script src="https://onsight.site/widget.js"></script>
<attend-now-widget event-id="<Event address>"></attend-now-widget>
```

## Trust and permissions

| Operation | Who may do it | When |
|---|---|---|
| `create_event` | anyone (they become the organizer and fund it) | any time |
| `report_sighting` | an oracle listed on the event, with the attendee's signed join | during the event |
| `withdraw_remaining` | that event's organizer | before the start or after the end |
| `close_attendance` | the oracle that paid the Attendance account's deposit | after the end |
| `register_oracle` | any key, for its own entry | any time |

There's no admin and no other operation: nobody, us included, can change an event's terms or touch its budget.
Until the program is made final, whoever deployed it can still upgrade the code.

**If a party disappears halfway:** if the organizer vanishes, the budget stays in escrow and payouts keep working;
after the end, only the organizer can take back what's left, so it stays in the escrow until they return. If the
oracles stop, nobody is paid and the organizer withdraws everything after the end.

## Limitations (known, deliberate for the hackathon)

- **The program is upgradeable** by whoever deployed it, until the upgrade authority is set to final
  (`solana program set-upgrade-authority <PROGRAM_ID> --final`). We plan to do that once the code is final.
- **Oracle trust.** Our demo events require 2 of 2 oracles, but both are run by us, so together they could still
  report a registered person who didn't come. M-of-N with independent operators reduces this; it doesn't remove it.
- **The organizer picks the oracles.** An organizer running their own oracle could simply never report anyone and
  withdraw the budget after the end. The oracle list is public and the widget shows it before joining, so
  attendees can see who they're trusting. Next step: oracles assigned at random from an open pool, each with a
  deposit (stake) locked in the program; after the event, an oracle that consistently disagrees with the others
  on who was there loses part of it.
- **The oracle fee is a fixed constant**: 0.002 SOL per paid attendee (`FEE_LAMPORTS` in the program), copied into
  each event at creation. On chain, a payout costs the oracle about 0.00001 to 0.00004 SOL in transaction fees,
  so the fee is far above that, but it ignores the oracle's real costs (GPU, bandwidth) and can only change with a
  program upgrade.
- **A photo held up to the camera isn't caught**, so someone could collect the reward for a registered friend who
  didn't come. Production needs liveness detection.
- **Biometrics and GDPR.** The lawful setting is a check-in point people step up to after explicit, separate
  consent, with a non-biometric alternative; scanning a whole room isn't.

## Run it

Devnet only. The program ID lives in `contracts/on_sight/lib.rs` (`declare_id!`), the backend's
`PRESENCE_PROGRAM_ID` and the widget's `DEFAULT_PROGRAM_ID` (`frontend/src/widget/chain.ts`).

```sh
# backend (oracle) on :8000; without ORACLE_KEYPAIR it uses an in-memory stand-in for the program
cd backend && uv run uvicorn app.main:app --reload
# frontend on :5173, proxies /api -> :8000
cd frontend && npm run dev
# tests (add PRESENCE_SO=<built on_sight.so> to run the program itself in LiteSVM)
cd backend && uv run pytest -q
# a devnet event
cd backend && uv run python ../scripts/devnet_event.py --name "HackYeah 2026" --venue "Tauron Arena"
```


## Deployment

```
onsight.site ───────┐
pr-12.onsight.site ─┼─ Cloudflare ─ tunnel ─ cloudflared (host, systemd) ─ 127.0.0.1:8080
pr-15.onsight.site ─┘                                                         │
                                                          edge router (edge/, routes by Host)
                                                  ┌───────────────┼───────────────┐
                                             prod stack      pr-12 stack     pr-15 stack
                                          (caddy + backend, each its own compose project)
```

- Cloudflare terminates TLS. The VPS needs **no inbound ports** (only SSH).
- The edge router is the only thing published on the host (`127.0.0.1:8080`). Each stack's caddy joins
  the shared `edge` network under the alias `prod` or `pr-<N>`; inside a stack, caddy serves the React
  build and proxies `/api/*` to FastAPI.

| Workflow | Trigger | Does |
|---|---|---|
| `deploy.yml` | push to `main` | rsync to `/opt/hackyeah2026`, `scripts/deploy-prod.sh` (edge + prod, health check) |
| `preview.yml` | PR opened/updated | rsync to `/opt/hackyeah2026-previews/pr-N`, `scripts/deploy-preview.sh N` |
| `preview.yml` | PR closed/merged | `scripts/teardown-preview.sh N` (containers, volumes, images, checkout) |
| `preview-cleanup.yml` | daily 03:00 UTC | removes previews of PRs that are no longer open |

Each PR gets `https://pr-<N>.onsight.site`. Repo secrets: `DEPLOY_HOST`, `DEPLOY_SSH_KEY`,
`DEPLOY_KNOWN_HOSTS`. Every other repo variable and secret (e.g. `ORACLE_KEYPAIR`, `PRESENCE_PROGRAM_ID`, see
`.env.example`) is written to prod's `.env` on every deploy; previews get no `.env` and use the in-memory stand-in.

Run the full stack locally with Docker:

```sh
docker compose -f edge/compose.yaml up -d --build   # once; owns :8080 and the "edge" network
docker compose -p prod up -d --build                # http://localhost:8080
```

If the site breaks, test the origin first on the VPS:
`curl -H 'Host: onsight.site' http://127.0.0.1:8080/api/health`. Origin OK means the problem is in the
tunnel or Cloudflare, not the app.
