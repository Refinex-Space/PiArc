# Test TLS fixtures

`ca.test.crt` is a test certificate authority; `server.test.crt` and `server.test.key` are a
server certificate it signed for `models.test`, `cdn.models.test` and `other.test`, valid until
2126. They exist only for `tests/download.rs`, which trusts `ca.test.crt` explicitly; nothing in
PiArc trusts them, and the key protects nothing.

The `.test.` names follow `scripts/release/test-keys/`: `*.pem` is ignored as a secret, and
these files are not secrets.

Regenerate with `openssl req -x509 -sha256` (the CA, named curve P-256) and
`openssl x509 -req -sha256` with those subject alternative names; rustls rejects SHA-1
signatures and explicit curve parameters.
