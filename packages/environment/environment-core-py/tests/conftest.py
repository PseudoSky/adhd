"""pytest bootstrap: make the ``src``-layout package importable without an
editable/site-packages install.

The package has zero runtime dependencies (pure stdlib), so this lets
``cd packages/environment/environment-core-py && python -m pytest tests/``
succeed under *any* Python 3.10+ interpreter on ``PATH`` -- ambient system
Python or a pinned uv venv alike -- matching how the sibling
``runtime-py.3`` audit check imports the package via a plain
``sys.path.insert(0, ".../src")`` rather than requiring installation
(see ``docs/plan/adhd-environment/scripts/audit_checks.js``).
"""

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
