import sys
from pathlib import Path

# The backend is not an installed package; make `import app` work under plain `uv run pytest`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
