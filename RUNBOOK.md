# QNB Movie Night — Launch Runbook

**Toy Story 5 · Saturday 20 June 2026 · 4:00 PM · Novo Cinemas, Doha Oasis**

## Live pages
| Page | URL | Used by |
|---|---|---|
| Guest ticket (verify by mobile) | `/` (index.html) | Guests, at the door |
| Confirm attendance (shared link) | `/confirm.html` | Guests, ahead of time |
| Organizer scanner | `/scan.html` | Door staff (PIN) |
| Organizer dashboard | `/admin.html` | Organizers (PIN) |
| Entrance QR poster (print) | `/poster.html` | Print & post at entrance |

Base: `https://alemadi.github.io/qnb-movie-night`

## Headcount
- **Confirmed:** 76 bookings / **237 seats**
- **Waitlist:** 154 bookings / 442 seats
- **Halls:** Hall 3 + Hall 4 — assigned at the gate during scanning (no pre-assignment)

## Access
- A single **4-digit organizer PIN** gates the scanner and dashboard. It is held by organizers and never stored in the website. Anyone scanning needs a camera phone + the PIN.

## T‑1 (Friday)
1. **Print the poster** (`poster.html` → print) — at least 2 copies for the entrance.
2. **Test the scanner:** on your phone open `scan.html`, enter the PIN, and scan a real ticket (open `/`, verify with any confirmed mobile to render a QR). Confirm camera + ✅ Admit + the Hall 3 / Hall 4 buttons work.
3. Decide the confirm-link send time (**recommended: Saturday morning**). Wording is date-aware, so it reads correctly whenever sent.

## Day-of (Saturday) — before doors
1. **Send the confirm link** to all 75 confirmed guests, either:
   - **Tap-to-send:** open `qnb_links_confirmed.csv`, tap each `wa_me_link`, hit send (personalized, ~10–15 min); or
   - **Broadcast list:** import `qnb_contacts_confirmed.vcf`, create a WhatsApp broadcast, paste the shared link.
2. **Watch `admin.html`:** "Said yes" climbs; "Declined" frees seats.
3. **Promotions:** when a guest declines, the next fitting waitlister is **auto-promoted** and appears under *"Just promoted — notify them."* Tap **Notify** to send them the confirm link.

## At the gate (from 3:30 PM)
1. Guest scans the **entrance poster QR** → enters mobile → gets their QR ticket (or already has it from confirming).
2. Organizer opens `scan.html` (PIN once) and scans the guest's QR:
   - **✅ Admit** → tap **Hall 3** or **Hall 4** to direct them.
   - **⚠️ Already checked in** → ticket was already used.
   - **✕ Invalid** → not a valid ticket.
3. Tap **Scan next** and continue.

## Fallbacks
- **Scanner / Wi-Fi down:** use the printed backup roster (the check-in sheet); verify by name/mobile and tick arrivals.
- **Guest can't load ticket:** have them re-open `/` and verify with their mobile, or check them in on the roster.
- **Number not found:** they may have registered under a different number — check the roster.

## Known data notes
- Two numbers in the source were shared by two different people (`60006994`, `30684489`); only the first of each is in the system. Verify their real number if the second person arrives.
- The WhatsApp Cloud API auto-send (`wa-send` / `wa-webhook` Edge Functions) is **built but dormant** (no secrets set, so it rejects all traffic). Not required for this event.

## Security model (for reference)
- The browser holds only the public anon key. Every table has RLS enabled with **no policies**, so the anon key can't read guest data directly.
- All access goes through PIN/token-gated `SECURITY DEFINER` RPCs. The service-role key is never in the site or git.
