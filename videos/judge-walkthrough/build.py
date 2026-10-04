"""Generates the judge walkthrough: index.html plus one sub-composition per scene in compositions/.

The screens in assets/screens are real captures of the app at 1600x900 (2x). Cursor targets, highlights and zooms
are in those 1600x900 page coordinates; the browser window shows the page at 0.8 scale (1280x720).
Run: python3 build.py, then npx hyperframes check / preview / render.
"""
import html
import json
from pathlib import Path

ROOT = Path(__file__).parent
W, H = 1920, 1080
S = 0.8  # page px -> window px
EVENT = "2jQMau7m7H1cMMHYPv6XKH1k7xqhWhCsfUixktTtMrXz"
ORGANIZER = "WiKXqZBj3kPCKe3N5QU3gKGnkFjgaZQaTYSvaZzE5bj"
ATTENDEE = "A9APM9cNTY1Xa6eT3HQ8yEsrGdQdQGZJ8cditY9CtG9B"


def short(a):
    return f"{a[:4]}…{a[-4:]}"


CSS = """
@font-face { font-family: "Geist"; src: url("assets/fonts/Geist-Medium.ttf"); font-weight: 500; }
@font-face { font-family: "Geist"; src: url("assets/fonts/Geist-Bold.ttf"); font-weight: 700; }
@font-face { font-family: "Geist"; src: url("assets/fonts/Geist-ExtraBold.ttf"); font-weight: 800; }
@font-face { font-family: "Geist Mono"; src: url("assets/fonts/GeistMono-Medium.ttf"); font-weight: 500; }
#root { position: absolute; inset: 0; background: #F3F2EE; color: #15161A; font-family: "Geist", sans-serif; overflow: hidden; }
.side { position: absolute; left: 80px; top: 0; bottom: 0; width: 420px; display: flex; flex-direction: column; justify-content: center; gap: 22px; }
.kicker { font-size: 20px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #1F8A5B; }
.title { font-size: 54px; line-height: 1.05; font-weight: 800; letter-spacing: -0.03em; margin: 0; }
.bullets { display: flex; flex-direction: column; gap: 16px; margin-top: 8px; }
.b { display: flex; gap: 14px; font-size: 25px; line-height: 1.3; color: #3A3C42; font-weight: 500; }
.b i { flex: none; width: 10px; height: 10px; border-radius: 99px; background: #1F8A5B; margin-top: 12px; }
.b strong { color: #15161A; font-weight: 700; }
.win { position: absolute; left: 560px; top: 160px; width: 1280px; height: 764px; border-radius: 18px; overflow: hidden;
  background: #fff; box-shadow: 0 30px 80px rgba(21,22,26,0.16), 0 0 0 1px rgba(21,22,26,0.08); }
.bar { height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #ECEBE6; border-bottom: 1px solid #D9D7D0; }
.dot { width: 12px; height: 12px; border-radius: 99px; background: #D0CEC7; }
.url { margin-left: 18px; flex: 1; height: 28px; border-radius: 8px; background: #fff; display: flex; align-items: center; padding: 0 12px;
  font-family: "Geist Mono", monospace; font-size: 14px; color: #55575E; white-space: nowrap; overflow: hidden; }
.view { position: absolute; left: 0; top: 44px; width: 1280px; height: 720px; overflow: hidden; }
.cam { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; }
.scr { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; opacity: 0; }
.hl { position: absolute; border: 3px solid #1F8A5B; border-radius: 12px; box-shadow: 0 0 0 6px rgba(31,138,91,0.18); opacity: 0; }
.cursor { position: absolute; left: 0; top: 0; width: 30px; height: 36px; }
.ripple { position: absolute; left: -22px; top: -22px; width: 44px; height: 44px; border-radius: 99px; background: rgba(31,138,91,0.45); opacity: 0; }
.mm { position: absolute; right: 16px; top: 8px; width: 340px; height: 500px; border-radius: 14px; background: #fff; opacity: 0;
  box-shadow: 0 20px 60px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.08); display: flex; flex-direction: column; overflow: hidden; }
.mm-top { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #EEE; font-size: 15px; font-weight: 700; }
.mm-logo { width: 26px; height: 26px; background: url("assets/metamask.svg") center / contain no-repeat; }
.mm-net { margin-left: auto; font-size: 12px; font-weight: 500; color: #555; background: #F2F2F2; border-radius: 99px; padding: 4px 10px; }
.mm-body { flex: 1; padding: 18px 18px 0; display: flex; flex-direction: column; gap: 12px; }
.mm-h { font-size: 21px; font-weight: 800; }
.mm-site { font-size: 14px; color: #555; }
.mm-acct { font-size: 14px; color: #222; background: #F7F7F7; border-radius: 10px; padding: 10px 12px; }
.mm-msg { font-family: "Geist Mono", monospace; font-size: 12px; line-height: 1.5; color: #333; background: #F7F7F7; border-radius: 10px;
  padding: 10px 12px; white-space: pre-wrap; word-break: break-all; }
.mm-amt { font-size: 30px; font-weight: 800; }
.mm-row { display: flex; justify-content: space-between; font-size: 14px; color: #444; }
.mm-btns { display: flex; gap: 12px; padding: 16px 18px 20px; }
.mm-btns div { flex: 1; height: 44px; border-radius: 99px; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; }
.mm-cancel { border: 1px solid #222; }
.mm-ok { background: #0376C9; color: #fff; }
.phone { position: absolute; right: 40px; bottom: 36px; width: 318px; height: 672px; border-radius: 46px; background: #15161A; padding: 12px;
  box-shadow: 0 30px 80px rgba(21,22,26,0.35); opacity: 0; }
.phone img { width: 294px; height: 648px; border-radius: 36px; display: block; object-fit: cover; }
.card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; text-align: center; }
.mark { width: 84px; height: 84px; border-radius: 22px; background: #15161A; color: #fff; display: flex; align-items: center; justify-content: center;
  font-size: 48px; font-weight: 800; }
.big { font-size: 96px; font-weight: 800; letter-spacing: -0.04em; margin: 0; line-height: 1; }
.sub { font-size: 34px; color: #55575E; font-weight: 500; margin: 0; }
.chips { display: flex; gap: 18px; margin-top: 18px; }
.chip { background: #fff; border: 1px solid #D9D7D0; border-radius: 16px; padding: 18px 24px; font-size: 24px; font-weight: 500; color: #3A3C42; max-width: 420px; }
.chip strong { display: block; color: #15161A; font-weight: 700; margin-bottom: 4px; }
.addr { font-family: "Geist Mono", monospace; font-size: 46px; font-weight: 500; color: #15161A; background: #fff; border: 1px solid #D9D7D0;
  border-radius: 18px; padding: 18px 32px; }
.note { font-size: 24px; color: #6B6D74; font-weight: 500; margin: 0; max-width: 1100px; }
"""

CURSOR_SVG = (
    '<svg viewBox="0 0 30 36" width="30" height="36"><path d="M2 2 L2 28 L9 21.5 L14 33 L19 31 L14 19.5 L24 19.5 Z" '
    'fill="#15161A" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>'
)


def popup(sid, k, kind):
    site = '<div class="mm-site">onsight.site</div>'
    if kind == "connect":
        body = f'<div class="mm-h">Connect this website</div>{site}<div class="mm-acct">Account 1 · {short(ATTENDEE)}</div>' \
               '<div class="mm-site">It can see your address and ask you to sign. It can\'t move funds.</div>'
        ok = "Connect"
    elif kind == "signin":
        msg = f"Sign in to OnSight as an event organiser.\n\nWallet: {short(ORGANIZER)}\n\nThis costs nothing and sends no transaction."
        body = f'<div class="mm-h">Signature request</div>{site}<div class="mm-msg">{html.escape(msg)}</div>'
        ok = "Confirm"
    elif kind == "pair":
        msg = f"Attend Now\nAction: camera-token\nEvent: {short(EVENT)}\nWallet: {short(ORGANIZER)}"
        body = f'<div class="mm-h">Signature request</div>{site}<div class="mm-msg">{html.escape(msg)}</div>' \
               '<div class="mm-site">Free: no transaction.</div>'
        ok = "Confirm"
    elif kind == "join":
        msg = f"Attend Now\nAction: join\nEvent: {short(EVENT)}\nWallet: {short(ATTENDEE)}\nConsent: 2026-10-03"
        body = f'<div class="mm-h">Signature request</div>{site}<div class="mm-msg">{html.escape(msg)}</div>' \
               '<div class="mm-site">Free: no transaction.</div>'
        ok = "Confirm"
    else:  # tx
        body = f'<div class="mm-h">Transaction request</div>{site}<div class="mm-amt">−0.0323114 SOL</div>' \
               '<div class="mm-row"><span>Program</span><span>on_sight</span></div>' \
               '<div class="mm-row"><span>Instruction</span><span>create_event</span></div>' \
               '<div class="mm-row"><span>Network fee</span><span>0.000005 SOL</span></div>'
        ok = "Confirm"
    return (f'<div class="mm" id="{sid}-mm{k}"><div class="mm-top"><span class="mm-logo"></span>MetaMask'
            f'<span class="mm-net">Solana Devnet</span></div><div class="mm-body">{body}</div>'
            f'<div class="mm-btns"><div class="mm-cancel">Cancel</div><div class="mm-ok">{ok}</div></div></div>')


# Where the popup's confirm button sits, in page coordinates (so cursor targets stay in one system).
MM_OK = ((1280 - 16 - 18 - 76) / S, (8 + 500 - 20 - 22) / S)


def scene(sid, kicker, title, bullets, url, screens, *, cursor=None, clicks=(), hls=(), zooms=(), popups=(), phone=None, dur):
    """screens: [(t, file)]; cursor: [(t, x, y, move_s)]; clicks: [t]; hls: [(t_in, t_out, x, y, w, h)];
    zooms: [(t_in, t_out, cx, cy, scale)]; popups: [(t_in, t_out, kind)]; phone: (t_in, file); bullets: [(t, html)]."""
    side = "".join(f'<div class="b" id="{sid}-b{k}"><i></i><span>{b}</span></div>' for k, (_, b) in enumerate(bullets))
    imgs = "".join(f'<img class="scr" id="{sid}-i{k}" src="assets/screens/{f}.webp" alt="">' for k, (_, f) in enumerate(screens))
    hl = "".join(f'<div class="hl" id="{sid}-h{k}" style="left:{x*S-8}px;top:{y*S-8}px;width:{w*S+16}px;height:{h*S+16}px"></div>'
                 for k, (_, _, x, y, w, h) in enumerate(hls))
    cur = (f'<div class="ripple" id="{sid}-rip"></div><div class="cursor" id="{sid}-cur">{CURSOR_SVG}</div>' if cursor else "")
    pops = "".join(popup(sid, k, kind) for k, (_, _, kind) in enumerate(popups))
    ph = f'<div class="phone" id="{sid}-ph"><img src="assets/screens/{phone[1]}.webp" alt=""></div>' if phone else ""
    js = []
    js.append(f'tl.fromTo("#{sid}-side", {{opacity: 0, x: -24}}, {{opacity: 1, x: 0, duration: 0.5, ease: "power3.out"}}, 0);')
    js.append(f'tl.fromTo("#{sid}-win", {{opacity: 0, y: 24}}, {{opacity: 1, y: 0, duration: 0.5, ease: "power3.out"}}, 0.1);')
    for k, (t, _) in enumerate(bullets):
        js.append(f'tl.fromTo("#{sid}-b{k}", {{opacity: 0, y: 12}}, {{opacity: 1, y: 0, duration: 0.4, ease: "power2.out"}}, {t});')
    for k, (t, _) in enumerate(screens):
        js.append(f'tl.fromTo("#{sid}-i{k}", {{opacity: 0}}, {{opacity: 1, duration: {0.01 if k == 0 else 0.25}}}, {t});')
    for k, (ti, to, *_r) in enumerate(hls):
        js.append(f'tl.fromTo("#{sid}-h{k}", {{opacity: 0, scale: 1.06}}, {{opacity: 1, scale: 1, duration: 0.3, ease: "power2.out"}}, {ti});')
        js.append(f'tl.to("#{sid}-h{k}", {{opacity: 0, duration: 0.25}}, {to});')
    for (ti, to, cx, cy, sc) in zooms:
        js.append(f'tl.to("#{sid}-cam", {{scale: {sc}, transformOrigin: "{cx*S}px {cy*S}px", duration: 0.7, ease: "power2.inOut"}}, {ti});')
        js.append(f'tl.to("#{sid}-cam", {{scale: 1, duration: 0.6, ease: "power2.inOut"}}, {to});')
    for k, (ti, to, _) in enumerate(popups):
        js.append(f'tl.fromTo("#{sid}-mm{k}", {{opacity: 0, y: -14}}, {{opacity: 1, y: 0, duration: 0.25, ease: "power2.out"}}, {ti});')
        js.append(f'tl.to("#{sid}-mm{k}", {{opacity: 0, y: -10, duration: 0.2}}, {to});')
    if cursor:
        t0, x0, y0, _ = cursor[0]
        js.append(f'tl.fromTo("#{sid}-cur", {{x: {x0*S}, y: {y0*S}, opacity: 0}}, {{x: {x0*S}, y: {y0*S}, opacity: 1, duration: 0.15}}, {t0});')
        for (t, x, y, m) in cursor[1:]:
            js.append(f'tl.to("#{sid}-cur", {{x: {x*S}, y: {y*S}, duration: {m}, ease: "power2.inOut"}}, {t});')
        def at(t):
            pos = cursor[0][1:3]
            for (ts, x, y, _m) in cursor:
                if ts <= t:
                    pos = (x, y)
            return pos
        for t in clicks:
            x, y = at(t)
            js.append(f'tl.to("#{sid}-cur", {{scale: 0.82, duration: 0.08, yoyo: true, repeat: 1, transformOrigin: "2px 2px"}}, {t});')
            js.append(f'tl.fromTo("#{sid}-rip", {{opacity: 0.7, scale: 0.3, x: {x*S}, y: {y*S}}}, '
                      f'{{opacity: 0, scale: 1.6, duration: 0.5, ease: "power2.out", immediateRender: false}}, {t});')
    if phone:
        js.append(f'tl.fromTo("#{sid}-ph", {{opacity: 0, y: 60}}, {{opacity: 1, y: 0, duration: 0.6, ease: "power3.out"}}, {phone[0]});')
        if len(phone) > 2:
            js.append(f'tl.to("#{sid}-ph", {{opacity: 0, y: 60, duration: 0.4, ease: "power2.in"}}, {phone[2]});')
    doc = f"""<!doctype html>
<html><head><meta charset="UTF-8" /></head>
<body>
<template>
<style>{CSS}</style>
<div id="root" data-composition-id="{sid}" data-width="{W}" data-height="{H}" data-duration="{dur}">
  <div class="side" id="{sid}-side">
    <div class="kicker">{kicker}</div>
    <h1 class="title">{title}</h1>
    <div class="bullets">{side}</div>
  </div>
  <div class="win" id="{sid}-win">
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">{html.escape(url)}</span></div>
    <div class="view"><div class="cam" id="{sid}-cam" data-layout-allow-overflow>{imgs}{hl}{pops}{cur}</div></div>
  </div>
  {ph}
</div>
<script>
const tl = gsap.timeline({{ paused: true }});
{chr(10).join(js)}
window.__timelines["{sid}"] = tl;
</script>
</template>
</body></html>
"""
    (ROOT / "compositions" / f"{sid}.html").write_text(doc)
    return sid, dur


def card(sid, inner, js, dur):
    doc = f"""<!doctype html>
<html><head><meta charset="UTF-8" /></head>
<body>
<template>
<style>{CSS}</style>
<div id="root" data-composition-id="{sid}" data-width="{W}" data-height="{H}" data-duration="{dur}">
  <div class="card">{inner}</div>
</div>
<script>
const tl = gsap.timeline({{ paused: true }});
{js}
window.__timelines["{sid}"] = tl;
</script>
</template>
</body></html>
"""
    (ROOT / "compositions" / f"{sid}.html").write_text(doc)
    return sid, dur


def fade_in(sel, t, dy=18):
    return f'tl.fromTo("{sel}", {{opacity: 0, y: {dy}}}, {{opacity: 1, y: 0, duration: 0.5, ease: "power3.out"}}, {t});'


scenes = []

scenes.append(card(
    "intro",
    '<div class="mark" id="in-mark">O</div>'
    '<h1 class="big" id="in-title">Try OnSight yourself</h1>'
    '<p class="sub" id="in-sub">Create an attendance giveaway, check in, get paid. On Solana devnet, about 10 minutes.</p>'
    '<div class="chips" id="in-chips">'
    '<div class="chip"><strong>MetaMask</strong>with Solana turned on, set to devnet</div>'
    '<div class="chip"><strong>~0.05 devnet SOL</strong>free at faucet.solana.com</div>'
    '<div class="chip"><strong>A phone</strong>it becomes the check-in camera</div></div>',
    "\n".join([fade_in("#in-mark", 0.1), fade_in("#in-title", 0.3), fade_in("#in-sub", 0.6), fade_in("#in-chips", 1.1)]),
    5.5,
))

scenes.append(scene(
    "signin", "Step 1 of 6", "Sign in",
    [(0.6, "Open <strong>onsight.site</strong>"), (1.6, "Sign in with <strong>MetaMask</strong>. Free: it's a signature, not a transaction.")],
    "onsight.site",
    [(0, "a1-signin"), (3.7, "a2-overview")],
    cursor=[(0.5, 1150, 760, 0), (0.9, 720, 558, 0.8), (2.4, MM_OK[0], MM_OK[1], 0.6)],
    clicks=[1.8, 3.1], popups=[(2.0, 3.4, "signin")], dur=6,
))

scenes.append(scene(
    "create", "Step 2 of 6", "Create the event",
    [(0.4, "Click <strong>Create event</strong>"), (1.9, "Name it, start it <strong>now</strong>, end it in an hour"),
     (5.2, "Defaults: <strong>0.001 SOL</strong> for <strong>10</strong> people"),
     (8.8, "Payout rules: <strong>5 s</strong> on camera and the OnSight oracle"), (11.8, "<strong>Save terms</strong>")],
    "onsight.site/#/new",
    [(0, "a2-overview"), (1.6, "b2-setup-details"), (5.0, "b3-rewards"), (8.6, "b4-rules")],
    cursor=[(0.2, 1100, 400, 0), (0.4, 1432, 157, 0.7), (2.2, 700, 280, 0.6), (5.3, 920, 330, 0.6), (9.0, 640, 404, 0.6), (11.6, 800, 622, 0.6)],
    clicks=[1.25, 12.35],
    hls=[(2.4, 4.8, 482, 318, 636, 345), (5.6, 8.4, 483, 306, 632, 56), (9.3, 11.4, 497, 376, 297, 54)],
    zooms=[(5.5, 8.2, 800, 390, 1.45), (9.2, 11.3, 640, 420, 1.5)],
    dur=13,
))

scenes.append(scene(
    "launch", "Step 3 of 6", "Launch it",
    [(0.4, "<strong>Launch event</strong> locks the budget: rewards, oracle fees and the account deposit"),
     (2.2, "Approve <strong>one transaction</strong>"), (5.0, "The terms are now frozen in the program")],
    "onsight.site/#/new",
    [(0, "b5-saved"), (2.0, "b6-approve"), (4.9, "b7-launched")],
    cursor=[(0.2, 1150, 500, 0), (0.5, 800, 680, 0.8), (2.5, MM_OK[0], MM_OK[1], 0.6), (5.4, 637, 445, 0.8)],
    clicks=[1.6, 4.25],
    hls=[(0.3, 1.5, 459, 655, 682, 52)],
    zooms=[(0.3, 1.6, 800, 600, 1.35)],
    popups=[(2.1, 4.5, "tx")], dur=8,
))

scenes.append(scene(
    "camera", "Step 4 of 6", "Add the camera",
    [(0.4, "<strong>Open dashboard</strong>, then <strong>Pair cameras</strong>: one free signature"),
     (4.4, "Click the <strong>QR icon</strong> next to Add a camera"), (7.8, "Scan it with your phone. The phone streams to the oracle")],
    f"onsight.site/#/events/{EVENT[:6]}…",
    [(0, "l2-dashboard"), (3.6, "l4-paired"), (5.3, "l5-qr")],
    cursor=[(0.3, 700, 500, 0), (0.6, 1230, 676, 0.9), (2.2, MM_OK[0], MM_OK[1], 0.6), (4.2, 1348, 700, 0.7)],
    clicks=[1.6, 3.0, 5.1],
    hls=[(0.9, 1.6, 1056, 655, 350, 42)],
    popups=[(1.8, 3.3, "pair")], phone=(8.0, "e2-empty"), dur=12,
))

scenes.append(scene(
    "join", "Step 5 of 6", "Join as an attendee",
    [(0.4, "On the dashboard, open the <strong>Attendee page</strong>"), (1.6, "<strong>Sign up with MetaMask</strong>"),
     (4.4, "Take <strong>one selfie</strong>"), (7.2, "<strong>Agree & join</strong> and sign. Free: no transaction")],
    f"onsight.site/?event={EVENT[:6]}…",
    [(0, "d1-attendee"), (3.2, "d2-connected"), (4.4, "d3-selfie"), (6.9, "d4-consent"), (9.0, "d6-signing"), (11.4, "d7-done")],
    cursor=[(0.3, 1150, 650, 0), (0.6, 872, 490, 0.8), (2.0, MM_OK[0], MM_OK[1], 0.6), (3.5, 898, 582, 0.5),
            (5.4, 898, 752, 0.6), (7.6, 898, 597, 0.7), (9.6, MM_OK[0], MM_OK[1], 0.6)],
    clicks=[1.5, 2.75, 4.15, 6.4, 8.6, 10.5],
    popups=[(1.7, 3.0, "connect"), (9.2, 10.8, "join")], dur=14,
))

scenes.append(scene(
    "paid", "Step 6 of 6", "Get paid",
    [(0.4, "Face the phone for <strong>5 seconds</strong>"),
     (1.8, "On the dashboard, the box is <strong>orange</strong> while the oracle tracks you"),
     (7.0, "It turns <strong>green</strong> once the program has paid"),
     (9.2, "<strong>0.001 SOL</strong> lands in your wallet. Nobody approves it: the payout is a public transaction")],
    f"onsight.site/#/events/{EVENT[:6]}…",
    [(0, "m0-online"), (1.6, "m1-tracking"), (3.4, "m2-tracking"), (5.2, "m3-tracking"), (7.0, "m4-paid"), (9.2, "l4-paired"), (12.2, "d8-paid")],
    cursor=[(0.3, 1000, 450, 0), (0.5, 1400, 626, 0.8)],
    clicks=[1.4],
    hls=[(9.6, 11.8, 176, 640, 814, 36), (12.6, 15.6, 722, 566, 351, 44)],
    zooms=[(1.8, 8.6, 800, 482, 1.2)],
    phone=(0.2, "e2-streaming", 1.5), dur=16,
))

scenes.append(card(
    "outro",
    '<h1 class="big" id="out-title">After the end, withdraw what\'s left</h1>'
    '<p class="sub" id="out-sub">Event settings (the cog) → Withdraw. While the event runs, the program refuses.</p>'
    '<div class="addr" id="out-addr">onsight.site</div>'
    '<p class="note" id="out-note">OnSight · Seen on site, paid on-chain. No server holds the money or the list: the Solana program decides.</p>',
    "\n".join([fade_in("#out-title", 0.1), fade_in("#out-sub", 0.5), fade_in("#out-addr", 1.0), fade_in("#out-note", 1.6)]),
    7,
))

t = 0.0
hosts = []
for k, (sid, dur) in enumerate(scenes):
    hosts.append(f'    <div id="{sid}" data-composition-id="{sid}" data-composition-src="compositions/{sid}.html" data-start="{t:g}" '
                 f'data-duration="{dur:g}" data-track-index="1" data-track-kind="graphics" data-width="{W}" data-height="{H}"></div>')
    t += dur
total = t

(ROOT / "index.html").write_text(f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width={W}, height={H}" />
    <title>OnSight: try it yourself</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      body {{ margin: 0; background: #F3F2EE; }}
      #main {{ position: relative; width: 100%; height: 100%; overflow: hidden; background: #F3F2EE; }}
    </style>
  </head>
  <body>
    <div id="main" data-composition-id="main" data-start="0" data-width="{W}" data-height="{H}" data-duration="{total:g}">
{chr(10).join(hosts)}
    </div>
    <script>
      const tl = gsap.timeline({{ paused: true }});
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
""")
print(f"{len(scenes)} scenes, {total:g} s")
