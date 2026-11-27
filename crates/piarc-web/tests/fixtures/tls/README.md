# Test TLS fixtures

`ca.pem` is a test certificate authority and `server.pem` / `server.key` a server certificate it
signed for `models.test`, `cdn.models.test` and `other.test`, valid until 2126. They exist only
for `tests/download.rs`, which trusts `ca.pem` explicitly; nothing in PiArc trusts them, and the
key protects nothing. Regenerate with `openssl req -x509 -sha256` (CA, named curve P-256) and
`openssl x509 -req -sha256` with those subject alternative names; rustls rejects SHA-1
signatures and explicit curve parameters.
