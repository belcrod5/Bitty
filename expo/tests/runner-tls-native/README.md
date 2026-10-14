# Native Runner TLS regression checks

Run on macOS with Xcode command line tools, Node and OpenSSL:

```sh
python3 expo/tests/runner-tls-native/run.py
python3 expo/tests/runner-tls-native/check-tts-bridge.py
```

The harness compiles the production TLS policy, HTTP protocol, streaming media
loader and installed Markdown image downloader. The image fixture supplies only
the rendering cache and RN platform aliases; TLS and image decoding run unchanged. It creates temporary CAs and HTTPS listeners, overrides only the test
process's configuration-file location, and deletes all temporary keys afterward.
It neither installs an OS certificate nor contacts or restarts a real Runner.

Image checks cover both default and authenticated sessions, startup hook registration,
paired TLS image decoding, rejected CA/hostname/port/expiry/redirects, clearing pairing,
and retained timeout and cache policy. App startup registers the image configuration
hook before any image downloader session is created.

Checks cover QR anchor trust, mismatched CA/hostname, expired leaf, exact port
binding, redirects, Cloudflare header isolation, default OS trust after clearing
pairing, text/binary WebSocket messages (including a frame larger than one MiB)
and cancellation, and actual AVURLAsset loading through the incremental range
loader. Minimal AVFoundation request fixtures also exercise concurrent nonzero
ranges, exact bytes, malformed Content-Range rejection and an active cancellation
observed by the real HTTPS server.
An isolated Access-like gate also checks authenticated nonpaired media, missing
headers and zero requests to a redirected origin. This fixture first asserts
normal OS trust rejects its private CA, then substitutes only the test process's
challenge completion with the temporary issuer to exercise the transport. The
production trust policy remains unchanged; this is not a real Cloudflare test.
The two-second MP4 fixture was generated locally for this test.

The TTS bridge check requires installed iOS Pods. It compiles the installed React
Native type parser unchanged, reads the production exported `headers` declaration,
and checks its converter selector against the installed iPhone React framework
and header. It also reproduces the previous unsupported typed dictionary export.
It does not execute a JavaScript-to-native invocation on an iPhone.

These checks do not replace an iPhone application build and device validation of
the React Native HTTP configuration hook, WebSocket bridge, STT and background push,
or real AVPlayer playback and seeks with a large video.
