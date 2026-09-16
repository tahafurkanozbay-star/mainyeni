from pathlib import Path
import re

path = Path("Webclient.app/src/Components/App/MapAna.js")
text = path.read_text()
updated = re.sub(r'^import \{ Constants_ServiceResultType \}.*\n', '', text, flags=re.M)
if updated == text:
    raise SystemExit("Expected unused Constants_ServiceResultType import was not found")
path.write_text(updated)
