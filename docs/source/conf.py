from __future__ import annotations

from datetime import date
import os
from pathlib import Path

project = "SolarisEngine"
author = "SolarisEngine contributors"
copyright = f"{date.today().year}, {author}"

extensions = [
    "myst_parser",
    "sphinx_js",

]

# sphinx-js configuration (https://pypi.org/project/sphinx-js/)
#
#
# sphinx-js scans `js_source_path` entries non-recursively, so we list each
# directory to document. Paths in directives are relative to root_for_relative_js_paths.
js_source_path = [
    "../../controller",
    "../../controller/episode-handlers",
    "../../controller/episode-handlers/eval",
    "../../controller/primitives",
]
root_for_relative_js_paths = "../../controller"

# Keep this list small to avoid extra dependencies in the conda env.
myst_enable_extensions = [
    "deflist",
    "tasklist",
]
myst_heading_anchors = 3


# The README pages include links to repo files/folders (not Sphinx pages).
# Silence those warnings to keep builds clean.
suppress_warnings = ["myst.xref_missing"]

templates_path = ["_templates"]
exclude_patterns = ["_build", "build", "Thumbs.db", ".DS_Store"]

html_theme = "furo"
html_static_path = ["_static"]
html_title = project

# Support both Markdown and reStructuredText sources.
source_suffix = {
    ".rst": "restructuredtext",
    ".md": "markdown",
}
