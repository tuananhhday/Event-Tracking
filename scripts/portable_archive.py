"""Check ZIP names against Windows extraction limits before publishing a build."""
import re
import stat
import zipfile

# Leave room for Downloads, a user name and the folders created by Extract All.
MAX_MEMBER_UNITS = 120
RESERVED = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}


def check_member(name, seen):
    if not name or name.startswith("/") or "\\" in name:
        raise ValueError(f"Unsafe archive path: {name!r}")
    if len(name.encode("utf-16-le")) // 2 > MAX_MEMBER_UNITS:
        raise ValueError(f"Archive path is too long for Windows: {name}")
    for part in name.rstrip("/").split("/"):
        stem = part.split(".")[0].upper()
        if (part in ("", ".", "..") or part.endswith((" ", "."))
                or re.search(r'[<>:"|?*\x00-\x1f]', part)
                or stem in RESERVED or re.fullmatch(r"(?:COM|LPT)[1-9¹²³]", stem)):
            raise ValueError(f"Invalid Windows filename: {name}")
    key = name.rstrip("/").casefold()
    if key in seen:
        raise ValueError(f"Duplicate Windows path: {name}")
    seen.add(key)


def check_archive(archive):
    seen = set()
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None:
            raise ValueError("Corrupt output archive")
        for member in bundle.infolist():
            check_member(member.filename, seen)
            if stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError(f"Symlinks are not supported in the Windows ZIP: {member.filename}")
        return {"files": sum(not member.is_dir() for member in bundle.infolist()),
                "longest_path": max((len(name.encode("utf-16-le")) // 2 for name in bundle.namelist()), default=0)}


if __name__ == "__main__":
    import json
    import sys
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/portable_archive.py ARCHIVE.zip")
    print(json.dumps(check_archive(sys.argv[1])))
