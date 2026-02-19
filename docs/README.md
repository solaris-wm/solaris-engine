# SolarisEngine docs (Sphinx)

This folder builds a static documentation website.

The pages in `docs/source/` were initialized from the former repository README files, but are now maintained independently inside `docs/`.

## Setup (in your `SolarisEngine` conda env)

From the repo root:

```bash
conda activate SolarisEngine
python -m pip install -r docs/requirements.txt
```

## Build the website

```bash
cd docs
make html
```

Open `docs/build/html/index.html` in your browser.

## Live-reload during editing (recommended)

```bash
cd docs
sphinx-autobuild -b html source build/html
```

It will print a local URL (usually `http://127.0.0.1:8000`) to open.

## Clean build outputs

```bash
cd docs
make clean
```
