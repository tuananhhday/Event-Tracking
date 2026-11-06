"""Build the Windows click-to-run ZIP using a checksum-verified Node runtime.

Usage: python3 scripts/build-portable.py NODE_ZIP SHASUMS256 OUTPUT_ZIP [CATALOGUE_DIR]
Dependencies must already be installed using the repository lockfile.
Build compact dependencies first and set EVENTQA_PACKAGED_DEPS to their directory.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import zipfile
from portable_archive import check_archive

root = pathlib.Path(__file__).resolve().parent.parent
if len(sys.argv) not in (4, 5):
    raise SystemExit(__doc__)
node_zip, checksums, output = map(pathlib.Path, sys.argv[1:4])
catalogue = pathlib.Path(sys.argv[4]) if len(sys.argv) == 5 else None
version = "24.19.0"
archive_name = f"node-v{version}-win-x64.zip"
if node_zip.name != archive_name:
    raise SystemExit("Unexpected Node runtime version")
matches = [line.split()[0] for line in checksums.read_text().splitlines()
           if line.split()[-1] == archive_name]
if len(matches) != 1 or hashlib.sha256(node_zip.read_bytes()).hexdigest() != matches[0]:
    raise SystemExit("Node runtime checksum mismatch")
for name in ("exceljs", "ajv", "json5", "jszip", "playwright-core"):
    if not (root / "node_modules" / name / "package.json").is_file():
        raise SystemExit("Install the locked dependencies before building")
if list((root / "node_modules").rglob("*.node")):
    raise SystemExit("Native modules require a Windows-specific dependency build")
compact_path = os.environ.get("EVENTQA_PACKAGED_DEPS")
if not compact_path:
    raise SystemExit("Build compact dependencies with bundle-portable-deps.mjs, then set EVENTQA_PACKAGED_DEPS.")
dependency_root = pathlib.Path(compact_path).resolve()
try:
    dependency_manifest = json.loads((dependency_root / "eventqa-deps.json").read_text())
except (OSError, ValueError) as error:
    raise SystemExit("Missing compact dependency manifest; rebuild portable dependencies.") from error
if dependency_manifest.get("schema_version") != 1 or dependency_manifest.get("lockfile_sha256") != hashlib.sha256((root / "package-lock.json").read_bytes()).hexdigest():
    raise SystemExit("Compact dependencies are out of date; rebuild them using the current lockfile.")
for name in ("exceljs", "ajv", "json5", "jszip", "playwright-core"):
    if not (dependency_root / name / "package.json").is_file():
        raise SystemExit(f"Missing compact dependency: {name}")
if list(dependency_root.rglob("*.node")):
    raise SystemExit("Native modules require a Windows-specific dependency build")

commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no", "--", ".",
                            ":(exclude)portable/EventQA-Windows-x64.zip",
                            ":(exclude)portable/EventQA-Windows-x64.zip.sha256"], cwd=root, text=True).strip():
    commit += " + thay doi chua commit"
tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
prefix = "EventQA/"
runtime_scripts = {"scripts/run-eventqa.cmd", "scripts/choose-mode.cmd", "scripts/start-ai.mjs", "scripts/stop-apps.mjs"}
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as target:
    # Explicit source selection prevents recursive ZIPs and local credentials/data.
    for name in tracked:
        if not name or not (name.startswith(("src/", "docs/", "examples/", "solutions/")) or name in runtime_scripts
                            or name in {"package.json", "package-lock.json", "README.md", "PORTABLE_WINDOWS.md", ".env.example"}
                            or "/" not in name and name.endswith(".cmd")):
            continue
        content = (root / name).read_bytes()
        if name == "package.json":
            metadata = json.loads(content)
            metadata["scripts"] = {key: value for key, value in metadata["scripts"].items() if key in {"start", "cdp", "ai", "demo"}}
            content = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        if name.endswith(".cmd"):
            content = content.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        target.writestr(prefix + name, content)
    for file in sorted(dependency_root.rglob("*")):
        relative = "node_modules/" + file.relative_to(dependency_root).as_posix()
        # POSIX CLI symlinks are unnecessary: the launcher calls node.exe directly.
        if "/.bin/" in relative or not file.is_file():
            continue
        if file.is_symlink():
            raise SystemExit(f"Unexpected dependency symlink: {relative}")
        target.write(file, prefix + relative)
    with zipfile.ZipFile(node_zip) as runtime:
        for name in ("node.exe", "LICENSE", "README.md"):
            content = runtime.read(f"node-v{version}-win-x64/{name}")
            if name == "node.exe" and content[:2] != b"MZ":
                raise SystemExit("Invalid Windows executable")
            target.writestr(prefix + "runtime/" + name, content)
    target.writestr(prefix + "runtime/SHASUMS256.txt", checksums.read_bytes())
    target.writestr(prefix + "runtime/SOURCE.json", json.dumps({
        "version": version, "platform": "win-x64", "sha256": matches[0],
        "url": f"https://nodejs.org/dist/v{version}/{archive_name}", "source_commit": commit,
        "dependencies": {"format": "bundled-js", "lockfile_sha256": dependency_manifest["lockfile_sha256"],
                         "esbuild": dependency_manifest.get("esbuild")},
    }, indent=2))
    if catalogue:
        definitions = json.loads((catalogue / "event-catalogue.json").read_text())
        # Import as reference drafts; bundling must never approve native SDK rules.
        for case in definitions["cases"]:
            case["needs_review"] = True
            for rule in case["rules"]:
                rule["needs_review"] = True
        target.writestr(prefix + "imports/reviewed-cases.json",
                        json.dumps(definitions, ensure_ascii=False, indent=2))
        for name in ("event-catalogue.json", "event-catalogue.xlsx"):
            target.write(catalogue / name, prefix + "event-catalogue/" + name)
    target.writestr(prefix + "DOC_TRUOC_KHI_CHAY.txt", (
        "BAN WINDOWS X64 - GIAI NEN ROI BAM CHAY\n\n"
        "1. Giai nen TOAN BO ZIP vao thu muc ngan, vi du C:\\EventQA.\n"
        "2. Bam dup CHAY_EVENT_QA.cmd (ban thuong) hoac CHAY_EVENT_QA_AI.cmd (ban AI).\n"
        "3. Giao dien tu mo trong trinh duyet. Giu cua so lenh dang chay.\n"
        "4. Dung STOP_EVENT_QA.cmd de dung ung dung.\n\n"
        "Khong can cai Node.js hay go lenh npm. Can Chrome hoac Edge tren may.\n"
        "Thu vien da duoc gop gon; khong can tai hay giai nen node_modules rieng.\n"
        "Danh muc event JSON/Excel nam trong event-catalogue neu duoc dong kem.\n"
        "Mau App SDK can xac nhan mapping sang Web; khong tu dien tham so thieu.\n"
        "Ban AI: lan dau mo tab Tro ly AI, dan key OpenRouter (openrouter.ai -> Keys) roi bam Bat AI.\n"
        "Dong goi khong dong nghia da chay thu tren Windows; xem ket qua kiem thu kem ban phat hanh.\n"
        f"Source commit: {commit}\n"
    ).replace("\n", "\r\n"))

with zipfile.ZipFile(output) as built:
    for name in ("CHAY_EVENT_QA.cmd", "CHAY_EVENT_QA_AI.cmd", ".env.example", "scripts/run-eventqa.cmd", "runtime/node.exe",
                 "runtime/LICENSE", "node_modules/exceljs/package.json"):
        if prefix + name not in built.namelist():
            raise SystemExit(f"Missing required packaged file: {name}")
checks = check_archive(output)
print(f"Windows extraction checks passed: {checks['files']} files; longest path {checks['longest_path']} characters")
print(f"Built {output}: {output.stat().st_size:,} bytes")
print("SHA256:", hashlib.sha256(output.read_bytes()).hexdigest())
