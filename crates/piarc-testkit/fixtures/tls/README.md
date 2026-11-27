# Test TLS fixtures (testkit)

`ca.test.crt` is a test certificate authority; `server.test.crt` and `server.test.key` are a
server certificate it signed for `registry.npmjs.test`, `localhost` and `127.0.0.1`, valid until
2126 (P-256, SHA-256). They exist only for the mock npm registry (`src/npm_registry.rs`,
ADR-0102): Core trusts `ca.test.crt` only through the development build's
`PIARC_TEST_MARKET_CA`, npm through `NODE_EXTRA_CA_CERTS` in tests. Nothing in a release build
trusts them, the CA key was discarded after signing, and the server key protects nothing.

Regenerate with `openssl ecparam -name prime256v1`, `openssl req -x509 -sha256` (the CA, with
`basicConstraints=critical,CA:TRUE`) and `openssl x509 -req -sha256` with those subject
alternative names; rustls rejects SHA-1 signatures and explicit curve parameters.
