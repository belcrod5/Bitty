# Secure local Runner transport

LAN routing must authenticate the Mac before transmitting a Runner token. A
successful plaintext `/health` response cannot establish that identity. Removing
its Authorization header alone would still let an impostor select the LAN route
and receive subsequent authenticated requests.

The Runner keeps HTTP on loopback for Cloudflare Tunnel and local CLIs. A second
listener serves the same request handler and WebSocket handlers over TLS. macOS
generates an ECDSA private CA and a hostname-bound server certificate in the
ignored, private `private_runner/logs/local-tls` directory. The CA stays stable;
the server certificate can renew without re-pairing. The QR contains the local
HTTPS origin and public CA DER, never the CA or server private key.

Bitty trusts this CA only for the paired hostname and port, using Apple's SSL
policy and normal certificate validity checks. It does not install an OS root,
accept arbitrary certificates, or learn trust from the remote network. The app
waits for native trust configuration before enabling local routing. Previously
saved HTTP LAN URLs cannot be used by foreground bootstrap or background
approval handlers; old QR payloads still pair the secure Cloudflare endpoint.

`BittyRunnerTLS` is the common native trust boundary. Its HTTP protocol attaches
through React Native's existing URLSession configuration hook, covering fetch and
image loading. Local WebSockets use URLSession rather than SocketRocket's legacy
pinning API. Native STT, TTS effects and push approval sessions use the same
policy. Requests to other origins retain normal OS trust. Local transport never
forwards credentials across redirects or attaches Cloudflare service credentials.

AVFoundation does not apply ordinary URLSession trust delegates to its own HTTPS
media requests. The existing ExpoAV asset factory therefore gives paired media a
custom scheme and installs a native incremental Range loader that uses the same
TLS policy. Authenticated Cloudflare media uses this same loader with its
original HTTPS hostname and port fixed for the asset; it retains normal OS trust
and refuses redirects, so service-token headers cannot follow a different origin.
The common TTS playback entry supplies origin-scoped Access headers to both the
standard player and themed native downloader. This preserves streaming and cancellation instead of downloading an
entire video before playback. The small ExpoAV patch is applied by the existing
patch-package workflow. Native interfaces are separated by their current
responsibilities; no screen-specific HTTP or certificate wrappers are added.

## Validation

Run `python3 expo/tests/runner-tls-native/run.py` on macOS. It compiles the
production native code and exercises temporary TLS peers and media resources.
Checks cover certificate and hostname mismatch, expiry, exact port binding,
redirect rejection, zero HTTP requests to rejected peers, Cloudflare credential
isolation, text and binary WebSockets, large frames, cancellation, real AVAsset
metadata, concurrent nonzero ranges, malformed responses and active stream abort.
Temporary CA files are removed; no real Runner or OS trust store is modified.

The Runner's Node tests cover CA persistence/permissions, server certificate
renewal, actual HTTPS and WebSocket handlers, QR output and encrypted media URL
generation. Client tests cover pairing, legacy migration, trust readiness,
route selection, WebSocket events and background approval routing.

The remaining manual check is an iPhone build and re-pairing with the new QR:
home Wi-Fi must select Local and support chat, audio, media and push approvals;
an external network must select Cloudflare. Simulator SDK compilation and macOS
native tests do not establish real-device networking behavior or large-video
AVPlayer playback and seek performance. Existing background approval network
failures still use the notification fallback; no retry policy is introduced.

TTS transport diagnostics are persisted through the existing `tts_trace` client
log pipeline. They include the installed build stamp, actual source origin,
credential-presence flags, HTTP status, allowlisted MIME, numeric byte ranges and
native error domain/code chains. Userinfo, URL queries, opaque media identifiers,
credential values and free-form error descriptions are omitted. A once-per-mount
ready event confirms logging is active. Native notifications are delivered
asynchronously so recording an error does not block media loading.
