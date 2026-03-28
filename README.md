# Madalier

Web app for exploring and editing data models, DDL layouts, and related metadata. Built with [Flask](https://flask.palletsprojects.com/).

## Requirements

- Python 3.10+ (3.12 recommended)
- `make` (optional but used below)

## Quick start

```bash
make setup
make run
```

Then open [http://localhost:54321](http://localhost:54321) in your browser. The dev server runs with Flask’s debug reloader.

### Without Make

```bash
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
./venv/bin/python app.py
```

## Project layout

- `app.py` — Flask application and API
- `templates/`, `static/` — UI
- `data/` — model data, CSV/JSON, and DDL SQL files
- `schemas/` — JSON schemas for validation
