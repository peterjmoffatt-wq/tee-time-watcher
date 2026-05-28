#!/usr/bin/env python3
"""
Tee Time Watcher — ForeUp cancellation sniper and 7 PM drop sniper.

Usage:
  python3 bethpage_book.py --date 05-30-2026 [--date 05-31-2026 ...]
                           [--book] [--players N] [--course SCHEDULE_ID]
                           [--after HH:MM] [--before HH:MM]
                           [--snipe]  # 7 PM drop mode

Credentials are read from courses.json and config.json (see *.example.json).
"""

import os, requests, json, time, sys, signal, argparse, smtplib
from datetime import datetime, timedelta
from email.mime.text import MIMEText

# ── Load config files ─────────────────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))

def _load(name):
    try:
        with open(os.path.join(_HERE, name)) as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"[warn] {name} not found — copy {name.replace('.json','.example.json')} to get started.")
        return {} if name == 'config.json' else []

_cfg        = _load('config.json')
_facilities = _load('courses.json')

# Build schedule_id → facility lookup
_fac_by_course = {}
for _fac in (_facilities if isinstance(_facilities, list) else []):
    for _c in _fac.get('courses', []):
        _fac_by_course[str(_c['id'])] = _fac

# ── SMS / Notification config (from config.json) ──────────────────────────────
TWILIO_ACCOUNT_SID = _cfg.get('twilio_account_sid', '')
TWILIO_AUTH_TOKEN  = _cfg.get('twilio_auth_token',  '')
TWILIO_FROM_NUMBER = _cfg.get('twilio_from',        '')
YOUR_PHONE_NUMBER  = _cfg.get('phone',              '')
CARRIER_GATEWAY    = _cfg.get('carrier_gateway',    '')
GMAIL_USER         = _cfg.get('gmail_user',         '')
GMAIL_APP_PASS     = _cfg.get('gmail_app_pass',     '')

# ── Runtime credentials (set in main() from courses.json) ────────────────────
USERNAME       = ''
PASSWORD       = ''
COURSE_ID      = ''
CREDIT_CARD_ID = ''
BOOKING_URL    = ''

# ── Course schedule IDs ───────────────────────────────────────────────────────
COURSES = {
    "black":  "2431",
    "blue":   "2433",
    "red":    "2432",
    "yellow": "2435",
    "green":  "2434",
}

DEFAULT_BOOKING_CLASS = "2136"  # Resident (6-day window)

# ── ForeUp API ────────────────────────────────────────────────────────────────
BASE_API_URL = "https://foreupsoftware.com/index.php/api/booking/"

HEADERS_BASE = {
    "User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0.0.0 Safari/537.36",
    "Accept":           "application/json, text/javascript, */*; q=0.01",
    "Accept-Language":  "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    "Origin":           "https://foreupsoftware.com",
}

POLL_INTERVAL_SEC = 45
REAUTH_EVERY      = 30

SNIPE_DROP_HOUR  = 19   # 7 PM
SNIPE_FAST_SEC   = 0.8  # poll interval during drop window
SNIPE_WARMUP_SEC = 5    # poll interval in final 2 min before drop
SNIPE_WINDOW_MIN = 15   # give up this many minutes after the drop


# ── Notification ──────────────────────────────────────────────────────────────
def send_sms(message: str) -> None:
    if CARRIER_GATEWAY and GMAIL_USER and GMAIL_APP_PASS:
        _send_via_email_gateway(message)
    elif TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER:
        _send_via_twilio(message)
    else:
        print("  [SMS] No SMS provider configured — skipping text alert.")


def _send_via_twilio(body: str) -> None:
    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
    r = requests.post(
        url,
        auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
        data={"From": TWILIO_FROM_NUMBER, "To": YOUR_PHONE_NUMBER, "Body": body},
        timeout=10,
    )
    if r.ok:
        print(f"  [SMS] Twilio text sent to {YOUR_PHONE_NUMBER}")
    else:
        print(f"  [SMS] Twilio error {r.status_code}: {r.text[:200]}")


def _send_via_email_gateway(body: str) -> None:
    number  = YOUR_PHONE_NUMBER.lstrip("+1")
    to_addr = f"{number}@{CARRIER_GATEWAY}"
    msg = MIMEText(body)
    msg["From"]    = GMAIL_USER
    msg["To"]      = to_addr
    msg["Subject"] = ""
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
            s.login(GMAIL_USER, GMAIL_APP_PASS)
            s.send_message(msg)
        print(f"  [SMS] Email-to-SMS sent to {to_addr}")
    except Exception as e:
        print(f"  [SMS] Gateway error: {e}")


# ── ForeUp helpers ────────────────────────────────────────────────────────────
def make_session(schedule_id: str) -> requests.Session:
    session = requests.Session()
    session.get(
        f"{BOOKING_URL}{schedule_id}",
        headers={**HEADERS_BASE, "Accept": "text/html,application/xhtml+xml,*/*"},
        timeout=15,
    )
    return session


def login(session: requests.Session, schedule_id: str) -> dict | None:
    r = session.post(
        BASE_API_URL + "users/login",
        data={
            "username":         USERNAME,
            "password":         PASSWORD,
            "booking_class_id": schedule_id,
            "api_key":          "",
            "course_id":        COURSE_ID,
        },
        headers={
            **HEADERS_BASE,
            "Referer": f"{BOOKING_URL}{schedule_id}",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        timeout=15,
    )
    if not r.ok:
        return None
    data = r.json()
    return data if data.get("logged_in") else None


def fetch_times(session: requests.Session, jwt: str, date: str,
                schedule_id: str, booking_class: str, players: int) -> list:
    headers = {
        **HEADERS_BASE,
        "Authorization": f"Bearer {jwt}",
        "Referer": f"{BOOKING_URL}{schedule_id}",
    }
    params = {
        "time":           "all",
        "date":           date,
        "holes":          "18",
        "players":        str(players),
        "booking_class":  booking_class,
        "schedule_id":    schedule_id,
        "schedule_ids[]": schedule_id,
        "specials_only":  "0",
        "api_key":        "",
    }
    r = session.get(BASE_API_URL + "times", params=params, headers=headers, timeout=15)
    if not r.ok:
        return []
    data = r.json()
    return data if isinstance(data, list) else []


def slot_in_window(slot: dict, after_time: str | None, before_time: str | None) -> bool:
    try:
        t = datetime.strptime(slot["time"], "%Y-%m-%d %H:%M").time()
        if after_time:
            if t < datetime.strptime(after_time, "%H:%M").time():
                return False
        if before_time:
            if t >= datetime.strptime(before_time, "%H:%M").time():
                return False
        return True
    except Exception:
        return True


def create_pending(session: requests.Session, jwt: str, slot: dict,
                   schedule_id: str, booking_class: str, players: int) -> dict | None:
    headers = {
        **HEADERS_BASE,
        "Authorization": f"Bearer {jwt}",
        "Referer": f"{BOOKING_URL}{schedule_id}",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    }
    payload = {
        "time":             slot["time"],
        "holes":            "18",
        "players":          str(players),
        "carts":            "0",
        "schedule_id":      str(slot.get("schedule_id", schedule_id)),
        "teesheet_side_id": str(slot.get("teesheet_side_id", "")),
        "course_id":        str(slot.get("course_id", COURSE_ID)),
        "booking_class_id": str(slot.get("booking_class_id", booking_class)),
        "foreup_discount":  "0",
        "foreup_trade_discount_rate": "0",
        "trade_min_players": "0",
        "cart_fee":         str(slot.get("cart_fee", 0) or 0),
        "cart_fee_tax":     str(slot.get("cart_fee_tax", 0) or 0),
        "green_fee":        str(slot.get("green_fee", 0) or 0),
        "green_fee_tax":    str(slot.get("green_fee_tax", 0) or 0),
        "credit_card_id":   CREDIT_CARD_ID,
    }
    r = session.post(BASE_API_URL + "pending_reservation", data=payload, headers=headers, timeout=15)
    print(f"  Pending reservation: {r.status_code}")
    try:
        return r.json()
    except Exception:
        print(f"  Raw: {r.text[:400]}")
        return None


def ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


# ── 7 PM Drop Sniper ──────────────────────────────────────────────────────────
def run_snipe(args, session, jwt, schedule_id, booking_class, players,
              after_time, before_time, course_name):
    now      = datetime.now()
    drop     = now.replace(hour=SNIPE_DROP_HOUR, minute=0, second=0, microsecond=0)
    drop_end = drop + timedelta(minutes=SNIPE_WINDOW_MIN)

    if now >= drop_end:
        print(f"[{ts()}] Snipe window already closed for today.")
        return False

    print(f"\nSNIPE MODE — {course_name}")
    print(f"  Target dates : {', '.join(args.dates)}")
    print(f"  Time window  : {after_time or 'Opening'} – {before_time or 'Any time'}")
    print(f"  Snipe window : {drop.strftime('%I:%M %p')} – {drop_end.strftime('%I:%M %p')}")
    print()

    attempt = reauth_tick = 0

    while True:
        now     = datetime.now()
        secs_to = (drop - now).total_seconds()

        if now >= drop_end:
            print(f"\n[{ts()}] Snipe window closed — no matching slot found.")
            send_sms(f"Bethpage {course_name}: 7 PM drop window closed, nothing in your time window.")
            return False

        if secs_to > 120:
            m, s = divmod(int(secs_to), 60)
            print(f"[{ts()}] Drop in {m}m {s:02d}s ...", flush=True)
            time.sleep(min(30, secs_to - 90))
            continue

        if secs_to > 3:
            print(f"[{ts()}] Warmup — {secs_to:.1f}s to drop, re-authing ...", flush=True)
            s2 = make_session(schedule_id)
            u2 = login(s2, schedule_id)
            if u2:
                session = s2
                jwt     = u2.get("jwt", "")
                print(f"[{ts()}] JWT refreshed, ready to snipe.", flush=True)
            time.sleep(SNIPE_WARMUP_SEC)
            continue

        attempt     += 1
        reauth_tick += 1
        if reauth_tick > 1 and reauth_tick % 25 == 0:
            u2 = login(session, schedule_id)
            if u2:
                jwt = u2.get("jwt", "")

        print(f"[{ts()}] SNIPE #{attempt}", flush=True)

        for date in args.dates:
            try:
                times     = fetch_times(session, jwt, date, schedule_id, booking_class, players)
                available = [t for t in times if t.get("available_spots", 0) > 0]

                if not available:
                    print(f"  {date}: no slots yet", flush=True)
                    continue

                bookable = (
                    [s for s in available if slot_in_window(s, after_time, before_time)]
                    if (after_time or before_time) else available
                )

                print(f"  {date}: {len(available)} available, {len(bookable)} in window", flush=True)
                for s in available:
                    tag = "" if s in bookable else "  [outside window]"
                    print(f"    {s.get('time')}  {s.get('available_spots')} spot(s)  ${s.get('green_fee')}{tag}", flush=True)

                if not bookable:
                    continue

                booking_link = f"{BOOKING_URL}{schedule_id}#teetimes"

                if args.book:
                    slot   = bookable[0]
                    print(f"  >>> BOOKING {slot['time']} ...", flush=True)
                    result = create_pending(session, jwt, slot, schedule_id, booking_class, players)
                    if result and (result.get("reservation") or result.get("pending_reservation_id")):
                        msg = (f"Bethpage {course_name} SNIPED!\n"
                               f"Date: {date}\nTime: {slot['time']}\nComplete: {booking_link}")
                        print(f"\n{'='*55}\n{msg}\n{'='*55}")
                        send_sms(msg)
                        return True
                    else:
                        print(f"  Booking failed: {json.dumps(result or {})[:200]}", flush=True)
                else:
                    msg = (f"Bethpage {course_name} DROP — slot open!\n"
                           f"Date: {date}\nTime: {bookable[0]['time']}\nBook now: {booking_link}")
                    send_sms(msg)
                    return True

            except requests.exceptions.ConnectionError:
                print(f"  Network error on snipe #{attempt}", flush=True)
            except Exception as e:
                print(f"  Error: {e}", flush=True)

        time.sleep(SNIPE_FAST_SEC)


# ── Arg parser ────────────────────────────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser(description="Tee Time Watcher — ForeUp booking sniper")
    p.add_argument("--date",    action="append", dest="dates", metavar="MM-DD-YYYY")
    p.add_argument("--book",    action="store_true", help="Auto-reserve on match")
    p.add_argument("--players", type=int, default=1)
    p.add_argument("--check",   action="store_true", help="Single check, no loop")
    p.add_argument("--snipe",   action="store_true", help="7 PM drop sniper mode")
    p.add_argument("--course",  default="2431",       help="Schedule/teesheet ID")
    p.add_argument("--booking-class", default=DEFAULT_BOOKING_CLASS, dest="booking_class")
    p.add_argument("--after",  default=None, metavar="HH:MM")
    p.add_argument("--before", default=None, metavar="HH:MM")
    return p.parse_args()


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    global USERNAME, PASSWORD, COURSE_ID, CREDIT_CARD_ID, BOOKING_URL

    args = parse_args()

    if not args.dates:
        today = datetime.now()
        days_until_sat = (5 - today.weekday()) % 7 or 7
        args.dates = [(today + timedelta(days=days_until_sat)).strftime("%m-%d-%Y")]
        print(f"No --date given, defaulting to next Saturday: {args.dates[0]}")

    schedule_id   = args.course
    booking_class = args.booking_class
    players       = args.players
    after_time    = args.after
    before_time   = args.before

    # Load facility credentials from courses.json
    fac = _fac_by_course.get(str(schedule_id), {})
    if not fac:
        print(f"No facility found for schedule_id {schedule_id} in courses.json.")
        sys.exit(1)

    USERNAME       = fac.get('username', '')
    PASSWORD       = fac.get('password', '')
    COURSE_ID      = fac.get('facilityId', '')
    CREDIT_CARD_ID = fac.get('credit_card_id', '')
    BOOKING_URL    = f"https://foreupsoftware.com/index.php/booking/{COURSE_ID}/"

    course_name = next((k.title() for k, v in COURSES.items() if v == schedule_id), schedule_id)

    print(f"\n{fac.get('name', 'Course')} — {course_name}")
    print(f"  Dates:   {', '.join(args.dates)}")
    print(f"  Players: {players}")
    print(f"  Window:  {after_time or 'Opening'} – {before_time or 'Any time'}")
    print(f"  Mode:    {'SNIPE' if args.snipe else 'AUTO-BOOK' if args.book else 'watch-only'}")
    print()

    session = make_session(schedule_id)
    user    = login(session, schedule_id)
    if not user:
        print("Login failed. Check credentials in courses.json.")
        sys.exit(1)
    jwt = user.get("jwt", "")
    print(f"Logged in: {user.get('first_name')} {user.get('last_name')}")
    print()

    attempt = 0

    def check_all_dates() -> bool:
        nonlocal session, jwt
        for date in args.dates:
            times     = fetch_times(session, jwt, date, schedule_id, booking_class, players)
            available = [t for t in times if t.get("available_spots", 0) > 0]
            print(f"  {date}: {len(available)} avail / {len(times)} total")

            if not available:
                continue

            bookable = (
                [s for s in available if slot_in_window(s, after_time, before_time)]
                if (after_time or before_time) else available
            )

            for slot in available:
                tag = "" if slot in bookable else "  [outside window — skipping]"
                print(f"    OPEN: {slot.get('time')}  {slot.get('available_spots')} spot(s)"
                      f"  ${slot.get('green_fee')} green fee{tag}")

            if not bookable:
                continue

            booking_link = f"{BOOKING_URL}{schedule_id}#teetimes"

            if args.book:
                slot   = bookable[0]
                print(f"  Booking {slot['time']} ...")
                result = create_pending(session, jwt, slot, schedule_id, booking_class, players)
                if result and (result.get("reservation") or result.get("pending_reservation_id")):
                    msg = (f"Bethpage {course_name} BOOKED!\n"
                           f"Date: {date}\nTime: {slot['time']}\nComplete here: {booking_link}")
                    print(f"\n{'='*55}\n{msg}\n{'='*55}")
                    send_sms(msg)
                    return True
                else:
                    print(f"  Pending failed: {json.dumps(result, indent=2)[:300]}")
            else:
                msg = (f"Bethpage {course_name} slot open!\n"
                       f"Date: {date}\nTime: {available[0]['time']}\nBook now: {booking_link}")
                send_sms(msg)

        return False

    signal.signal(signal.SIGINT,
                  lambda sig, frame: (print(f"\n[{ts()}] Stopped after {attempt} checks."), sys.exit(0)))

    if args.snipe:
        run_snipe(args, session, jwt, schedule_id, booking_class, players,
                  after_time, before_time, course_name)
        return

    if args.check:
        print(f"[{ts()}] Single check:")
        check_all_dates()
        return

    while True:
        attempt += 1
        if attempt > 1 and (attempt - 1) % REAUTH_EVERY == 0:
            print(f"[{ts()}] Re-authenticating ...")
            session = make_session(schedule_id)
            u2      = login(session, schedule_id)
            if u2:
                jwt = u2.get("jwt", "")

        print(f"[{ts()}] Check #{attempt}", flush=True)
        try:
            if check_all_dates():
                break
        except requests.exceptions.ConnectionError:
            print("  Network error, retrying ...")
        except Exception as e:
            print(f"  Error: {e}")

        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
