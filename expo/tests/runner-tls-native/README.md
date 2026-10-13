# Native Runner TLS regression checks

Run on macOS with Xcode command line tools, Node and OpenSSL:

```sh
python3 expo/tests/runner-tls-native/run.py
```

The harness compiles the production TLS policy, HTTP protocol and streaming media
loader. It creates temporary CAs and HTTPS listeners, overrides only the test
process's configuration-file location, and deletes all temporary keys afterward.
It neither installs an OS certificate nor contacts or restarts a real Runner.

Checks cover QR anchor trust, mismatched CA/hostname, expired leaf, exact port
binding, redirects, Cloudflare header isolation, default OS trust after clearing
pairing, text/binary WebSocket messages (including a frame larger than one MiB)
and cancellation, and actual AVURLAsset loading through the incremental range
loader. Minimal AVFoundation request fixtures also exercise concurrent nonzero
ranges, exact bytes, malformed Content-Range rejection and an active cancellation
observed by the real HTTPS server.
The two-second MP4 fixture was generated locally for this test.

These checks do not replace an iPhone application build and device validation of
the React Native HTTP configuration hook, WebSocket bridge, STT and background push,
or real AVPlayer playback and seeks with a large video.
