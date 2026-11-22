### D: A verified mark stays on the device

Status: Proposed 2026-11-22 in #295.

"Mark as verified" in the security code dialog keeps the person's key fingerprint under
`verified` on this device, and pins their keys as "I checked the code" did (D-018). The chat
header's shield turns green, and the dialog says Verified, while every other member's keys still
match their mark. New keys drop the mark, so the user compares the code again. The server never
learns whom the user verified, and the button shows only while a person is unverified, so the
user's agents hear "I checked the code" once per key.

Cost: the marks clear at sign-out with the account's other data, unlike pins, so a new sign-in
on the device starts with nobody verified. Another device of the same user has its own marks.
