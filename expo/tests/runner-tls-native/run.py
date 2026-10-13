#!/usr/bin/env python3
"""Exercise production Apple TLS and media code against isolated dummy servers."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / "modules/bitty-runner-tls/ios"
os.umask(0o077)

with tempfile.TemporaryDirectory(prefix="bitty-runner-tls-native-") as temporary:
    work = pathlib.Path(temporary)
    openssl = shutil.which("openssl")
    if not openssl:
        raise SystemExit("openssl is required")

    def certificate_command(*args):
        subprocess.run([openssl, *args], cwd=work, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    (work / "ca.cnf").write_text("""[req]
distinguished_name=dn
x509_extensions=ca
prompt=no
[dn]
CN=Temporary native test CA
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
""")
    (work / "leaf.ext").write_text("""subjectAltName=DNS:localhost
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
""")
    for prefix in ("", "rogue-"):
        certificate_command("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                            "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-sha256", "-days", "1",
                            "-config", "ca.cnf", "-keyout", prefix + "ca.key", "-out", prefix + "ca.pem")
        certificate_command("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                            "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-subj", "/CN=localhost",
                            "-keyout", prefix + "server.key", "-out", prefix + "server.csr")
        certificate_command("x509", "-req", "-in", prefix + "server.csr", "-CA", prefix + "ca.pem",
                            "-CAkey", prefix + "ca.key", "-CAcreateserial", "-days", "1", "-sha256",
                            "-extfile", "leaf.ext", "-out", prefix + "server.pem")
    certificate_command("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
                        "-CAcreateserial", "-days", "0", "-sha256", "-extfile", "leaf.ext", "-out", "expired.pem")
    certificate_command("x509", "-in", "ca.pem", "-outform", "DER", "-out", "ca.der")
    subprocess.run(["xcrun", "clang", "-fobjc-arc", "-fblocks", "-Wno-deprecated-declarations",
                    "-framework", "Foundation", "-framework", "Security", "-framework", "AVFoundation",
                    "-framework", "UniformTypeIdentifiers", "-framework", "CoreMedia", "-I", str(SOURCE),
                    str(HERE / "Harness.m"), str(SOURCE / "BittyRunnerTLS.m"),
                    str(SOURCE / "BittyRunnerMediaLoader.m"), str(SOURCE / "BittyRunnerSocket.m"),
                    "-o", str(work / "harness")], check=True)
    server = subprocess.Popen(["node", str(HERE / "server.cjs"), str(HERE / "test.mp4")],
                              cwd=work, stdout=subprocess.DEVNULL)
    shutil.copyfile(HERE / "test.mp4", work / "test.mp4")
    try:
        for _ in range(100):
            if (work / "ports.json").exists():
                break
            if server.poll() is not None:
                raise RuntimeError("Dummy server failed to start")
            time.sleep(0.02)
        subprocess.run([str(work / "harness"), str(work)], cwd=work, check=True, timeout=35)
    finally:
        server.terminate()
        server.wait(timeout=5)
    counts = json.loads((work / "counts.json").read_text())
    assert counts["rogue"] == 0, "Invalid CA or redirect leaked an HTTP request"
    assert counts["expired"] == 0, "Expired leaf received an HTTP request"
    assert counts["wrongName"] == 0, "Hostname mismatch leaked an HTTP request"
    assert counts["protocolSecrets"] == 0, "Cloudflare secrets reached the local protocol or media loader"
    assert counts["metadataRange"] > 0, "AVAsset metadata was not served through an actual two-byte Range request"
    assert counts["slowCancelled"] > 0, "Active media cancellation did not abort its HTTP stream"
    print("PASS: rejected TLS peers and redirected targets received zero HTTP requests")
