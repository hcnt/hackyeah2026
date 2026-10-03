---
format: 1920x1080
duration: 45s
message: "Rewards that get people to your event, without the swag logistics: you choose the prize, blockchain executes it"
arc: Hook → Rewards carousel → Why physical rewards hurt → You choose, blockchain executes → Embedded where you need it → Sign up → 2-step wizard → Into the chain
audience: our hackathon teammates
mode: collaborative
---

# Pitch v5 — storyboard

## Decisions

- **Message:** Rewards that get people to your event, without the swag logistics. You choose the prize; blockchain executes it.
- **Positioning (user, v4):** we are the alternative to physical gifts, which are hard to distribute, cost money, take lots of work, and are hard to set up and keep track of.
- **Audience and arc:** teammates. Hook → rewards carousel → the pain of physical rewards → "You choose the prize. Blockchain executes it." → embedded (website, chat) → sign-up press → 2-step wizard (wallet, selfie) → success, absorbed into the chain. Camera/oracle/payout come in a later round.
- **Format:** 1920x1080, 16:9. This round ≈ 36.5s of the 45s target. On-screen text only, music bed, no voiceover.
- **Tone rule:** the payout is a nice bonus for showing up, never the reason people look for an event.
- **The spine:** the reward line. Carousel in 02 → crushed by logistics in 03 → handed to the organizer and the chain in 04 → live in the widget in 05–08 → consumed by the chain in 08.
- **Product name (placeholder):** Attend Now.
- **Brand (provisional):** canvas #F3F2EE, ink #15161A, muted #6B6D74, hairline #D9D7D0, accent #2775CA (USDC blue), problem red #C8402F (frame 03 only). **Type: Geist everywhere** (user, v4). Headlines Geist 800, UI Geist 400–600, numbers and hashes Geist Mono 500.
- **Wallet marks:** official logos resolved via media-use into `.media/images/`: MetaMask (logo_001), Phantom (logo_002, favicon quality; upgrade at build), Coinbase Wallet (logo_003), Trust Wallet (logo_004), WalletConnect (logo_005). Rainbow: no official mark found, dropped.
- **Bans:** no neon or purple gradients, no gradient text, no coin clip-art, no "get paid to attend" framing, no wallet names in text on the button (logos only).
- **Held frame:** 04, "You choose the prize. Blockchain executes it." Holds ~1s.

## Changes from v3

- User: "Make all of the slides use Geist font." → Satoshi dropped; Geist everywhere.
- User: we present ourselves as the alternative to physical gifts ("hard to distribute, costs money, requires lots of work, hard to set up and hard to keep track of"). → new Frame 03 (the pain), before the turn.
- User: "You choose the price, blockchain executes it." → Frame 04 is now two lines: "You choose the prize." / "Blockchain executes it."
- User: hook not settled. "We need to figure out the first one." → Frame 01 shows three hook candidates (A/B/C) to pick from.
- User: show someone pressing "Sign up" with the wallet logos switching; "Don't use MetaMask [as text]. Use the logos and icons." → new Frame 06 (sign-up press), button shows logos only.
- User: zoom into the widget, press sign up, a small 2-step wizard: 1. wallet registered / thank-you proof, 2. a selfie. → new Frame 07.
- User: "The widget is successful. It minimizes and it goes into the blockchain, consumed by it." → new Frame 08.

## Changes from v4

- User: hook is B, "Want people at your event? Give them a reason to show up."
- User: in 03, "1000 users get a gift bag" shrinks to "1000 gift bags", moves left, and after the period the red cons stack on top of one another.
- User: in 04, "You choose the prize. Blockchain executes it." with an animation of blocks connecting underneath as each word appears, quick.
- User: the rest of the flow is fine.

## Locked

- v5 layout locked by the user ("build it"). Built as 8 sub-compositions in compositions/frames/, 37.0s total.

## Still open

- Wizard step 1: read "Thank you proof" as "wallet connected + signed proof that you own it, thank you". Confirm.
- Codex window: needs a real screenshot of the Codex app to rebuild pixel-perfect. Build uses an unbranded neutral chat window for now.
- Background music: HeyGen catalog needs `heygen auth login`; or the user supplies an mp3.

## Frame 1 — Hook

- scene: "Want people at your event?" then "Give them a reason to show up."
- duration: 3s
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- blueprint: kinetic-type-beats
- voiceover: onscreen

**01 — Hook (0.0–3.0s, ~3s).** Geist 800, left-anchored. The question "Want people at your event?" lands (1.4s), then "Give them a reason to show up." cuts in under it, with "reason to show up" in accent (1.6s). Constraint: no crowd photos, no emoji. Seam out: hard cut into the carousel; the "reason" is what 02 cycles. Why: grab the organizer with their own goal.

## Frame 2 — Rewards carousel

- scene: "First [100] users get [a coffee]." Tokens swap: 200 / a gift, 500 / a T-shirt, 1000 / a gift bag
- duration: 6.5s
- transition_in: cut
- status: animated
- src: compositions/frames/02-rewards.html
- blueprint: fixed-anchor-cycle
- voiceover: onscreen

**02 — Rewards carousel (3.0–9.5s, ~6.5s).** "First" and "users get" pinned; number (Geist Mono, accent) rolls like an odometer, prize hard-cuts: 100 · a coffee → 200 · a gift → 500 · a T-shirt → 1000 · a gift bag. Icon at right changes per prize. Soft tick per swap. Seam out: the line holds on "1000 users get a gift bag." and becomes 03's center. Why: rewards work, and organizers already use them.

## Frame 3 — Why it hurts

- scene: "1000 users get a gift bag." shrinks to "1000 gift bags." and slides left; after the period, red cons stack one on top of another
- duration: 4.5s
- transition_in: morph
- status: animated
- src: compositions/frames/03-pain.html
- rules: text morph (shrink + slide), stacked list build
- voiceover: onscreen

**03 — Why it hurts (9.5–14.0s, ~4.5s).** 02's final line morphs: "1000 users get a gift bag." shrinks to "1000 gift bags." (Geist 800) and slides to the left half. To the right of the period, a red hairline draws, and the cons stack one on top of another, about 0.6s each, each new one pushing the stack: "Costs money upfront." · "Hard to distribute." · "Lots of manual work." · "Hard to set up." · "Impossible to track." (Geist 700, #C8402F). Constraint: the user's own pains, nothing invented. Seam out: everything is swept off left. Why: the problem we replace, which is our positioning.

## Frame 4 — You choose, blockchain executes

- scene: "You choose the prize. Blockchain executes it." word by word, each word dropping a block underneath that links to the previous
- duration: 3.5s
- transition_in: push-left
- status: animated
- src: compositions/frames/04-choose.html
- blueprint: kinetic-type-beats
- rules: per-word stagger, block snap + link draw
- voiceover: onscreen

**04 — You choose, blockchain executes (14.0–17.5s, ~3.5s).** Quick word-by-word build, ~0.2s per word: as each word of "You choose the prize. / Blockchain executes it." appears, a block labelled with that word (Geist Mono) snaps in underneath and a link draws to the previous block, forming a 7-block chain across the bottom. The blocks for "blockchain executes it" fill with accent. Held ~1s. Seam out: the next headline crashes in and shoves it left. Why: the turn and our thesis. The chain is literally built by the sentence.

## Frame 5 — It's embedded where you need it

- scene: Headline, then website with widget, then Codex chat search for crypto events in Kraków, then our widget inline in the reply
- duration: 6.5s
- transition_in: push-left
- status: animated
- src: compositions/frames/05-embed.html
- blueprint: device-surface-showcase
- rules: ticker-takeover crash-in entrance
- voiceover: onscreen

**05 — It's embedded where you need it (17.5–24.0s, ~6.5s).** "It's embedded where you need it." crashes in (1.5s), then shrinks to a pinned top-left label while surfaces cut in from the right, ~1.6s each: **05b** event website "ethkrakow.events" with our widget in the sidebar and a `<script>` chip; **05c** the Codex window (rebuilt 1:1 from a screenshot), with the user asking "Any crypto events in Kraków this weekend?" and the reply "Found one: ETH Kraków Meetup · Sat 18:00" with our widget inline. Seam out: the camera pushes into the in-chat widget. Why: distribution, wherever people find events.

## Frame 6 — Sign up

- scene: Zoomed widget; the button "Sign up with [logo]" cycles wallet logos; a cursor presses it
- duration: 3.5s
- transition_in: zoom-through
- status: animated
- src: compositions/frames/06-signup.html
- blueprint: cursor-ui-demo
- rules: fixed-anchor-cycle for the logo carousel in the button
- voiceover: onscreen

**06 — Sign up (24.0–27.5s, ~3.5s).** The widget fills the frame: "ETH Kraków Meetup" · "Attendance bonus" pill · "First 200 attendees earn 10 USDC" · progress bar. Pinned button: "Sign up with" + a logo slot cycling about every 0.5s: MetaMask → Phantom → Coinbase Wallet → Trust Wallet → WalletConnect, with logos only and no wallet names. The cursor glides in, the cycle stops on one logo, press: the button squashes and ripples. Seam out: the widget body slides to step 1 of the wizard. Why: the attendee's one tap.

## Frame 7 — Two-step wizard

- scene: Step 1 of 2: wallet connected, signed proof, thank you. Step 2 of 2: take a selfie
- duration: 5s
- transition_in: slide-left
- status: animated
- src: compositions/frames/07-wizard.html
- blueprint: device-surface-showcase
- rules: cursor-ui-demo press on the shutter
- voiceover: onscreen

**07 — Two-step wizard (27.5–32.5s, ~5s).** Same widget card, a stepper on top (1 · Wallet, 2 · Selfie). **07a Wallet:** check mark, "Wallet connected", address "0x7a3F…21cE" (Geist Mono), "Signed. Thanks for proving it's you." **07b Selfie:** a circular viewfinder with a face silhouette and a dashed scan ring, "Take a quick selfie so the event camera can check you in.", shutter button pressed by the cursor, then the ring completes. Constraint: no real face photo, silhouette only. Seam out: the card flips to its success state. Why: the two facts the contract needs, who you are and what you look like.

## Frame 8 — Into the chain

- scene: Success state "You're in." then the widget minimizes and is absorbed into a chain of blocks
- duration: 4s
- transition_in: cut
- status: animated
- src: compositions/frames/08-chain.html
- blueprint: logo-assemble-lockup
- rules: shrink-and-fly, absorb pulse
- voiceover: onscreen

**08 — Into the chain (32.5–36.5s, ~4s).** **08a:** the card shows a big check, "You're in." and "10 USDC unlocks when you show up." (1.5s). **08b:** the card shrinks into a small rounded tile and flies right into a horizontal chain of blocks (hashes in Geist Mono). The newest block swallows it and pulses accent, labelled "Rule #0042 · on-chain". Constraint: blocks are simple rounded squares linked by short lines; no 3D cubes, no coin rain. Seam out: hold (end of this round). Why: the handoff from our UI to the chain. "Blockchain executes it" becomes visible.
