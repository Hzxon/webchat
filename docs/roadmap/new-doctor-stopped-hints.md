### K: Doctor blames macOS and forgets the server when the keyholder is stopped

Status: Fixed in #303. Found by the owner on 2026-11-22, after stopping a looping keyholder with
`launchctl bootout`.

Doctor then said two wrong things. It told the owner that macOS may have turned the keyholder off
under Login Items, though Background Items still listed it as enabled. It also said `Network: not
paired yet`, because it read the server only from the running keyholder.

Fixed: doctor and status read `sfltool dumpbtm`, which needs no sudo, and name Login Items only for
a service macOS turned off there. A service that is not loaded was stopped, as `launchctl bootout`
does, and setup starts it again. A loaded one that does not run stops after it starts, so they
point to its log. The network check falls back to the server in the updater's `update.json`.
