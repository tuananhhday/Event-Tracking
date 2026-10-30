"""Build an offline Windows x64 CDP bundle from verified official Node binaries.

Run npm ci --ignore-scripts --no-audit --no-fund first, then:
python3 scripts/build-portable.py NODE_ZIP SHASUMS256 OUTPUT_ZIP
"""
import hashlib
import pathlib
import subprocess
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
node_zip, checksums, output = map(pathlib.Path, sys.argv[1:])
version = "24.19.0"
archive = f"node-v{version}-win-x64.zip"
assert node_zip.name == archive, "Unexpected Node runtime version"
expected = next(line.split()[0] for line in checksums.read_text().splitlines()
                if line.split()[-1] == archive)
assert hashlib.sha256(node_zip.read_bytes()).hexdigest() == expected, "Node checksum mismatch"
assert (root / "node_modules/exceljs/package.json").exists(), "Run npm ci first"
assert not list((root / "node_modules").rglob("*.node")), "Native modules require a Windows build"

prefix = "EventQA-Windows-x64/"
launcher = '''@echo off
setlocal
cd /d "%~dp0"
title EventQA Portable - Choose mode
if not exist "runtime\\node.exe" (
  echo Missing runtime\\node.exe. Extract the entire ZIP first.
  pause
  exit /b 1
)
"runtime\\node.exe" --version
if errorlevel 1 (
  echo Node could not run. Ask company IT to approve this portable runtime.
  pause
  exit /b 1
)
"runtime\\node.exe" --env-file-if-exists=.env src\\cli.mjs hub --open
if errorlevel 1 pause
'''
stopper = '''@echo off
setlocal
cd /d "%~dp0"
"runtime\\node.exe" scripts\\stop-apps.mjs
pause
'''
readme = '''EventQA portable - Windows 64-bit

1. Extract the ENTIRE ZIP to a writable folder (for example Documents\\EventQA).
2. Open START_PORTABLE.cmd. Do not run it from inside the ZIP viewer.
3. Keep the command window open. A web page opens with three mode choices.
4. Select Chrome or Edge already installed on your computer.
5. End/export the session before closing. Use STOP_PORTABLE.cmd to stop safely.

No Node installation, npm command, admin rights or package download is needed.
Includes official Node.js 24.19.0 Windows x64 and locked JavaScript dependencies.
Requires an existing Chrome/Edge and permission to execute node.exe and CMD.
Company application-control and browser debugging policies still apply. If
execution is blocked, ask IT to approve it; this package does not bypass policy.
External websites still need normal company network access.

CDP runs immediately. AI features need your own OpenRouter credentials.
Proxy needs Python/mitmproxy separately; neither is bundled. The mode selector
explains these requirements. Session data and reports stay in runs/ locally.
Choose your XLSX file in step 2 and select a sheet (for example R1511).
The specification tab shows exact event names, descriptions and payload samples
beside real evidence. AppOTA sample shapes may differ from website events.

The default Events view is Activity / JSON: one row per observed event.
Open a row to see, copy or download event/default_parameters/custom_parameters.
The Raw Payload tab retains original captured field names. Missing mobile app
attributes are never filled from the workbook. Sensitive fields are masked.
For a website that cannot be operated with queue capture, end the session,
enable request-only capture in CDP, then open a new session. This does not
inject JavaScript queue hooks; queue checks are REVIEW, not a false missing event.
Do not commit runs/, profiles/, imports/ or credentials to GitHub.

Built on Linux; Windows execution has not been validated on a Windows machine.
The application CDP smoke test and report exports were validated on Linux.
Node's runtime license is in runtime/LICENSE.txt. Dependency licenses remain
in node_modules. Source files are included for inspection.
'''
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as target:
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
    for name in tracked:
        if not name or not (name.startswith(("src/", "examples/", "docs/"))
                            or name in {"package.json", "package-lock.json", "README.md", "scripts/stop-apps.mjs"}):
            continue
        target.write(root / name, prefix + name)
    for file in sorted((root / "node_modules").rglob("*")):
        if file.is_file():
            target.write(file, prefix + file.relative_to(root).as_posix())
    with zipfile.ZipFile(node_zip) as runtime:
        for source, dest in [("node.exe", "node.exe"), ("LICENSE", "LICENSE.txt")]:
            target.writestr(prefix + "runtime/" + dest,
                            runtime.read(f"node-v{version}-win-x64/{source}"))
    for name, content in [("START_PORTABLE.cmd", launcher), ("STOP_PORTABLE.cmd", stopper),
                          ("READ_ME_FIRST.txt", readme)]:
        target.writestr(prefix + name, content.replace("\n", "\r\n"))
    target.writestr(prefix + "runtime/SHASUMS256.txt", checksums.read_bytes())
with zipfile.ZipFile(output) as built:
    assert built.testzip() is None
print(f"Built {output}: {output.stat().st_size:,} bytes")
print("SHA256:", hashlib.sha256(output.read_bytes()).hexdigest())
