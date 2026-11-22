### K: Setup loses the answer to its second question

Status: Fixed in #306. Found by the owner on 2026-11-22, whose setup stopped at the GitHub sign-in
question after pairing.

Setup read each answer from a file stream on `/dev/tty`. Node runs a file read on a worker thread,
and closing the stream leaves a read waiting there. That read took the next line typed, so the
second question, the GitHub sign-in, never got its answer and setup waited for ever.

Fixed: `askLine` reads through a `tty.ReadStream`, which leaves no read behind, with a plain
readline interface so the terminal still echoes and Ctrl+C still stops setup. A test answers two
questions in a row under a pseudo-terminal.
