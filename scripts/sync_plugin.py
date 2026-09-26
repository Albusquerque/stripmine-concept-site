from pathlib import Path
from shutil import copy2


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / "StripMine"

copies = (
    (SOURCE / "dist" / "index.js", ROOT / "dist" / "index.js"),
    (SOURCE / ".preview" / "plugin-harness.js", ROOT / "demo" / "plugin-harness.js"),
    (SOURCE / "assets" / "stripmine-logo.png", ROOT / "assets" / "stripmine-logo.png"),
)

for source, destination in copies:
    if not source.is_file():
        raise SystemExit(f"Missing source: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    copy2(source, destination)
    print(f"Synced {source.relative_to(ROOT.parent)} -> {destination.relative_to(ROOT)}")
