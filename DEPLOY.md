# R!OT WALL, putting it online

ENDLESS RIVER x MIXR STUDIOS. Every guest's phone becomes a spray can; they all paint
one shared wall on the venue screen at once.

## Read this first: it is not a static site

This is a **live Node server**. Guests' phones talk to it constantly and it
pushes every stroke to the screen over a persistent connection. Uploading these
files to plain file hosting (the usual cPanel `public_html` drop) will serve the
pages and then nothing will work: no cans, no paint, no leads.

It needs a host that runs Node 18 or newer and keeps a process alive.

## VERCEL WILL NOT WORK, and it is worth knowing why

Vercel runs serverless functions: each request gets a short-lived instance with
no shared memory, no writable disk, and a hard execution limit. This app is the
opposite of all three. It keeps the whole wall in memory, holds one streaming
connection open per screen for the entire night, and writes the wall and the
leads to disk. On Vercel the wall would forget itself between requests, the
stream would be cut, and nothing would persist. Netlify and GitHub Pages fail
the same way, harder.

Making it work there is not configuration, it is a rewrite: state into a
database, the live feed into a hosted realtime service. Not worth it for a
one-night activation.

## What to use instead

| Host | Verdict |
|---|---|
| **The venue laptop + a tunnel** | **Best for the night.** See below. |
| **Render** | Best cloud option. `render.yaml` is included, one click. **Attach the disk** or a restart loses the wall. Free tier sleeps and cold-starts ~30s, so pay the $7 for a live event. |
| **Railway / Fly / any VPS** | Fine. `Dockerfile` is included; mount a volume at `/app/data`. |
| **cPanel / Bluehost** | Only if the plan has **Setup Node.js App**. Startup file `server.mjs`. Test the wall for a full minute before trusting it: cPanel fronts Node with Apache, and Apache likes to buffer streaming responses, which shows up as a wall that connects and then never updates. |

**HTTPS is not optional.** Phone cameras and the motion sensor only run in a
secure context. Any real host gives you HTTPS; a bare IP address never will.

## Two settings before you go live

```
RIOT_ADMIN_KEY   the staff key. CHANGE IT.
PORT             set automatically by every host. Leave it alone.
```

The staff key defaults to `riot2026`. It is the only thing between a stranger
and **Wipe wall** plus the entire email list, so set your own in the host's
environment variables. The server prints a warning at boot if you have not.

Do **not** set `RIOT_DEV`. It opens a dev capture endpoint that writes files.

## What runs where

| Page | Who opens it |
|---|---|
| `/` | the guests, from the printed QR |
| `/wall` | the venue screen, fullscreen (F11) |
| `/admin` | staff phone. Sign in with the key before anything works. |

## Data, and the thing to decide before the night

Everything is saved to `data/` next to the server: every stroke tagged with its
painter, plus `leads.csv` with tag names and emails. It survives a crash and the
wall rebuilds itself exactly.

**On a cloud host, check whether that disk is persistent.** Render and Railway
give containers an ephemeral filesystem by default, so a restart mid-night would
take the wall and the leads with it. Either attach a persistent volume, or run
the venue laptop option below. Export the CSV from `/admin` at the end of the
night regardless.

`data/` is deliberately NOT in this zip. It holds real email addresses.

## The venue-grade option

For the actual night, run it on the machine driving the screen:

1. `START-WALL.cmd`
2. `PHONE-TEST.cmd` opens an HTTPS tunnel and puts a QR on screen for the
   printed cards.

Everything is local, so the wall does not die if the venue wifi does. Only the
phones need to reach the tunnel. A permanent web address needs
`cloudflared tunnel login` once on your account.

## Tracking panels

On-screen by default: the wall draws four Girl Riot posters in its side gutters
and the phones track those, so there is nothing to print and the calibration
derives itself. Staff can switch to real printed panels in `/admin`, then enter
the tape measurements. See `../Documents/PANEL-LOAD-IN.md`.

Panel artwork ships in `assets/panels/`. To regenerate: open `/panels.html`,
Generate, Save (needs `RIOT_DEV=1` locally), then copy the PNGs from `captures/`
into `assets/panels/` and recompile the targets with
`python make-target-local.py captures/panel-1.png panel1`.

## Checking it works

```
npm run check
```

70 assertions on the aim geometry. If those pass, the maths is intact; the
camera and the panels still need a real phone.

## What is still open

- Nothing has been tested with many phones at once. Latency and contention only
  show up in a rehearsal.
- The wordmark is a system serif, not the licensed display face.
- ENDLESS RIVER and MIXR STUDIOS artwork on the wall are placeholders.
- No end-of-night job yet to email everyone the finished wall.
