# Email & notifications

Email gives agentqs a way to reach **you**: the daily notification, an agent rule's
ping, the **Forgot password?** link. It is also the fourth channel - reply to one of
those emails and the reply lands in your record, the same as a Slack or Telegram
message. Everything is set up in one card, **Settings → Channels → Email**, and mail
never touches the record: sending a message writes nothing.

---

## Two transports

One is active at a time.

| | SMTP | Gmail API |
| --- | --- | --- |
| Sends | yes | yes |
| Reads replies | **no - send-only, by design** | yes, when *Capture replies* is ticked |
| You give it | host, port, username, password | one Authorize click |
| Works with | Gmail app passwords, Fastmail, SES, Postmark, your own server | a Google account |

Pick **SMTP** if you only want agentqs to mail you, or your mail is not Google's. It
is the smaller thing to trust: a password that can send and nothing else, and no
Google Cloud project.

Pick the **Gmail API** if you want to *answer* those emails. SMTP cannot read a
mailbox, so replies only ever come back on this transport.

---

## SMTP setup that actually works

The port decides how the connection is secured, and those two are the only choices:

| Port | What happens |
| --- | --- |
| **587** | connects plain, then upgrades with STARTTLS before anything else is said |
| **465** | TLS from the first byte (implicit TLS) |

A server that offers no TLS is **refused, not downgraded**. Without TLS your password
would cross the network in the clear, so agentqs stops before sending it:

```
SMTP mail.example.com:25 offers no TLS (no STARTTLS), so the password would travel in the clear — refusing. Use port 465 or 587.
```

That is by design. A plaintext-only server will never work here, and no setting
turns the check off. An untrusted certificate is refused the same way.

**Gmail over SMTP** is `smtp.gmail.com`, port `587`, your full address as the
username - and an **app password**, not your account password. Google only lets you
create one with 2-Step Verification on
([myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)). It
is 16 characters; your normal password is turned away with Google's own words, which
agentqs shows you as they came:

```
SMTP smtp.gmail.com:587 refused AUTH PLAIN: 535 5.7.8 Username and Password not accepted.
```

Leave **From** blank and it sends as the username. Then press **Test** - it sends a
real message, and the card keeps the outcome (`Sent`, or the server's reason), so it
is still there after a reload.

```bash
agentqs mail                          # which transport, can it send, can it read replies
agentqs mail test --to you@example.com
```

---

## Google in one click

If Calendar or Gmail is already connected, the Email card **reuses that Client ID and
Secret** - nothing is pasted twice, you only press Authorize. (No Google key saved
yet? The card takes a Client ID and Secret of its own.)

The *grant* is separate from the read-only one that imports your calendar and mail
counts. Sending as you is its own consent, so it asks for **`gmail.send` alone**.
Tick *Capture replies* and it widens to `gmail.send` + `gmail.readonly`; the scope
Google is asked for follows the tick, so changing it means authorizing again.

This is deliberately **not** one of the products on the Google card (it is not in
`GOOGLE_PRODUCTS`). That card is for what agentqs *imports*. Outbound Google is its
own thing - the same rule `gdrive_backup` follows - so sending never appears in the
pipeline, and disconnecting Calendar never takes your email down with it.

Starting an Authorize does not switch transports. An abandoned Google tab leaves a
working SMTP setup alone; the switch happens when the grant actually lands.

---

## How replies come back

There is **no webhook**, and nothing to host. Every email agentqs sends you ends with
a short footer:

```
-- 
agentqs -- reply to this and it lands in your record -- aqs#<token>
```

Your mail client quotes the original when you reply, so the `aqs#` token comes back
for free. One Gmail search finds every reply to every notification:

```
in:anywhere "aqs#" newer_than:7d
```

No labels, no filters, no inbound address, no tunnel to keep alive - which is the
whole reason there is no webhook. It is an ordinary due-source the in-app scheduler
sweeps on the same host as your record; `agentqs sync --id email` runs it by hand.

What counts as a reply is kept narrow on purpose, because with AI replies on, a
captured message gets *answered* from your record. All four must hold:

- it carries **this instance's** token, not just any `aqs#`;
- it is a real reply (`In-Reply-To` / `References`) - agentqs's own outgoing mail never is, so a notification is never captured as its own answer;
- it is From an address agentqs has mailed, or the account itself;
- Gmail did not file it under Spam or Trash.

It lands under Gmail's own message id, so a reply seen twice lands once. The token is
minted once and kept in its own file - a password reset rotates the session secret,
and replies to emails already sent still match.

**The honest limit.** Only what you typed should land, so the quoted original is cut
off - and there is no standard for how a mail client marks quoted text. agentqs cuts
at the first `>` line, an `On … wrote:` line, the `-- ` signature marker, Outlook's
`-----Original Message-----` divider, or its own footer. That is right for Gmail,
Apple Mail and Outlook replying above the quote. It is **not exact for every
client**: a localized attribution (`Am … schrieb:`), one wrapped over three lines, or
a reply typed *under* the quote is cut wrong. The last comes back empty and is
skipped rather than captured as garbage.

---

## Notifications

A notification is one message a day, at a local time, to Slack, Telegram or email.
Two kinds:

| Kind | What is sent |
| --- | --- |
| `text` | the fixed line you wrote - an 8pm "How was your day?" |
| `recap` | your text is a **prompt**; the agent writes the message from your record when it sends. No prompt → a recap of the day and one thing to do tomorrow |

```bash
agentqs notifications add --channel email --target you@example.com --at 20:00 --text "How was your day?"
agentqs notifications add --channel email --target you@example.com --at 21:00 --recap
agentqs notifications test <id>       # "Send now"
```

**Once a day, and it means it.** Each row remembers the last day it sent
(`lastSentDay`, in the record's timezone), and the scheduler skips a row that has
already gone out today - a restart or a second sweep never sends it twice. Change the
time or the destination and it re-arms for today.

**Send now does not consume the day.** Testing a notification at 3pm still leaves the
8pm one to go out. A failed send is written on the row (`lastError`) with the real
reason, and one bad row never stops the others.

---

## Password reset

**Forgot password?** on the sign-in page mails you a link. It goes to your username
when that is an email address, otherwise to the mailbox agentqs sends from.

- **Single-use.** The token is cleared in the same write that changes the password; the second try is refused.
- **30 minutes**, then it expires. One request a minute, so the page cannot be used to flood your inbox.
- **It signs everyone out.** Completing a reset rotates the session secret, so every session minted before it is dead - including one somebody else holds. (If you pin `SESSION_SECRET` in the environment, rotating it is yours to do.)
- Only a hash of the token is stored, so reading `config.json` never yields a usable link.
- Opening the link does not use it up, a wrong token does not burn the real one, and neither does a too-short password.
- Behind a proxy, set `AGENTQS_PUBLIC_URL` - the link is built from it, so a forged `Host` header cannot point your reset email at someone else's server.

With no email set up, the request says so instead of pretending to send:

```
Password reset needs email, and no SMTP or Gmail account is set up. Add one in Settings → Channels → Email, or reset from the machine with: agentqs password --set
```

`agentqs password --set` is the offline way back in. Whoever can run the CLI already
owns the data directory, so it asks for no token: a hidden prompt (or stdin), the
same session rotation, and any pending link dies.

---

## Proving it

The deterministic proofs need no network and no account - each drives the production
code against loopback stubs in a temp data directory:

```bash
npm run mail:test       # the SMTP client on the wire: STARTTLS, 465, AUTH, quoted-printable, the no-TLS refusal
npm run email:test      # the email channel: the aqs# footer, the Gmail reply poll, the quoted-text cut
npm run notify:test     # text + recap, the once-a-day guard, "Send now"
npm run password:test   # the reset loop, single-use, expiry, the throttle, `agentqs password --set`
```

`mail:live` is their complement: the same production path against **your own real
server**, with every delivered message read back over IMAP.

```bash
export AGENTQS_LIVE_SMTP_HOST=smtp.gmail.com
export AGENTQS_LIVE_SMTP_PORT=587
export AGENTQS_LIVE_SMTP_USER=you@gmail.com
export AGENTQS_LIVE_SMTP_PASS='<app password>'
export AGENTQS_LIVE_IMAP_HOST=imap.gmail.com   # optional, this is the default; host:port also works
npm run mail:live
```

It checks that an awkward body survives **byte for byte** (a line wrap landing on a
space, a line that is only `.`, accents, emoji), that a non-ASCII subject decodes,
that a notification arrives with its footer, that the reset token the server
*actually delivered* works once and only once, and that a wrong password fails with
the server's own reason.

It is **self-send only** - every message goes to `AGENTQS_LIVE_SMTP_USER` itself, so
it never mails a third party - and it holds no credential: with any of the four unset
it prints how to set them and exits 0, so an unconfigured machine never fails the
suite. IMAP signs in with the same username and password (true for a Gmail app
password; IMAP must be on for the account). Expect four short messages in your inbox
per run. A server accepting a message is not the message being delivered, so the
test polls for each one, for up to 90 seconds, instead of fetching once.
