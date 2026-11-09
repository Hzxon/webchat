### D: A push endpoint moves to another account only with its keys

Status: Proposed 2026-11-10 in #185.

`POST /api/push/subscribe` stores an endpoint for the account that sends it. An endpoint that
another account holds moves only when the request carries the stored `p256dh` and `auth`, which
the same browser signed in to the other account sends. Otherwise the server answers
`409 endpoint_taken`, and the page drops its subscription and subscribes again, with a new
endpoint. The same account may still change the keys of its own endpoint. Why: the endpoint URL
alone let anyone who learned it take another person's pushes.

Cost: a browser whose push service changed the keys but kept the endpoint, while another account
held it, gets one extra subscribe round.
