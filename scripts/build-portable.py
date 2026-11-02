"""Build the Windows click-to-run ZIP using a checksum-verified Node runtime.

Usage: python3 scripts/build-portable.py NODE_ZIP SHASUMS256 OUTPUT_ZIP [CATALOGUE_DIR]
Dependencies must already be installed using the repository lockfile.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import zipfile

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
for name in ("exceljs", "ajv", "json5"):
    if not (root / "node_modules" / name / "package.json").is_file():
        raise SystemExit("Install the locked dependencies before building")
if list((root / "node_modules").rglob("*.node")):
    raise SystemExit("Native modules require a Windows-specific dependency build")

commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root, text=True).strip():
    commit += " + thay doi chua commit"
tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
prefix = "EventQA-Windows-x64/"
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as target:
    # Explicit source selection prevents recursive ZIPs and local credentials/data.
    for name in tracked:
        if not name or not (name.startswith(("src/", "scripts/", "docs/", "examples/", "solutions/"))
                            or name in {"package.json", "package-lock.json", "README.md", "PORTABLE_WINDOWS.md", ".env.example"}
                            or "/" not in name and name.endswith(".cmd")):
            continue
        content = (root / name).read_bytes()
        if name.endswith(".cmd"):
            content = content.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        target.writestr(prefix + name, content)
    dependency_root = pathlib.Path(os.environ.get("EVENTQA_PACKAGED_DEPS", root / "node_modules")).resolve()
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
        "1. Giai nen TOAN BO ZIP ra thu muc co quyen ghi.\n"
        "2. Bam dup CHAY_EVENT_QA.cmd (ban thuong) hoac CHAY_EVENT_QA_AI.cmd (ban AI).\n"
        "3. Giao dien tu mo trong trinh duyet. Giu cua so lenh dang chay.\n"
        "4. Dung STOP_EVENT_QA.cmd de dung ung dung.\n\n"
        "Khong can cai Node.js hay go lenh npm. Can Chrome hoac Edge tren may.\n"
        "Danh muc event JSON/Excel nam trong event-catalogue neu duoc dong kem.\n"
        "Mau App SDK can xac nhan mapping sang Web; khong tu dien tham so thieu.\n"
        "Ban AI: lan dau mo tab Tro ly AI, dan key OpenRouter (openrouter.ai -> Keys) roi bam Bat AI.\n"
        "Goi da duoc chay thu tren Windows 11: ca ban thuong va ban AI.\n"
        f"Source commit: {commit}\n"
    ).replace("\n", "\r\n"))

with zipfile.ZipFile(output) as built:
    if built.testzip() is not None:
        raise SystemExit("Corrupt output archive")
    for name in ("CHAY_EVENT_QA.cmd", "CHAY_EVENT_QA_AI.cmd", ".env.example", "scripts/run-eventqa.cmd", "runtime/node.exe",
                 "runtime/LICENSE", "node_modules/exceljs/package.json"):
        if prefix + name not in built.namelist():
            raise SystemExit(f"Missing required packaged file: {name}")
print(f"Built {output}: {output.stat().st_size:,} bytes")
print("SHA256:", hashlib.sha256(output.read_bytes()).hexdigest())
