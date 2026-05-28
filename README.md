# Tee Time Watcher

A mobile-friendly web UI + Python backend for sniping tee times on ForeUp-based booking systems (Bethpage State Park, and others).

## Features

- **Cancellation watcher** — polls every 45 seconds, texts you (and optionally auto-books) the moment a slot opens
- **7 PM drop sniper** — waits for the nightly tee-time release, then hits the API every ~0.8 seconds to grab a slot before the web UI even loads
- **Time windows** — set a From/Until range per watcher (e.g. Opening – 3:00 PM)
- **Multi-course** — run simultaneous watchers for different courses or date ranges
- **Auto-book or notify** — charge the card on file instantly, or just get a text and book manually
- **SMS alerts** — via Gmail email-to-SMS gateway or Twilio

## Setup

### 1. Install dependencies

```bash
npm install
pip3 install requests
```

### 2. Configure credentials

```bash
cp courses.example.json courses.json
cp config.example.json config.json
```

Edit `courses.json` with your ForeUp login and credit card ID, and `config.json` with your phone/SMS settings.

To find your `credit_card_id`: log into the booking site, open DevTools → Network, click a tee time, and look for `credit_card_id` in the POST body.

### 3. Run the server

```bash
npm start
```

Open **http://localhost:3030** on your phone or browser.

## Adding other courses

Click **+ Add facility / course site** in the UI, or manually add entries to `courses.json` following the format in `courses.example.json`. Any ForeUp-powered booking site should work.

## SMS setup (Gmail gateway)

1. Enable 2-Step Verification on your Google account
2. Generate an App Password at myaccount.google.com → Security → App Passwords
3. Add it to `config.json` as `gmail_app_pass`
4. Set `carrier_gateway` to your carrier's email-to-SMS domain:
   - T-Mobile: `tmomail.net`
   - Verizon: `vtext.com`
   - AT&T: `txt.att.net`

## CLI usage

You can also run the watcher directly:

```bash
# Watch for cancellations and auto-book before 10 AM
python3 bethpage_book.py --date 06-07-2026 --book --before 10:00

# Snipe tonight's 7 PM drop on the Black course
python3 bethpage_book.py --date 06-03-2026 --course 2431 --book --before 10:00 --snipe

# Single check to see what's available
python3 bethpage_book.py --date 06-07-2026 --course 2432 --check
```
