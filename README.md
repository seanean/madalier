# Madalier

Madalier is a **local web app** for building and refining **logical data models**: entities, attributes, and relationships, with a **visual diagram**, **working copies** while you edit, and exports to **CSV** and **SQL DDL** for several databases. It is aimed at modelers and engineers who want a single place to capture structure and regenerate artifacts on disk.

The stack is **Flask** (Python) plus static HTML/JS (**Cytoscape.js** for the diagram). Data lives under `data/` as JSON, CSV, PNG, and generated `.sql` files—no external database is required to run the app.

For architecture, API routes, and on-disk layout, see **[design.md](design.md)**.

## Features

- Create and open models keyed by a **`technical_name`** (folder name under `data/models/`).
- Edit **metadata**, **entities**, **attributes**, and **relationships** with schema validation ([`schemas/model.json`](schemas/model.json)).
- **Diagram** with draggable entities, automatic layout or saved positions ([`schemas/layout.json`](schemas/layout.json)).
- **Save** promotes the working copy to the canonical model and refreshes **CSV**, **DDL** trees (`full` / `simple` × multiple **dialects**: SQLite, MySQL, Postgres, Snowflake, MSSQL, Databricks), and optionally a **diagram PNG**.
- **Naming** helpers driven by [`data/config/naming_config.json`](data/config/naming_config.json) (business → technical strings).

## Requirements

- **Python** 3.10 or newer (3.12 recommended).
- A modern **browser**.
- **`make`** — optional; used for the shortest quick start on Linux/macOS/WSL.
- **Windows** — use the PowerShell scripts under `scripts/` or the manual `venv` commands below (no `make` required).

## Quick start

### Linux / macOS / WSL (with Make)

```bash
make setup
make run
```

### Windows (PowerShell)

From the repository root (if scripts are blocked, see [Troubleshooting](#troubleshooting)):

```powershell
.\scripts\setup.ps1
.\scripts\run.ps1
```

### Manual (any OS)

```bash
python3 -m venv venv
```

**Unix-like:** activate with `source venv/bin/activate`, then:

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python app.py
```

**Windows (cmd or PowerShell without activation):**

```text
venv\Scripts\python.exe -m pip install --upgrade pip
venv\Scripts\python.exe -m pip install -r requirements.txt
venv\Scripts\python.exe app.py
```

Then open [http://localhost:54321](http://localhost:54321). The dev server uses Flask’s **debug** mode and reloader.

## Configuration and data

- **Models** are stored under **`data/models/<technical_name>/`**. Treat this as your working data: back it up or version it deliberately if models are important.
- **Naming config** is **`data/config/naming_config.json`** (validated against [`schemas/naming.json`](schemas/naming.json)).

## Development

- **Port:** `54321` (see `app.py` if you need to change it).
- **Design doc:** [design.md](design.md) lists routes, disk layout, and where to edit code.
- **Dependencies:** [`requirements.txt`](requirements.txt) (Flask, jsonschema).

## Project layout

| Path | Role |
|------|------|
| `app.py` | Flask app and JSON API |
| `ddl_export.py` | DDL generation per dialect |
| `app_logger.py` | Logging helper |
| `templates/`, `static/` | UI (HTML, JS, CSS) |
| `static/vendor/` | Bundled front-end libraries |
| `data/models/` | Model JSON, layouts, CSV, PNG, `ddls/` |
| `data/config/` | Configuration files (naming) |
| `schemas/` | JSON Schema for model, layout, naming |
| `scripts/` | `setup.ps1` / `run.ps1` for Windows |
| `Makefile` | `setup` / `run` for Unix-like systems |

## Troubleshooting

- **PowerShell: script execution disabled** — you can run each script in a child process that bypasses policy only for that command (nothing stored for your user account):
  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1
  ```
  Alternatively, in an **interactive** PowerShell window, limit the change to **that session only**:
  ```powershell
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  .\scripts\setup.ps1
  .\scripts\run.ps1
  ```
  Or use the manual Windows `venv\Scripts\python.exe` commands above and skip `.ps1` entirely.
- **Port already in use** — stop the other process on `54321` or change the port in `app.py`.
