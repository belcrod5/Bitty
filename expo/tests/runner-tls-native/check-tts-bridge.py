#!/usr/bin/env python3
"""Check the real TTS export type against the installed RN parser/converters."""
import pathlib
import re
import shutil
import subprocess
import tempfile

EXPO = pathlib.Path(__file__).resolve().parents[2]
REACT = EXPO / "node_modules/react-native/React/Base"
FRAMEWORK = EXPO / "ios/Pods/React-Core-prebuilt/React.xcframework/ios-arm64/React.framework"
SOURCE = EXPO / "modules/bitty-tts-effects/ios/BittyTtsEffectsModule.mm"
export = SOURCE.read_text().split("RCT_REMAP_METHOD(process,", 1)[1].split("\n{", 1)[0]
header_type = re.search(r"headers:\(([^)]+)\)headers", export).group(1)

with tempfile.TemporaryDirectory(prefix="bitty-tts-bridge-") as temporary:
    work = pathlib.Path(temporary)
    (work / "React").mkdir()
    for name in ("RCTParserUtils.m", "RCTParserUtils.h"):
        shutil.copyfile(REACT / name, work / name)
    shutil.copyfile(REACT / "RCTDefines.h", work / "React/RCTDefines.h")
    # The actual parser's release branch does not call its UIKit-based logger.
    (work / "RCTLog.h").write_text("#define RCTLogError(...) ((void)0)\n")
    (work / "main.m").write_text("""#import "RCTParserUtils.h"
int main(int argc, const char **argv) {
  @autoreleasepool {
    for (int i = 1; i < argc; i++) {
      const char *type = argv[i];
      puts([[RCTParseType(&type) stringByAppendingString:@":"] UTF8String]);
    }
  }
  return 0;
}
""")
    subprocess.run(["xcrun", "clang", "-fobjc-arc", "-fblocks", "-DRCT_DEBUG=0",
                    "-framework", "Foundation", "-I", str(work),
                    str(work / "RCTParserUtils.m"), str(work / "main.m"),
                    "-o", str(work / "parser")], check=True)
    selectors = subprocess.check_output([str(work / "parser"), header_type,
                                        "NSDictionary<NSString *, NSString *> *"], text=True).splitlines()

binary_selectors = set(subprocess.check_output(["strings", str(FRAMEWORK / "React")], text=True).splitlines())
converter_header = (FRAMEWORK / "Headers/React_Core/RCTConvert.h").read_text()
current, old = selectors
assert old == "NSStringDictionary:" and old not in binary_selectors, "Old unsupported export was not reproduced"
assert current in binary_selectors, f"TTS export requires unavailable RN converter {current}"
assert re.search(r"\+\s*\([^)]*\)\s*" + re.escape(current) + r"\s*\(id\)", converter_header), "Converter is absent from the installed RN header"
print("PASS: actual TTS export selects installed NSDictionary converter; old typed export selects unavailable NSStringDictionary")
