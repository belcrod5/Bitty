#!/usr/bin/env python3
"""Compile production Apple TTS preparation and exercise local synthetic audio."""
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
TLS = HERE.parents[1] / "modules/bitty-runner-tls/ios/BittyRunnerTLS.h"
with tempfile.TemporaryDirectory(prefix="bitty-tts-audio-native-") as temporary:
    work = pathlib.Path(temporary)
    (work / "React").mkdir()
    (work / "BittyRunnerTLS").mkdir()
    (work / "BittyRunnerTLS/BittyRunnerTLS.h").write_text(TLS.read_text())
    (work / "React/RCTBridgeModule.h").write_text("""#import <Foundation/Foundation.h>
@protocol RCTBridgeModule <NSObject> @end
typedef void (^RCTPromiseResolveBlock)(id);
typedef void (^RCTPromiseRejectBlock)(NSString *, NSString *, NSError *);
#define RCT_EXPORT_MODULE(...)
#define RCT_REMAP_METHOD(name, ...) - (void)__VA_ARGS__
""")
    subprocess.run(["xcrun", "clang++", "-std=c++17", "-fobjc-arc", "-fblocks",
                    "-Wno-incomplete-implementation", "-Wno-nullability-completeness",
                    "-framework", "Foundation", "-framework", "AVFoundation", "-framework", "Security",
                    "-I", str(work), str(HERE / "Harness.mm"), "-o", str(work / "harness")], check=True)
    subprocess.run([str(work / "harness"), str(work), *sys.argv[1:]], check=True, timeout=90)
