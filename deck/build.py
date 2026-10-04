#!/usr/bin/env python3
"""OnSight pitch deck: writes slides/NN-*.html, one standalone 1920x1080 page per slide, in the video's visual language."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SLIDES_DIR = ROOT / "slides"

CHECK = '<svg viewBox="0 0 24 24" width="{w}" height="{w}" fill="none" stroke="{c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
CROSS = '<svg viewBox="0 0 24 24" width="{w}" height="{w}" fill="none" stroke="{c}" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
LOCK = '<svg viewBox="0 0 24 24" width="{w}" height="{w}" fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'
ARROW = '<svg class="arr" viewBox="0 0 120 24" width="{w}" height="24"><path d="M2 12h108M100 3l12 9-12 9" fill="none" stroke="#9A9CA3" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
CAM = '<div class="cam"><div class="b"></div><div class="l"></div></div>'
MARK = '<span class="mark">O</span>'
SOL = ('<svg viewBox="0 0 100 80" width="82" height="66"><defs><linearGradient id="solg" x1="0" y1="1" x2="1" y2="0">'
       '<stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs>'
       '<path fill="url(#solg)" d="M18 0h82L82 18H0zM0 31h82l18 18H18zM18 62h82L82 80H0z"/></svg>')
SOL_S = SOL.replace('width="82" height="66"', 'width="34" height="27"')
PEOPLE = ["szymon", "jaca", "bzdon", "face4"]


def face(n, cls="av"):
    return f'<span class="{cls}"><img src="assets/faces/{n}.png" alt=""></span>'


def node(k, faces=PEOPLE):
    return (f'<div class="node"><div class="nt"><i></i>Oracle node {k}</div><div class="g">'
            + "".join(face(n) for n in faces) + '</div></div>')


def widget(small=False):
    return f'''<div class="wg{' sm' if small else ''}">
      <div class="rl">First <b>100</b> attendees earn</div><div class="amt">0.01 SOL</div>
      <div class="btn"><span>Sign up with MetaMask</span><span class="tile"><img src="assets/widget/metamask.svg" alt=""></span></div>
      <div class="pw"><span class="pm">O</span>Powered by <b>OnSight</b></div></div>'''


def contract(label="Contract", sub="budget locked"):
    return f'<div class="con"><span class="solc">{SOL_S}</span>{LOCK.format(w=40, c="#fff")}<div class="t">{label}</div><div class="s">{sub}</div></div>'


def block(txt, sub, cls=""):
    return f'<div class="cb {cls}">{CHECK.format(w=26, c="#fff")}<div class="t">{txt}</div><div class="s">{sub}</div></div>'


def head(txt, kicker=None):
    k = f'<div class="kick">{kicker}</div>' if kicker else ""
    return f'{k}<h1 class="h">{txt}</h1>'


SLIDES = []


def slide(sid, label, body, notes):
    SLIDES.append((sid, label, body, notes))


# 1 ---------------------------------------------------------------- title
slide("title", "OnSight", f'''
  <div class="lockup">{MARK}<span class="wm">OnSight</span></div>
  <div class="motto">Seen on site, <b>paid on-chain.</b></div>
  <div class="tag">Attendance giveaways that pay out by themselves.</div>
  <div class="foot">Superteam Poland · Finance Without Intermediaries · HackYeah 2026</div>
''', "One line: an attendance giveaway where nobody holds the money. The program pays the people who actually came.")

# 2 ---------------------------------------------------------------- video
VIDEO_ID = "FVaaKxfSCt4"
PLAY = '<svg viewBox="0 0 68 48" width="136" height="96"><path d="M66.5 7.7a8.5 8.5 0 0 0-6-6C55.2.3 34 .3 34 .3s-21.2 0-26.5 1.4a8.5 8.5 0 0 0-6 6C.1 13 .1 24 .1 24s0 11 1.4 16.3a8.5 8.5 0 0 0 6 6C12.8 47.7 34 47.7 34 47.7s21.2 0 26.5-1.4a8.5 8.5 0 0 0 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3z" fill="#FF0033"/><path d="M27 34.3 45 24 27 13.7z" fill="#fff"/></svg>'
slide("video", "Video", f'''
  <div class="vid">
    <iframe class="vplay" src="https://www.youtube.com/embed/{VIDEO_ID}?rel=0" title="OnSight pitch video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
    <a class="vthumb" href="https://youtu.be/{VIDEO_ID}"><img src="assets/video/pitch-thumb.jpg" alt="OnSight pitch video"><span class="vbtn">{PLAY}</span></a>
  </div>
  <script>if (location.protocol === "file:") document.querySelector(".vid").classList.add("offline");</script>
''', "Play the video. In the PDF, click the thumbnail to open it on YouTube.")

# 2 ---------------------------------------------------------------- problem
slide("problem", "The problem", head("Today's giveaways run on trust in a middleman.", "The problem") + f'''
  <div class="tri">
    <div class="party"><span class="av lg sol">{SOL}</span><div class="who">Sponsor</div><div class="bub">“Did real people come?”</div></div>
    {ARROW.format(w=150)}
    <div class="mid">{LOCK.format(w=44, c="#fff")}<div class="t">Organizer</div><div class="s">holds the budget<br>keeps the guest list</div></div>
    <svg class="arr" viewBox="0 0 120 24" width="150" height="24"><path d="M118 12H10M20 3L8 12l12 9" fill="none" stroke="#9A9CA3" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <div class="party">{face("szymon", "av lg")}<div class="who">Attendee</div><div class="bub">“Will I really get paid?”</div></div>
  </div>
  <div class="bottom">If the middleman is wrong, slow or dishonest, <b>nobody outside can check.</b></div>
''', "“First 100 people get 0.01 SOL.” The sponsor trusts the attendance is real; the attendee trusts the organizer to pay and not change the rules. The person in the middle holds the money and the list.")

# 3 ---------------------------------------------------------------- who
CHIPS = ["Meetups", "Hackathons", "Product launches", "Conference side events"]
slide("who", "Who it's for", head("Built for organizers who reward showing up.", "Who it's for") + f'''
  <div class="events"><span class="lab">For</span>{"".join(f'<span class="chip">{c}</span>' for c in CHIPS)}</div>
  <div class="two who">
    <div class="col">
      <div class="lab">Organizers &amp; sponsors</div>
      <div class="ccon"><span class="solc">{SOL_S}</span><div class="ch">{LOCK.format(w=34, c="#fff")}<b>Contract</b></div><div class="r">Set the reward</div><div class="r">Lock the budget</div><div class="r">Put a camera at the door</div></div>
    </div>
    <div class="col">
      <div class="lab">Their attendees</div>
      {widget()}
    </div>
  </div>
''', "Two users, deliberately: organizers/sponsors run the giveaway; attendees only see a sign-up widget on the event's own page.")

# 4 ---------------------------------------------------------------- before / after
ROWS = [("The organizer holds the budget", "Locked in escrow when the event is created"),
        ("Rules are a promise", "Frozen on chain: reward, cap, window, oracles"),
        ("Staff decide who came", "Oracles report, the program decides"),
        ("Paid later, by hand, if at all", "Paid in the same transaction, seconds later"),
        ("Nobody can audit the list", "Every payout is public on Solana Explorer")]
slide("before-after", "Before and after", head("The program does the middleman's job.", "What changes") + f'''
  <div class="tbl">
    <div class="th"><span>Today</span><span class="g">With OnSight</span></div>
    {"".join(f'<div class="tr"><span class="old">{CROSS.format(w=30, c="#C4323A")}{a}</span><span class="new">{CHECK.format(w=30, c="#1B7A50")}{b}</span></div>' for a, b in ROWS)}
  </div>
''', "The design rationale in one table. Relationship: attendance giveaway. Intermediary: whoever holds the prizes and the guest list.")

# 5 ---------------------------------------------------------------- how it works
slide("how", "How it works", head("Oracles see faces. The program decides.", "How it works") + f'''
  <div class="band on"><span class="bl">On chain · Solana</span></div>
  <div class="band off"><span class="bl">Off chain</span></div>
  <div class="st s1"><div class="cap"><span class="n">1</span><span>Organizer locks the budget<br><code>create_event</code></span></div>{contract()}</div>
  <div class="st s2"><div class="cap"><span class="n">2</span><span>Attendee joins: wallet,<br>selfie, signature</span></div>{widget(small=True)}</div>
  <div class="st s3"><div class="cap"><span class="n">3</span><span>At the door, oracles report<br>“I see this wallet”</span></div><div class="nodes">{node(1, PEOPLE[:2])}{node(2, PEOPLE[:2])}{node(3, PEOPLE[:2])}</div></div>
  <div class="st s4"><div class="cap"><span class="n">4</span><span><code>report_sighting</code> pays<br>straight from escrow</span></div><div class="chain">{block("7xKX…9fQe", "joined")}<span class="lk"></span>{block("+0.01 SOL", "paid", "pay")}</div></div>
  <div class="flow f12">{ARROW.format(w=56)}</div>
  <div class="flow f34">{ARROW.format(w=56)}</div>
''', "Only the camera and face matching are off chain, like a price oracle. Oracles supply facts; the program holds the money and the rules.")

# 6 ---------------------------------------------------------------- code
CODE = [
    ('pub fn <b>report_sighting</b>(ctx) -&gt; Result&lt;()&gt; {', None),
    ('  ev.oracles.position(oracle).ok_or(NotOracle)?;', 1),
    ('  check_join_proof(event, attendee)?;', 2),
    ('  require!(now &gt;= ev.start &amp;&amp; now &lt;= ev.end);', 3),
    ('  attendance.reporters |= 1 &lt;&lt; slot;', None),
    ('  if !(enough_oracles &amp;&amp; long_enough) { return Ok(()) }', 4),
    ('  require!(ev.paid_count &lt; ev.max_paid, CapReached);', 5),
    ('  attendance.paid = true;', None),
    ('  event.sub_lamports(reward + fee)?;', 6),
    ('  attendee.add_lamports(reward)?;', 6),
    ('}', None),
]
CHECKS = ["Only an oracle listed on the event", "Only with the attendee's own signed join",
          "Only during the event, on the chain's clock", "Only once M-of-N oracles saw them long enough",
          "Only while the cap isn't reached", "Then: escrow → attendee, same transaction"]
slide("code", "Where the intermediary disappears", head("The middleman disappears in <code>report_sighting</code>.", "Where exactly") + f'''
  <div class="codewrap">
    <div class="code">{"".join(f'<div class="ln">{l}{f"<i>{n}</i>" if n else ""}</div>' for l, n in CODE)}</div>
    <div class="checks">{"".join(f'<div class="ck"><i>{i + 1}</i>{c}</div>' for i, c in enumerate(CHECKS))}</div>
  </div>
  <div class="bottom">No person approves anything. <span class="mut">contracts/on_sight/lib.rs</span></div>
''', "Excerpt simplified from lib.rs. The oracle can only say “I see this wallet”; every rule that decides a payout is checked here.")

# 7 ---------------------------------------------------------------- demo
DEMO_URL = "demo-event.onsight.site"
slide("demo", "Live demo", head("DURING LIVE DEMO") + f'''
  <div class="qr"><img src="assets/qr/demo-event.svg" alt="QR code for https://{DEMO_URL}"></div>
  <div class="qrlink"><b>{DEMO_URL}</b></div>
''', "Run the live flow: join on the event page, scan the stage QR to turn a phone into the camera, walk up, get paid. Have two wallets funded and the stage screen open. Show the payout transaction on Solana Explorer. If anything fails, say what and why, then play the 70 s backup video.")

# 8 ---------------------------------------------------------------- trust
PERMS = [("create_event", "anyone, who funds it", "any time"),
         ("report_sighting", "an event's oracle + attendee's signed join", "during the event"),
         ("withdraw_remaining", "that event's organizer", "before start / after end"),
         ("close_attendance", "the oracle that paid its deposit", "after the end")]
slide("trust", "Trust and permissions", head("No admin. Nobody can touch the budget.", "Who can do what") + f'''
  <div class="perm">
    <div class="ph"><span>Instruction</span><span>Who</span><span>When</span></div>
    {"".join(f'<div class="pr"><code>{a}</code><span>{b}</span><span>{c}</span></div>' for a, b, c in PERMS)}
  </div>
  <div class="fails">
    <div class="fc"><div class="q">Organizer disappears?</div><div class="a">Payouts keep working. The rest waits in escrow.</div></div>
    <div class="fc"><div class="q">Oracles stop?</div><div class="a">Nobody is paid. The organizer withdraws it all after the end.</div></div>
  </div>
  <div class="bottom sm">Until we set the upgrade authority to final, the deployer can still upgrade the code.</div>
''', "Answer the three judge questions here: permissions, what happens if a party disappears, and whether we can change anything after deployment.")

# 9 ---------------------------------------------------------------- why chain
WHY = [("Rules nobody can change", "Not the organizer, not us."),
       ("Paid without asking", "The payout runs by itself."),
       ("Auditable by the sponsor", "Every payout is public."),
       ("Oracles keep each other honest", "Only if no one of them owns the decision.")]
slide("why", "Why a blockchain", head("A database needs trust. A chain doesn't.", "Why blockchain") + f'''
  <div class="why">
    <div class="wg4">{"".join(f'<div class="wc">{CHECK.format(w=34, c="#1B7A50")}<div><div class="t">{a}</div><div class="s">{b}</div></div></div>' for a, b in WHY)}</div>
    <div class="stat"><div class="big">0.01 SOL</div><div class="s">reward</div><div class="vs">costs</div><div class="big g">~0.00001 SOL</div><div class="s">in fees</div><div class="foot2">Small per-person rewards finally make sense.</div></div>
  </div>
''', "This question will come up. The decisive point: several independent oracles can only check each other if the decision lives somewhere none of them controls.")

# 10 --------------------------------------------------------------- limits & next
LIMITS = ["With threshold 1, one oracle can lie", "The organizer picks the oracles",
          "A photo held up to the camera isn't caught", "GDPR: a check-in point with explicit consent only",
          "No organizer UI yet"]
NEXT = ["Staked oracles from an open pool, slashed for disagreeing", "Liveness detection",
        "Several independent oracles per event by default", "Freeze the program: final upgrade authority"]
slide("next", "Next week", head("What we'd build next week.", "Next week") + f'''
  <div class="wg4 nx">{"".join(f'<div class="wc"><span class="nn">{i + 1}</span><div class="t">{x}</div></div>' for i, x in enumerate(NEXT))}</div>
  <div class="close"><span class="pm big">O</span><b>OnSight</b><span class="mut">· Oracles earn 0.002 SOL per paid attendee: running one is a business.</span></div>
''', "Known limits for Q&A: threshold 1 lets one oracle lie; the organizer picks the oracles; a held-up photo isn't caught (no liveness); GDPR limits it to a check-in point with consent. Close with the business model: anyone can run an oracle and get paid per attendee.")


CSS = """
@font-face { font-family: "Satoshi"; src: url("assets/fonts/satoshi/Satoshi-Regular.ttf"); font-weight: 400; }
@font-face { font-family: "Satoshi"; src: url("assets/fonts/satoshi/Satoshi-Medium.ttf"); font-weight: 500; }
@font-face { font-family: "Satoshi"; src: url("assets/fonts/satoshi/Satoshi-Bold.ttf"); font-weight: 700; }
@font-face { font-family: "Geist"; src: url("assets/fonts/geist/Geist-Regular.ttf"); font-weight: 400; }
@font-face { font-family: "Geist"; src: url("assets/fonts/geist/Geist-Medium.ttf"); font-weight: 500; }
@font-face { font-family: "Geist"; src: url("assets/fonts/geist/Geist-SemiBold.ttf"); font-weight: 600; }
@font-face { font-family: "Geist"; src: url("assets/fonts/geist/Geist-Bold.ttf"); font-weight: 700; }
@font-face { font-family: "Geist Mono"; src: url("assets/fonts/geist-mono/GeistMono-Regular.ttf"); font-weight: 400; }
@font-face { font-family: "Geist Mono"; src: url("assets/fonts/geist-mono/GeistMono-SemiBold.ttf"); font-weight: 600; }
body { margin: 0; background: #F3F2EE; }
.scene { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #F3F2EE; color: #15161A; font-family: "Satoshi", sans-serif; }
.scene > section { position: absolute; inset: 0; }
code, .code { font-family: "Geist Mono", ui-monospace, monospace; }
.kick { position: absolute; left: 140px; top: 96px; font-size: 30px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #2775CA; }
.h { position: absolute; left: 140px; top: 140px; width: 1640px; margin: 0; font-size: 76px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.05; }
.h code { font-size: .86em; font-weight: 600; color: #2775CA; letter-spacing: -0.02em; }
.bottom { position: absolute; left: 140px; right: 140px; bottom: 90px; font-size: 44px; font-weight: 500; color: #3A3B40; }
.bottom b { color: #15161A; } .bottom.sm { font-size: 34px; color: #6B6D74; bottom: 70px; }
.mut { color: #6B6D74; font-weight: 500; }
.arr { flex: none; }

/* brand */
.mark { width: 150px; height: 150px; border-radius: 40px; background: #15161A; color: #fff; font-family: "Geist"; font-weight: 700; font-size: 92px; letter-spacing: -0.04em; display: flex; align-items: center; justify-content: center; flex: none; }
.lockup { position: absolute; left: 0; right: 0; top: 330px; display: flex; align-items: center; justify-content: center; gap: 40px; }
.wm { font-family: "Geist"; font-weight: 600; font-size: 170px; letter-spacing: -0.04em; line-height: 1; }
.motto { position: absolute; left: 0; right: 0; top: 560px; text-align: center; font-family: "Geist"; font-size: 60px; color: #6B6D74; letter-spacing: -0.02em; }
.motto b { color: #2775CA; font-weight: 600; }
.tag { position: absolute; left: 0; right: 0; top: 680px; text-align: center; font-size: 44px; font-weight: 500; }
.foot { position: absolute; left: 0; right: 0; bottom: 80px; text-align: center; font-size: 32px; font-weight: 500; color: #6B6D74; }

/* faces */
.av { width: 74px; height: 74px; border-radius: 99px; background: #fff; box-shadow: inset 0 0 0 2px #E4E2DC; overflow: hidden; display: inline-flex; align-items: flex-end; justify-content: center; }
.av img { height: 70px; width: auto; }
.av.lg { width: 150px; height: 150px; background: #E3F2EA; box-shadow: 0 0 0 5px #fff; } .av.lg img { height: 142px; }

/* problem */
.tri { position: absolute; left: 140px; right: 140px; top: 420px; display: flex; align-items: center; justify-content: space-between; }
.party { width: 400px; display: flex; flex-direction: column; align-items: center; gap: 18px; }
.party .who { font-size: 48px; font-weight: 700; }
.party .bub { font-size: 40px; font-weight: 500; color: #3A3B40; background: #fff; border-radius: 26px; padding: 18px 28px; box-shadow: inset 0 0 0 2px #D9D7D0; text-align: center; }
.mid { width: 400px; height: 300px; border-radius: 30px; background: #15161A; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; box-shadow: 0 24px 50px rgba(21,22,26,.18); }
.mid .t { font-size: 52px; font-weight: 700; } .mid .s { font-size: 34px; color: #C9CAD0; text-align: center; line-height: 1.3; }

/* who */
.two { position: absolute; left: 140px; right: 140px; top: 400px; display: grid; grid-template-columns: 1fr 1fr; gap: 100px; }
.col { display: flex; flex-direction: column; gap: 30px; }
.lab { font-size: 34px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #6B6D74; }
.lab.r { color: #C4323A; } .lab.g { color: #1B7A50; }
.chips { display: flex; flex-wrap: wrap; gap: 18px; }
.chip { font-size: 42px; font-weight: 700; padding: 20px 34px; border-radius: 999px; background: #fff; box-shadow: inset 0 0 0 2px #D9D7D0; }
.note { font-size: 42px; font-weight: 500; color: #3A3B40; line-height: 1.25; }

/* widget card */
.wg { width: 560px; background: #fff; border-radius: 28px; padding: 30px 34px 22px; box-shadow: 0 20px 50px rgba(21,22,26,.10), 0 0 0 1px rgba(21,22,26,.06); font-family: "Geist"; }
.wg .rl { font-size: 30px; } .wg .rl b { color: #2775CA; font-weight: 500; }
.wg .amt { font-size: 58px; font-weight: 600; color: #2775CA; letter-spacing: -0.03em; margin: 2px 0 20px; }
.wg .btn { height: 74px; border-radius: 999px; background: #15161A; color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 0 12px 0 34px; font-size: 26px; font-weight: 500; }
.wg .tile { width: 52px; height: 52px; border-radius: 14px; background: #fff; display: flex; align-items: center; justify-content: center; } .wg .tile img { width: 34px; }
.wg .pw { margin: 18px auto 0; width: max-content; font-size: 20px; color: #6B6D74; display: flex; align-items: center; gap: 8px; } .wg .pw b { color: #15161A; font-weight: 600; }
.pm { width: 26px; height: 26px; border-radius: 7px; background: #15161A; color: #fff; font-family: "Geist"; font-weight: 700; font-size: 15px; display: inline-flex; align-items: center; justify-content: center; }
.wg.sm { width: 420px; padding: 22px 26px 16px; border-radius: 22px; } .wg.sm .rl { font-size: 22px; } .wg.sm .amt { font-size: 44px; margin-bottom: 14px; }
.wg.sm .btn { height: 56px; font-size: 20px; padding-left: 24px; } .wg.sm .tile { width: 40px; height: 40px; } .wg.sm .tile img { width: 26px; } .wg.sm .pw { font-size: 16px; }

/* before/after */
.tbl { position: absolute; left: 140px; right: 140px; top: 330px; }
.th, .tr { display: grid; grid-template-columns: 1fr 1.25fr; gap: 40px; align-items: center; }
.th { font-size: 32px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #6B6D74; padding-bottom: 18px; } .th .g { color: #1B7A50; }
.tr { padding: 24px 0; border-top: 2px solid #DEDCD5; font-size: 42px; }
.tr span { display: flex; align-items: center; gap: 22px; } .tr svg { flex: none; }
.tr .old { color: #6B6D74; font-weight: 500; } .tr .new { font-weight: 700; }

/* who: dotted list + contract chain */
.con, .ccon { position: relative; }
.solc { position: absolute; right: 18px; top: 18px; line-height: 0; }
.ccon .solc { right: 26px; top: 28px; }
.events { position: absolute; left: 140px; right: 140px; top: 340px; display: flex; align-items: center; gap: 18px; padding-bottom: 44px; border-bottom: 2px solid #DEDCD5; }
.events .lab { margin-right: 14px; }
.events .li { font-size: 42px; font-weight: 600; white-space: nowrap; } .events .li i { background: #15161A; width: 14px; height: 14px; }
.two.who { top: 530px; grid-template-columns: 1fr 1fr; gap: 80px; }
.two.who .col { gap: 26px; }
.two.who .ccon, .two.who .wg { width: 620px; height: 330px; box-sizing: border-box; }
.two.who .ccon { padding: 34px 38px; } .two.who .ccon .r { font-size: 34px; padding: 13px 0; }
.dots { display: grid; grid-template-columns: auto auto; gap: 14px 50px; justify-content: start; }
.dots .li { font-size: 42px; font-weight: 600; white-space: nowrap; } .dots .li i { background: #15161A; width: 14px; height: 14px; }
.cchain { display: flex; align-items: center; margin-top: 26px; }
.ccon { width: 500px; box-sizing: border-box; border-radius: 28px; background: #15161A; color: #fff; padding: 28px 32px; flex: none; }
.ccon .ch { display: flex; align-items: center; gap: 14px; font-size: 38px; margin-bottom: 10px; }
.ccon .r { font-size: 32px; color: #D4D5DA; font-weight: 500; padding: 9px 0; border-top: 1px solid #2E2F35; }
.fb { width: 84px; height: 84px; border-radius: 18px; background: #1B7A50; flex: none; }
.cchain .lk { width: 30px; height: 14px; border-radius: 7px; box-shadow: inset 0 0 0 3px #9A9CA3; flex: none; }
.av.sol { background: #15161A; align-items: center; box-shadow: 0 0 0 5px #fff; }
.wg4.nx { position: absolute; left: 140px; right: 140px; top: 360px; }
.wg4.nx .wc { align-items: center; padding: 44px 40px; } .wg4.nx .t { font-size: 46px; }
.nn { flex: none; width: 64px; height: 64px; border-radius: 99px; background: #1B7A50; color: #fff; font-size: 34px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
/* how */
.band { position: absolute; top: 280px; height: 770px; border-radius: 34px; }
.band.on { left: 100px; width: 800px; background: #E4EFE9; }
.band.off { left: 980px; width: 840px; background: #ECEAE4; }
.bl { position: absolute; left: 34px; top: 24px; font-size: 26px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #6B6D74; }
.band.on .bl { color: #1B7A50; }
.st { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 28px; }
.st .n { flex: none; width: 52px; height: 52px; border-radius: 99px; background: #2775CA; color: #fff; font-size: 30px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.cap { display: flex; align-items: center; gap: 18px; font-size: 34px; font-weight: 600; line-height: 1.2; }
.cap code { font-size: 30px; color: #2775CA; }
.s1 { left: 100px; width: 800px; top: 380px; }
.s4 { left: 100px; width: 800px; top: 750px; }
.s2 { left: 980px; width: 840px; top: 380px; }
.s3 { left: 980px; width: 840px; top: 750px; }
.s2 .wg.sm { zoom: 0.8; }
.s4 .cb { width: 150px; height: 150px; }
.band .bl { top: 26px; }
.flow { position: absolute; }
.f12 { left: 912px; top: 530px; }
.f23 { left: 1372px; top: 700px; transform: rotate(90deg); }
.f34 { left: 912px; top: 890px; transform: rotate(180deg); }
.con { width: 190px; height: 190px; border-radius: 26px; background: #15161A; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; flex: none; }
.con .t { font-size: 32px; font-weight: 700; } .con .s { font-size: 20px; color: #A9ABB2; }
.nodes { display: flex; gap: 14px; }
.node { box-sizing: border-box; width: 220px; background: #fff; border-radius: 20px; padding: 16px 18px 18px; box-shadow: inset 0 0 0 2px #D9D7D0; }
.node .nt { display: flex; align-items: center; gap: 10px; font-size: 22px; font-weight: 700; } .node .nt i { width: 11px; height: 11px; border-radius: 9px; background: #1F8A5B; }
.node .g { display: flex; gap: 12px; justify-content: center; margin-top: 14px; }
.chain { display: flex; align-items: center; }
.cb { width: 170px; height: 170px; border-radius: 22px; background: #1B7A50; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; flex: none; }
.cb .t { font-size: 24px; font-weight: 700; } .cb .s { font-size: 20px; opacity: .85; }
.cb.pay { background: #2775CA; } .cb.pay .t { font-size: 28px; }
.lk { width: 34px; height: 16px; border-radius: 8px; box-shadow: inset 0 0 0 3px #A9C7B8; }

/* code */
.codewrap { position: absolute; left: 140px; right: 140px; top: 330px; display: grid; grid-template-columns: 1.25fr 1fr; gap: 50px; }
.code { background: #15161A; color: #E4E5E9; border-radius: 28px; padding: 36px 84px 36px 40px; font-size: 26px; line-height: 1.62; }
.code .ln { position: relative; white-space: pre; } .code b { color: #7FB5EE; font-weight: 600; }
.code i { position: absolute; right: -66px; top: 50%; transform: translateY(-50%); width: 38px; height: 38px; border-radius: 99px; background: #2775CA; color: #fff; font-style: normal; font-family: "Satoshi"; font-weight: 700; font-size: 22px; display: flex; align-items: center; justify-content: center; }
.checks { display: flex; flex-direction: column; gap: 16px; justify-content: center; }
.ck { display: flex; align-items: center; gap: 22px; font-size: 36px; font-weight: 600; line-height: 1.15; }
.ck i { flex: none; width: 50px; height: 50px; border-radius: 99px; background: #2775CA; color: #fff; font-style: normal; font-size: 26px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.ck:last-child i { background: #1B7A50; }

/* video: live player on screen, clickable thumbnail in the PDF */
.vid { position: absolute; left: 140px; top: 79px; width: 1640px; height: 922px; border-radius: 28px; overflow: hidden; background: #15161A; box-shadow: 0 24px 50px rgba(21,22,26,.18); }
.vid iframe { width: 100%; height: 100%; border: 0; display: block; }
.vthumb { display: none; position: absolute; inset: 0; } .vthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.vbtn { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); line-height: 0; }
/* YouTube refuses to play without a referrer, so file:// pages fall back to the thumbnail too */
@media print { .vplay { display: none; } .vthumb { display: block; } }
.vid.offline .vplay { display: none; } .vid.offline .vthumb { display: block; }

/* demo */
.steps { position: absolute; left: 140px; right: 140px; top: 380px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 30px; }
.sc { position: relative; background: #fff; border-radius: 28px; padding: 70px 34px 40px; box-shadow: inset 0 0 0 2px #D9D7D0; min-height: 330px; }
.sc .n { position: absolute; left: 34px; top: -30px; width: 64px; height: 64px; border-radius: 99px; background: #15161A; color: #fff; font-size: 34px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.sc:last-child .n { background: #1B7A50; }
.sc .t { font-size: 42px; font-weight: 700; line-height: 1.1; } .sc .s { margin-top: 18px; font-size: 32px; font-weight: 500; color: #4A4B50; line-height: 1.3; }
.links { position: absolute; left: 140px; right: 140px; bottom: 100px; display: flex; gap: 120px; font-size: 48px; }
.links div { display: flex; flex-direction: column; gap: 6px; } .links .mut { font-size: 30px; letter-spacing: .1em; text-transform: uppercase; } .links b { color: #2775CA; }
.qr { position: absolute; left: 50%; top: 300px; transform: translateX(-50%); width: 520px; height: 520px; padding: 36px; box-sizing: border-box; background: #fff; border-radius: 36px; box-shadow: inset 0 0 0 2px #D9D7D0; }
.qr img { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
.qrlink { position: absolute; left: 0; right: 0; bottom: 110px; text-align: center; font-family: "Geist Mono", ui-monospace, monospace; font-size: 60px; font-weight: 600; letter-spacing: -0.02em; } .qrlink b { color: #2775CA; }

/* trust */
.perm { position: absolute; left: 140px; width: 1030px; top: 330px; }
.ph, .pr { display: grid; grid-template-columns: 360px 1fr 300px; gap: 24px; align-items: center; }
.ph { font-size: 26px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #6B6D74; padding-bottom: 14px; }
.pr { padding: 22px 0; border-top: 2px solid #DEDCD5; font-size: 32px; font-weight: 500; }
.pr code { font-size: 30px; font-weight: 600; color: #2775CA; }
.fails { position: absolute; right: 140px; width: 540px; top: 330px; display: flex; flex-direction: column; gap: 28px; }
.fc { background: #15161A; color: #fff; border-radius: 28px; padding: 32px 36px; }
.fc .q { font-size: 40px; font-weight: 700; } .fc .a { margin-top: 12px; font-size: 34px; color: #C9CAD0; line-height: 1.3; }

/* why */
.why { position: absolute; left: 140px; right: 140px; top: 360px; display: grid; grid-template-columns: 1.35fr 1fr; gap: 70px; }
.wg4 { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
.wc { background: #fff; border-radius: 26px; padding: 34px; box-shadow: inset 0 0 0 2px #D9D7D0; display: flex; gap: 20px; align-items: flex-start; }
.wc svg { flex: none; margin-top: 6px; }
.wc .t { font-size: 40px; font-weight: 700; line-height: 1.1; } .wc .s { margin-top: 12px; font-size: 32px; font-weight: 500; color: #4A4B50; }
.stat { background: #15161A; color: #fff; border-radius: 30px; padding: 44px 48px; display: flex; flex-direction: column; }
.stat .big { font-size: 84px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; } .stat .big.g { color: #4ADE80; }
.stat .s { font-size: 32px; color: #A9ABB2; margin-top: 6px; } .stat .vs { font-size: 32px; color: #A9ABB2; margin: 26px 0 14px; }
.stat .foot2 { margin-top: auto; padding-top: 30px; font-size: 36px; font-weight: 600; line-height: 1.2; }

/* next */
.two.lim { top: 330px; gap: 90px; } .two.lim .col { gap: 22px; }
.li { display: flex; align-items: center; gap: 24px; font-size: 40px; font-weight: 600; line-height: 1.15; }
.li i { flex: none; width: 18px; height: 18px; border-radius: 99px; } .li i.r { background: #C4323A; } .li i.g { background: #1B7A50; }
.close { position: absolute; left: 140px; right: 140px; bottom: 80px; display: flex; align-items: center; gap: 20px; font-size: 36px; padding-top: 34px; border-top: 2px solid #DEDCD5; }
.close b { font-family: "Geist"; font-weight: 600; font-size: 44px; letter-spacing: -0.03em; }
.pm.big { width: 58px; height: 58px; border-radius: 16px; font-size: 34px; }
"""


# ---------------------------------------------------------------- output: one standalone page per slide
for old in SLIDES_DIR.glob("*.html"):
    old.unlink()
CSS = CSS.replace('url("assets/', 'url("../assets/')
for i, (sid, label, body, notes) in enumerate(SLIDES, 1):
    html = f"""<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<title>{i:02d} · {label} · OnSight</title>
<style>{CSS}
@page {{ size: 1920px 1080px; margin: 0; }}
html, body {{ width: 1920px; height: 1080px; }}
* {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
</style>
</head>
<body>
<!-- speaker notes: {notes} -->
<div class="scene"><section>{body.replace('src="assets/', 'src="../assets/')}</section></div>
</body>
</html>
"""
    (SLIDES_DIR / f"{i:02d}-{sid}.html").write_text(html)
print("wrote", len(SLIDES), "slides to", SLIDES_DIR)
