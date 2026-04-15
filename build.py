#!/usr/bin/env python3
"""
Concatenate the src/*.gs files into a single dist/MonteCarlo.gs bundle
that a user can paste into Google Apps Script in one shot.

Strips the trailing `if (typeof module !== 'undefined' && module.exports)`
blocks used only for Node-side testing.

Usage:
    python3 build.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(HERE, "src")
DIST_DIR = os.path.join(HERE, "dist")

# Order matters for readability (later files rely on earlier ones conceptually).
FILES = [
    "Distributions.gs",
    "FormulaLexer.gs",
    "FormulaParser.gs",
    "FormulaFunctions.gs",
    "FormulaEvaluator.gs",
    "DependencyGraph.gs",
    "Stats.gs",
    "Simulation.gs",
    "ModelReader.gs",
    "ResultsWriter.gs",
    "Main.gs",
]

MODULE_EXPORTS_RE = re.compile(
    r"if\s*\(\s*typeof\s+module\s*!==\s*'undefined'.*?\}\s*$",
    re.DOTALL | re.MULTILINE,
)


def strip_node_exports(src: str) -> str:
    """Remove the trailing `if (typeof module !== ...) { module.exports = ... }` block."""
    return MODULE_EXPORTS_RE.sub("", src).rstrip() + "\n"


def main() -> int:
    os.makedirs(DIST_DIR, exist_ok=True)
    out_path = os.path.join(DIST_DIR, "MonteCarlo.gs")

    chunks = [
        "/**\n"
        " * MonteCarlo.gs — bundled single-file build\n"
        " *\n"
        " * Paste this into Google Apps Script (Extensions → Apps Script) on\n"
        " * your sheet, save, then reload the sheet. A new \"Monte Carlo\"\n"
        " * menu will appear.\n"
        " *\n"
        " * Source files (in order) are separated by banners below.\n"
        " */\n"
    ]

    for name in FILES:
        path = os.path.join(SRC_DIR, name)
        if not os.path.exists(path):
            print(f"MISSING: {name}", file=sys.stderr)
            return 1
        with open(path, "r", encoding="utf-8") as fp:
            src = fp.read()
        stripped = strip_node_exports(src)
        banner = (
            "\n// =====================================================================\n"
            f"// {name}\n"
            "// =====================================================================\n\n"
        )
        chunks.append(banner + stripped)

    with open(out_path, "w", encoding="utf-8") as fp:
        fp.write("".join(chunks))

    size = os.path.getsize(out_path)
    print(f"Wrote {out_path} ({size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
