# SolarisEngine docs (Sphinx)

This folder builds a static documentation website.

The pages in `docs/source/` were initialized from the former repository README files, but are now maintained independently inside `docs/`.

## Setup

From the repo root:

```bash
conda env create -f docs/env.yaml
conda activate solaris-docs
python -m pip install -r docs/requirements.txt
npm install
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
