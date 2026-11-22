### K: A removed agent's keyholder restarts until no pairing can sign in

Status: Fixed in #301. Found by the owner on 2026-11-22, whose setup failed after the approval with
"Too many attempts. Try again in 15 minutes."

A keyholder whose account WebChat refuses, because its owner removed it or it was paired again,
exited on the 401. launchd's `KeepAlive` restarted it every 10 seconds, and each start signed in
twice and failed. Sign-up, sign-in and the key routes share 20 failures per address in 15 minutes
(D-068), so the old keyholder used them up in under two minutes. A new pairing's first sign-in,
from the same laptop, then got 429, and each new code left another approved agent behind.

Fixed: `Plugin.serve` takes a 401 as a problem that `status` shows, telling the owner to run setup,
and the service idles instead of exiting. The loop's timers stop when the check-ins end, so they
sign in no more either. Setup restarts the keyholder after it pairs, so the new account loads.
