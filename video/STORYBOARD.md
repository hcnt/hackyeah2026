---
format: 1920x1080
duration: 41.5s
message: "Rewards that bring your audience in, set up in one widget: you pick the rule, the chain pays it fairly"
arc: Hook → Rewards carousel → Organizer's questions → The answer becomes the widget → Embedded where you need it → Verification methods → Selfie enrollment → How it works (contract, oracle, organiser)
audience: our hackathon teammates
mode: collaborative
---

# Pitch v6 — storyboard

## Decisions

- **Message:** Rewards bring your audience in, but running them is the hard part. OnSight turns the rule into a widget, and the chain pays it fairly.
- **Product name:** OnSight (was Attend Now). The pun "earn … on sight" becomes the brand, then the "Powered by OnSight" pill.
- **Arc (user, v6):** hook → rewards carousel (first/random · count · prize) → "First 1000 attendees" plus the organizer's four questions → the answer line "First 1000 people earn 100 of your token on sight", which morphs into the 1a widget → widget moves right, "Embedded where you need it": our Luma-style event page, then a ChatGPT copy with the widget in the chat ("Embedded in an MCP app") → zoom into the widget, the verification methods (QR, phone, photo) → the photo flow and enrollment → the check becomes a box in the system diagram: Oracle, Smart contract, Organiser. End of this round.
- **Format:** 1920x1080, 16:9, ≈ 45s. On-screen text only, SFX, no voiceover (the user talks over it live).
- **Tone rule:** the payout is a nice bonus for showing up, never the reason people look for an event.
- **Brand:** canvas #F3F2EE, ink #15161A, muted #6B6D74, hairline #D9D7D0, accent #2775CA (USDC blue), success #1F8A5B. **Type: Satoshi everywhere** (user, v6.2): headlines Satoshi Bold 700 (user, v6.3: "less bold"), labels Satoshi 500, numbers Satoshi Bold. **The widget is the real product UI from Penpot "Widget v1"**: Satoshi, white card, black pill buttons, the "Powered by OnSight" frosted pill on 1a only.
- **Widget copy (from Penpot):** "First **1000** attendees earn" / "10 USDC" (34px) / split button "Sign up with MetaMask" + wallet tile / pill. No event header.
- **Wallet marks:** official logos already in `.media/images/` (MetaMask, Phantom, Coinbase Wallet, Trust Wallet, WalletConnect).
- **Bans:** no neon or purple gradients, no gradient text, no coin clip-art, no "get paid to attend" framing.

## v7 draft: How it works (still frames, not animated)

- Sketch sheet: `storyboard-how.html`. Seven frames replacing the current 08: 8a rules (prize, attendees, check-in window, method) → 8b funds locked in the contract → 8c wallet + face signature saved on chain (recap of 06–07) → 8d opt-in camera check at the venue → 8e timestamped frames streamed to several oracles → 8f quorum of oracles agrees on the match → 8g payout on chain in real time.
- v7.1 (user): organiser + "Organizer sets the rules and locks the money." → the sentence merges into the Smart contract block → OnSight oracle + finished widget appear → widget splits into Address and Address + face signature → Address docks into the contract, Address + face goes to the oracle network.
- v7.2 (user): organiser sets the rules → rules merge into a Contract block → it joins the chain → three finished widgets pop in one by one → they merge into one "3 wallets enrolled" block that attaches to the chain, while the photos fly to the oracle network that sat idle in the corner from the start → the oracles hold the face signatures (never on chain).
- v7.3 (user): no chain at the start; organiser icon + plain "Organizer sets the rules" (+0.5s "and locks the funds.") → merges into a square Contract block → it moves to the bottom and the organiser leaves → the oracle network arrives → widgets stream in; each links its address onto the bottom chain and sends its photo up to the oracle network.
- v7.4 (user): the flowing widgets carry the real team faces (szymon, jaca, bzdon + one more), cut out to transparent PNGs in assets/faces/; the faces end up in the oracle network.
- v7.5 (user): organiser icon removed; oracle network block = take C2 (light node cards, every node keeps a 2×2 grid of all four faces). **Animated** as compositions/frames/08-system.html (11.5s; total 46.05s).

## Changes in v7.6

- New scene 09 (check-in, 5.5s; total 51.55s): the entrance door, camera and walking person from Michiel's face-scan animation (`videos/face-scan-reward`, merged from main), restyled to Satoshi and placed under 08's oracle nodes, with the chain still at the bottom. The person (szymon's face on the avatar body) walks to the door, the camera scans the face, one token flies to each oracle node, every node highlights szymon's face and ticks, and his wallet block on the chain glows.

## Changes in v7.7

- 09 grows to 10s (total 56.05s). After the match a blue "+10 USDC · paid" block drops onto the end of the chain; when it links, seven $ notes pop out of it with a "+10 USDC" label, and the contract drops to 9,990 USDC. szymon walks through the door and the nodes reset. A hooded fraudulent actor (no real face) walks up, gets scanned, the scan goes to all four nodes, every node shakes with a red ✕, the door glow turns red and "No match · no payout" appears. No block is added.

## Changes in v7.8

- 09 grows to 13s (total 59.05s). Each oracle node card shows "until Oct 13 · 23:59" bottom right (also in 08); at the end of the event it turns bold. The gate does not change colour. When szymon is paid, his face greys out on every node. After the fraud rejection holds, the actor leaves, the nodes reset, every face fades out of all four nodes, leaving empty slots. The chain (contract, wallets, payout) stays.

## Changes in v7.12

- 01 hook: "The giveaway / that pays out / by itself." (accent on "pays out by itself").
- 04: tried a contract card + Solana mark before the widget; rolled back at the user's request (04 back to 7.55s, total 62.35s).

## Changes in v7.11

- 08: the widget stream runs 25% faster (one every 1.2s); 08 is 11.2s.
- 09 (16.6s, starts 45.75s; total 62.35s): "No match. No payout." is plain red Satoshi type, no chip. After the rejection a second enrolled attendee (jaca) walks up, is scanned and confirmed, gets his own +10 USDC payout block with the money pop, and his face greys out. Then the whole gate (door, camera, label, floor) goes away, and only then the end dates go bold and shake and every face is cleared. The fraud and jaca passes run 30% faster than szymon's. Chain blocks use a slightly darker green (#1B7A50) so the white text passes contrast.

## Changes in v7.10

- 06–07: the photo step viewfinder shows szymon's real photo (assets/faces/szymon-cam.jpg) inside the dashed guide instead of the silhouette; the guide is ink and turns green on capture.

## Changes in v7.9

- 08: widgets arrive slower (0.9s travel, one every 1.6s); each face splits into four copies that fly all the way into that person's slot on every oracle node. 08 is 12.8s, 09 starts at 47.35s, total 60.35s.
- 09: grey door glow; the camera scope (brackets, scan line, mesh, tokens, LED) is ink, not blue. At the end of the event the "until" dates go bold, grow and shake.

## Changes in v6.6

- 05: only the browser window swipes; the top label stays and just rewrites its tail ("where you need it." → "in an MCP app.").
- 04: the button text shuffles wallet names with the logos; the logo tile pops on each swap.
- 02: "First" only (no "Random"); 4 steps, number and prize change together: 250/500/750/1000 · gift bag/T-shirt/promo code/prize. Scene is 3.2s.
- 04: the widget intro (from the line breaking apart onwards) runs 25% slower. Scene is 7.55s.
- 06: no method showcase; the same card morphs from the sign-up step straight into the photo step after the MetaMask click. Scene is 2.8s.
- Total 41.55s.
- 03: "How do we" stays on the right; only the end of the question rotates (distribute it? → organize it? → set this up? → make it fair?).

## Changes in v6.5

- User: no zoom on the event page in 05 (clunky into the MCP app); the event page swipes left and the ChatGPT window swipes in.
- User: after the zoom into the in-chat widget, stay on step 1; the cursor clicks "Sign up with MetaMask", then the card goes to the check-in step. 06 grows from 5.5s to 7s (total 47s).
- User: no connector lines in 08; small icons flow along each link instead (cash: Organiser → contract; wallets: Enrolled → contract; checks: Oracle → contract and Oracle → Enrolled).

## Changes in v6.4

- User: in 08, make the boxes equal-sized squares. → Organiser, Smart contract, Enrolled wallets and Oracle are all 240×240 squares.

## Changes in v6.3

- User: "less bold fonts." → headlines and numbers drop from Satoshi Black 900 to Satoshi Bold 700; the widget keeps its own Penpot weights.

## Changes in v6.2

- User: "use Satoshi fonts on every slide." → Geist and Geist Mono dropped from the frames; Satoshi everywhere, matching the widget.

## Changes in v6.1

- User: after the carousel, shrink the sentence to "First 1000" and put the questions on the right; then the questions disappear and "First 1000" unrolls into the 04a sentence.

## Changes from v5

- New hook: "Your audience. There when you want it."
- Carousel now cycles three slots: First/Random · 50/200/500/1000 · a gift bag/a T-shirt/a promo code/a prize.
- The red "cons" stack is replaced by the organizer's four bold questions under "First 1000 attendees".
- "You choose the prize. Blockchain executes it." is replaced by the answer line, which turns into the widget itself.
- Embed frame: our Luma-style event page and a pixel-perfect ChatGPT copy; the label swaps to "Embedded in an MCP app".
- Sign-up + 2-step wizard is replaced by the verification-methods showcase (QR, phone, photo) and the photo enrollment, using the Penpot screens.
- "Into the chain" is replaced by the system diagram: Oracle, Smart contract, Organiser.

## Locked

- v6.4 layout confirmed by the user ("build it"). Built as 8 sub-compositions in compositions/frames/, 47s total (v6.5).

## Still open

- Hook copy: read "your audience there when you want it." as two beats, "Your audience." / "There when you want it." Confirm.
- "100 of your token": shown literally ("100 of your token"), then cut to "10 USDC" in the widget. Or should the token have a placeholder name (e.g. "100 $EVENT")?
- ChatGPT copy: rebuilt from memory of the current ChatGPT web UI (sidebar, composer, message bubbles). A screenshot would make it exact.
- Music bed: still none (SFX only).

## Frame 1 — Hook

- scene: "Your audience." then "There when you want it."
- duration: 3s
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- blueprint: kinetic-type-beats
- voiceover: onscreen

**01 — Hook (0.0–3.0s).** Satoshi 700, left-anchored, ink on canvas. "Your audience." lands alone (1.2s), then "There when you want it." cuts in under it with "when you want it" in accent. Seam out: hard cut into the carousel. Why: the organizer's goal, in their words.

## Frame 2 — Rewards carousel

- scene: "[First] [50] attendees get [a gift bag]." All three slots cycle: First/Random · 50/200/500/1000 · a gift bag/a T-shirt/a promo code/a prize
- duration: 5.5s
- transition_in: cut
- status: animated
- src: compositions/frames/02-rewards.html
- blueprint: fixed-anchor-cycle
- voiceover: onscreen

**02 — Rewards carousel (3.0–8.5s).** One centered line; "attendees get" is pinned. The three slots swap on staggered beats (~0.5s): the qualifier flips First ↔ Random, the number rolls like an odometer (Satoshi Bold, accent) 50 → 200 → 500 → 1000, the prize hard-cuts a gift bag → a T-shirt → a promo code → a prize. Soft tick per swap. Lands on "First 1000 attendees get a prize." Seam out: "First 1000 attendees" stays, the rest drops away. Why: organizers already use rewards like these.

## Frame 3 — The organizer's questions

- scene: The carousel line shrinks to "First 1000" on the left; four bold questions stack on the right, then disappear
- duration: 5s
- transition_in: morph
- status: animated
- src: compositions/frames/03-questions.html
- blueprint: kinetic-type-beats
- rules: text morph, stacked list build
- voiceover: onscreen

**03 — The questions (8.5–13.5s).** The carousel's final line "First 1000 attendees get a prize." shrinks to "First 1000" (Satoshi 700, number in Satoshi Bold accent) and settles on the left half; a hairline divides the frame. Four questions land on the right one under another, ~0.8s each, Satoshi 700, ink: "How do we distribute it?" · "How do we organize it?" · "How do we set this up?" · "How do we make it fair?" The last one holds a beat longer, then all four disappear. "First 1000" stays. Seam out: "First 1000" unrolls into 04's sentence. Why: the real cost of rewards is running them.

## Frame 4 — The answer becomes the widget

- scene: "First 1000" unrolls into "First 1000 people earn 100 of your token on sight.", which morphs into the 1a widget
- duration: 6.5s
- transition_in: cut
- status: animated
- src: compositions/frames/04-answer.html
- blueprint: kinetic-type-beats
- rules: text morph, card assemble, fixed-anchor-cycle (wallet logo in the button)
- voiceover: onscreen

**04 — The answer (13.5–20.0s).** "First 1000" (left over from 03) unrolls into the full sentence: the rest of the words roll out of it, "First 1000 people earn / 100 of your token on sight.", and the line recenters (Satoshi 700), with "on sight" in accent. Then the line expands into the widget: a white card grows behind it; "of your token" breaks off and falls away; the line rewrites to the widget's two lines, "First **1000** attendees earn" / "10 USDC" (Satoshi, the real widget sizes); the "Sign up with MetaMask" button rises in under them; "on sight" shrinks and slides down into the "Powered by **OnSight**" pill. The MetaMask tile in the button shuffles through Phantom, Coinbase Wallet, Trust Wallet, WalletConnect and back to MetaMask. Seam out: the finished widget slides right. Why: the answer to all four questions is one embeddable rule.

## Frame 5 — Embedded where you need it

- scene: Widget right, "Embedded where you need it." left; then our Luma-style event page with the widget; then a ChatGPT copy with the widget in the chat, label becomes "Embedded in an MCP app."
- duration: 8s
- transition_in: push-left
- status: animated
- src: compositions/frames/05-embed.html
- blueprint: device-surface-showcase
- voiceover: onscreen

**05 — Embedded (20.0–28.0s).** **05a (2s):** the widget settles on the right third; "Embedded where you need it." types in on the left (Satoshi 700). **05b (2.8s):** the frame cuts to our example event page (the Luma-style "Solana Build Station Warsaw" page from `frontend/`, captured as an image) in a browser window, the widget in the registration slot; a slow push toward it. **05c (3.2s):** cut to a ChatGPT copy in a browser window: the user asks "Any Solana events in Warsaw this week?", the reply names the event and renders our widget inline; the left label rewrites to "Embedded in an MCP app." Seam out: the camera pushes into the in-chat widget. Why: distribution, wherever people find events.

## Frame 6 — Verification methods

- scene: Zoomed widget; the check-in method cycles QR pass → paired phone → selfie
- duration: 5.5s
- transition_in: zoom-through
- status: animated
- src: compositions/frames/06-verify.html
- blueprint: fixed-anchor-cycle
- voiceover: onscreen

**06 — Verification methods (28.0–33.5s).** The widget fills the frame center (the Penpot card at ~2x). The card frame and stepper stay pinned while the body cycles the organizer's possible check-in methods, ~1.6s each, with a small caption to the left: **"QR pass"** (Penpot 2c: the QR card and "Save to device"), **"Paired phone"** (Penpot 2b hero phone: phone with a green check, "iPhone 15", "● Paired"), **"Photo"** (Penpot 2a: the dark viewfinder with the dashed face guide and the shutter). It lands on Photo. Seam out: the flow continues on Photo. Why: the organizer picks how people check in.

## Frame 7 — Photo enrollment

- scene: Cursor takes the selfie, consent "Agree & join", then "You're in." with the green check
- duration: 5s
- transition_in: cut
- status: animated
- src: compositions/frames/07-enroll.html
- blueprint: cursor-ui-demo
- voiceover: onscreen

**07 — Enrollment (33.5–38.5s).** Same zoomed card. The cursor presses the shutter (flash, the guide turns green); the card slides to 3a: "Share your data with Solana Build Station?" + "Agree & join"; the cursor presses; the card lands on 3b: green check, "You're in.", "Add to calendar". Constraint: silhouette only, no real face. Seam out: the green check grows out of the card. Why: one tap and one photo, and you're enrolled.

## Frame 8 — How it works

- scene: The check becomes a green "Enrolled" box; the OnSight pill becomes an "Oracle" box; a "Smart contract" box and an "Organiser" person icon appear; headline on top
- duration: 7s
- transition_in: morph
- status: animated
- src: compositions/frames/08-system.html
- blueprint: grid-card-assemble
- rules: shape morph, connector draw
- voiceover: onscreen

**08 — How it works (38.5–45.5s).** The card zooms out and dissolves; two of its parts survive and morph: the green check grows into a rounded green box labelled "Enrolled wallets", and the "Powered by OnSight" pill grows into a box labelled "OnSight" with "Oracle" underneath. A "Smart contract" box drops in at center, and an "Organiser" box with a person icon on the left. All four boxes are equal-sized squares (user, v6.4). Connectors draw in order: Organiser → Smart contract ("locks the funds"), Enrolled wallets → Smart contract ("wallets saved"), Oracle ↔ Enrolled wallets ("verification method"). The headline builds on top in two lines (Satoshi 700 / 600): "Organizers lock the funds in the smart contract." / "Enrolled wallets are saved on the contract. Their verification method stays with the oracle." Hold to the end. Why: the hand-off from our UI to the chain, and who holds what.
- v7.13: the zoom at the end of 05 lands the widget already centred (2.1x at 960,540), so 06 starts without a recentre. The contract now holds 20 USDC: 20 → 10 → 0 USDC locked as szymon and jaca get paid (08 shows 20 USDC locked).
- v7.14: 02 number and prize are vertical carousels: the active item sits on the line, the coming ones wait dimmed underneath and roll up (no blink); the number slot width eases so "attendees get" stays snug. 07 "You're in." check fires a small confetti burst (16 pieces) that drifts down and fades.
- v7.15: 09 outro (+3.2s, 09 = 19.8s, total 65.74s): after the nodes clear, the whole scene (nodes, contract, chain, payouts) pulls into the centre and vanishes; an OnSight "O" mark pops in, the "OnSight" wordmark (Geist SemiBold) slides out of it, then the motto "Seen on site, paid on-chain." (Geist, "paid on-chain." in blue). Whoosh + chime SFX added.
- v7.16: 08 contract starts as an empty dark card (Reward / For / Until / Locked with grey placeholder bars); the rows fill one by one (10 USDC each · First 2 people · Oct 13 · 23:59), the padlock snaps shut, "Locked 20 USDC" fills in green, then the card folds into the Contract square and drops onto the chain. 08 = 13.3s (+2.1s), total 67.84s. 09: camera drawn in greys, all three bodies one grey (#8A8C93).
- v7.17: all three face scans in 09 (reticle, sweep, mesh, scan-to-oracles tokens, node confirm/deny) run 25% faster; everything after each scan moves up. 09 = 18.37s, total 66.41s. SFX remapped.
- v7.18: after the gate leaves, a flip-clock timer ("Oct 13 · faces deleted at 23:58") appears where the gate was, the last digit flips to 23:59, the timer pulses and turns red; then each node card's "until Oct 13 · 23:59" flips red, one node after another; then the faces clear and the outro runs (timer is pulled in with everything else). Replaces the bold+shake dates. 09 = 19.61s, total 67.65s.
- v7.19: 02 rolls the numbers first (250→500→750→1000), then the prizes (gift bag→T-shirt→promo code→prize); 02 = 3.9s, six swap clicks. 03 question switching 25% slower (03 = 5.6s). 04 wallet switching 35% slower (04 = 8.075s). 08: first incoming widget 30% slower, second 15% slower (08 = 13.84s). Total 70.015s; SFX retimed.
