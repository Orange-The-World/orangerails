# ZKA Levels: spirit, definition, what we rejected, and roadmap

**Status:** current. **Scope:** the Orange Rails engine. Downstream apps built on it inherit these levels.

## How to read this

This document is the in-tree source of truth for how Orange Rails handles a user's private
data. It is written so that a person evaluating our privacy claim, and a contributor about
to touch the encrypted tables, come away with the same understanding.

Read the spirit first. The mechanics only make sense once you know what is being protected
and why the line is drawn where it is. **If you change anything in this area, update this
document in the same pull request.** Design reasoning that lives outside the repository
cannot be reviewed or audited, so it belongs here.

## The spirit: why any of this exists

Orange Rails rests on one promise: **your financial data is yours, and we hold as little of
it, for as short a time, as the product allows.** Where we can be mathematically incapable
of reading your data, we are, and we say so. Where we cannot, we say that too, in the same
words, in this file. A claim a reader can check against this repository is worth more than
a claim that sounds absolute and falls apart on first reading of the source.

That means the promise is stated as a capability, and it differs by path:

* **Bitcoin and stealth paths: we are incapable of reading your data.** The key that opens
  the sealed payload is derived on the user's device and never reaches us. The server holds
  sealed bytes and no way to open them. This is zero knowledge in the strict sense.

* **Bank and provider paths: session-scoped key custody, never at rest.** To pull data from
  a bank we must present the bank a credential, so something must be able to open the stored
  credential. Today the caller sends the key that opens it (`credentials_key`) in the sync
  request. The sync function imports it, decrypts `connections.encrypted_credentials`, calls
  the provider, and the key dies with the request. It is never persisted, never written to a
  column, and never logged. But for the life of that request the server can read the
  credential, and while it seals each fetched transaction it necessarily handles that
  transaction in memory. **This is not zero knowledge, and we do not call it that.** It is
  bounded custody, named openly, with the exits tracked below.

Our users self-custody their Bitcoin. They already decline to trust a company with their
keys, and we are asking them to apply the same discipline to their financial data. That
discipline is only worth anything if we hold ourselves to it out loud, including where we
currently fall short of it.

The design goal that follows: **the server should not be able to assemble a financial
profile of a user, even given full database access.** Amounts, balances, addresses,
counterparties, and memos are sealed everywhere the server can reach them at rest.

## The one principle that does not bend

**Content confidentiality at rest applies at every level we ship.** Nothing the server
stores contains readable financial content, on any path. The levels are not about how much
of your money data the server can see in the database. The levels describe only how much
*metadata residue*, meaning the shape and timing around the sealed content and never the
content itself, we accept in exchange for the product being usable.

Two boundaries on that sentence, stated so nobody reads more into it than it says:

* **At rest, not in flight.** On the bank path the server is the thing that fetches from the
  provider and seals the result, so provider plaintext passes through server memory during a
  sync request. The ladder below describes storage, not transit.
* **The levels negotiate metadata, not content.** Content is sealed at every level. A level
  never trades content confidentiality for convenience.

## The compromise, in plain English

Total zero knowledge sounds like the obvious goal until you run it against a real database.
If every column is sealed, the server cannot filter anything. To answer "show me last
month's transactions" it must hand the browser the user's entire encrypted history, every
row ever written, and the browser must download and decrypt all of it before discarding
everything outside the requested month. For a user with thousands of transactions that is
slow enough to feel broken, and it degrades every month they keep using us.

So we made one deliberate, narrow trade. The server keeps the **transaction date in
plaintext** so it can filter with an ordinary indexed query and return only the rows that
were asked for. A date carries no amount and no counterparty, so on its own it is low
signal. That single concession is what keeps a large history usable.

Beyond that, a small number of fields must be plaintext for the database to function at
all: to know which user owns a row, to prevent the same transaction being stored twice, and
to confirm a stored value is well formed. You can validate a plaintext status or a version
number. You cannot validate an encrypted amount.

Sealed content plus that thin, justified layer of functional plaintext is what we call
**Level 2**. It is where we ship today, on purpose.

## The ladder (a higher number means more private)

**Level 1, maximal plaintext. The floor we reject.** The server reads both content and
metadata, at rest. This is the conventional aggregator model used by mainstream personal
finance apps. It is fast and straightforward, and it is not zero knowledge. We define it
only so the contrast is explicit. We do not offer it.

**Level 2, content sealed at rest with minimal functional plaintext. Ships today. Our
default.** Every piece of financial content is sealed in storage. The only plaintext is the
thin functional layer described above and itemized below. This is the deliberate compromise
that makes the product usable on a real database without exposing what a transaction was.

**Level 3, metadata concealed as well. The aspiration. Not built.** The residue goes away
too: no plaintext date, and no server-visible per-row count or timing. This is where a user
who wants maximum privacy should eventually be able to live without self-hosting. It is a
research problem rather than a build ticket, and the open question is at the end of this
document.

Note on numbering: a higher number always means more private. More plaintext is never a
higher level, because more plaintext is not more zero knowledge, it is server convenience.

**The ladder measures storage, not key custody.** A path can be at Level 2 and still have a
custodian in the sync loop. The Bitcoin path has none. The bank path does. Both store the
same way. Do not read a level as a statement about who can open the credential.

## Why each plaintext field exists

Every plaintext column on the encrypted tables falls into one of five buckets. Financial
content is never one of them. Each claim below is checkable against the migration cited.

1. **Integrity and access control.** `connection_id`, `app_user_id`: foreign keys,
   row-level-security scoping, and cascade delete. The database cannot relate or protect a
   row without them. (`encrypted_transactions` in
   `20260419120000_orangerails_hub_foundation.sql`; `stealth_transactions` in
   `20260504000000_stealth_sync.sql`.)

2. **Dedup identity.** The bank path uses `external_id`, plaintext, commented in source as
   the provider's transaction id and unavoidable for dedup, enforced by
   `UNIQUE (connection_id, external_id)`. The stealth path does better:
   `txid_blind_index_b64` is a keyed HMAC that lets the server dedup without learning the
   txid, and `blind_index_b64` does the same for xpubs. Where a client-held key exists we
   dedup with no plaintext leak. The bank path cannot, because there the engine holds the
   master key and has only the provider's id to match on. Blind indexing is the pattern for
   pushing plaintext down over time.

3. **Validation and crypto routing.** `connection_kind` and `status` are `CHECK` enums the
   database validates. `sealed_under`, `sealed_alg`, `opk_alg`, and `payload_key_version`
   record which key and algorithm sealed the row so that decryption routes correctly.
   Envelope headers `version`, `algorithm`, and `iv_b64` are required in order to decrypt at
   all, and the IV is non-secret by design. `opk_public` is a public key and is safe as
   plaintext.

4. **Query and resume function. This bucket is the actual Level 2 trade-off.**
   `occurred_at` is a plaintext date, indexed by
   `idx_encrypted_transactions_occurred_at` on `(connection_id, occurred_at DESC)`, and
   commented in source as plaintext for querying because a timestamp alone is low signal.
   `block_height`, `last_block_scanned`, `last_sync_at`, and `fetched_at` are resume cursors
   and operational timing. Buckets 1 through 3 are structural. This bucket is the choice.

5. **Per-app legacy concession.** `wallet_birthday_plaintext` is plaintext only for apps that
   already expose it. Newer surfaces keep the wallet birthday inside the sealed envelope.
   This is a rough edge to close, not a principle.

## What the server sees at Level 2

**At rest**, the server storing sealed rows sees: sealed bytes, an opaque `connection_id`
and `app_user_id`, a plaintext `occurred_at`, `last_sync_at`, `status`, and a txid blind
index. It does not hold the key that would open the sealed payload.

**During a bank sync request**, and only then, it additionally sees the credential it just
opened with the caller-supplied key, and the provider's response as it seals each row. When
the request ends, that is gone.

**During a Bitcoin or stealth sync**, none of the above applies. There is no key to supply
and nothing for the server to open.

The residue we concede at rest is that a connection had activity on a given day, and roughly
how many rows it holds. That is timing and volume, never content. We disclose this to users
in the same terms rather than hiding it. Anyone who will not accept that residue, or the
bank-path custody window, can self-host, in which case the server is their own machine.

## What we explored and rejected

Recorded so that these decisions are not relitigated without the reasoning.

* **Rejected: Level 1 as our model.** Server-readable content is the industry default. It is
  convenient and it is not zero knowledge. Rejecting it is the point of the company.

* **Rejected: server-held keys at rest.** No key that opens user content is persisted on our
  servers, derived from anything our servers hold, or recoverable from a database dump. This
  is the line that does not move, and it is the one we actually hold.

* **Accepted and named: session-scoped custody on the bank path.** Something must be able to
  open a bank credential in order to call a bank. Today the caller passes that key per
  request and it lives only in the memory of that request. We did not reject this design, we
  ship it, and calling it rejected in an earlier version of this document was simply wrong.
  Four exits were examined and none removes the custodian while background sync exists:

  1. **Client-driven sync.** The user's device decrypts locally, calls the provider, seals,
     and uploads ciphertext. Truly zero knowledge. Cost: no sync while the app is closed,
     and most providers block browser-origin calls and forbid shipping app secrets to a
     client. Viable only where a provider issues per-user credentials with permissive CORS.
  2. **Blind relay.** The client terminates TLS to the provider and our edge forwards opaque
     bytes. We see ciphertext only. Real, heavy, and still requires the client to be online.
  3. **Attested enclave.** The key lives only inside attested hardware the host cannot read.
     Background sync survives. This trades "trust us" for "trust the attestation and the
     silicon vendor." It is stronger. **It is not zero knowledge and must never be described
     as such.**
  4. **Provider tokenization or OAuth.** A revocable, scoped token replaces a raw credential.
     This shrinks the blast radius and is worth doing on its own merits. Custody is unchanged.

  The honest conclusion, until someone disproves it: **no design keeps background sync and
  removes custody without adding a hardware trust root.**

* **Rejected: sealing the transaction date at Level 2.** Sealing `occurred_at` would force
  the client to stream and decrypt a user's entire history to answer any date query. It does
  not scale and it makes the product feel broken. The date stays plaintext, with the residue
  named openly, until a Level 3 mechanism exists.

* **Rejected: numbering the plaintext-heavy option as the highest level.** An earlier
  framing gave the most-plaintext option the highest number. The ladder was reordered so
  that a higher number means more private.

* **Deferred, not rejected: padding and cover traffic.** Concealing row count and sync
  timing requires dummy rows and fixed-rate traffic. That is a substantial effort, scoped
  out of V1, and it belongs to the Level 3 research below rather than to a build ticket.

* **Kept as the escape hatch: self-hosting.** A user who will not accept even Level 2
  residue, or the bank-path custody window, can run Orange Rails themselves. This is why
  Level 2 is an honest default rather than a trap. There is always a door to full control.

## Roadmap

* **Today.** Level 2 is the default and the shipping reality for `encrypted_transactions`
  and `stealth_transactions`. The Bitcoin and stealth paths carry no key custodian. The bank
  path carries a session-scoped one.
* **Near term.** Close the Level 2 rough edges. Move `wallet_birthday_plaintext` inside the
  sealed envelope for every app. Push dedup onto blind indexes everywhere a client-held key
  exists, which shrinks plaintext at no feature cost.
* **Near term, custody.** Shrink the bank-path window rather than deny it exists. Prefer
  revocable scoped provider tokens over raw credentials. Move any provider that issues
  per-user credentials with permissive CORS onto client-driven sync, where the custodian
  disappears entirely.
* **Aspiration.** Level 3: remove the plaintext date and conceal count and timing, so the
  server holds sealed bytes and little else, without forcing self-hosting.
* **Always available.** Self-hosting.

## Open research questions

**1. Can we reach Level 3 without wrecking the product?** The hard part is the plaintext
date: the server must answer "this connection's rows between date A and date B" efficiently
without seeing the date. Candidate directions, none decided:

* **Client-side range and cursor logic**, with the timestamp sealed or coarsely bucketed.
  Month-level buckets leak considerably less than an exact date and may remain indexable.
  Likely the first and simplest step.

* **Zero-knowledge proofs.** Strong at proving a property, such as that a sealed row's date
  falls in a range, without revealing the value. An honest caveat: a proof establishes
  correctness, but it does not by itself give the server an efficient index to select on, so
  proofs likely pair with client-side range logic or an oblivious query layer rather than
  replacing them.

* **Private information retrieval, or oblivious query.** Lets the client fetch a range
  without the server learning which range. Strong privacy, with real performance and
  complexity cost.

* **Padding and cover traffic.** Closes the count and timing side channel. Heavy, and
  deferred from V1.

**2. Can background sync exist without a key custodian?** Something must open a credential
while the user is offline. Every known exit either removes background sync (client-driven,
blind relay) or moves the trust root into hardware (attested enclave). If a design exists
that does neither, we have not found it, and we would very much like to be shown it.

The bar for both questions: the answer must be real zero knowledge, not server convenience
with extra steps, and not a trust root relabelled.

## Change control

Any schema change that moves a table between levels requires maintainer approval and a
security review before it lands. Any change to who can open a key, on any path, requires the
same and is described in this document in the same pull request.
