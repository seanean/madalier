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
- **Table meta fields** — optional engineering columns (e.g. lineage, timestamps) defined by a template ([`data/config/default_meta_config.json`](data/config/default_meta_config.json) and optional per-model [`config/meta_config.json`](data/models/)); toggled from the header and validated with [`schemas/meta_config.json`](schemas/meta_config.json). See [design.md](design.md) for paths and API details.

### Header bar (main actions)

| Button | What it does |
|--------|----------------|
| **New model** | Opens a dialog to create a working model (name, version, description, created by). Derives `technical_name` from the display name using the naming config. |
| **Open model** | Lists saved canonical models and opens the selected one into a **working copy** under `temp/` for editing. |
| **Save model** | Promotes the working model and layout to canonical files under `data/models/<technical_name>/`, then regenerates CSV, DDL trees, and optionally saves a diagram PNG. |
| **Show technical names** / **Show business names** | Toggles whether the diagram uses **technical** or **business** names for entities and attributes (disabled until a model is open). |
| **Add entity** | Adds a table or view on the diagram; you can drag it to position it. |
| **Add attribute** | Adds an attribute to the **currently selected entity** (select an entity on the diagram first). |
| **Add relationship** | Creates a relationship between two **non-meta** attributes on different entities (requires at least two such attributes). |
| **Remove selected** | Removes the selected diagram element (entity, attribute, or relationship) from the model. |
| **Export diagram** | Captures the current diagram as a PNG (saves via the API). |
| **Export DDL** | Writes the `ddls/` tree (full and simple variants × dialects) for the current working model after persisting it. |
| **Export CSV** | Writes the flattened model CSV next to the canonical model after persisting the working copy. |
| **Meta fields** | Toggles whether **meta template** columns are applied to every **table** entity (`meta_fields_enabled` on the model). When on, columns are synced from the effective template; when off, meta attributes are removed. Disabled until a model is open. |
| **Manage meta fields** | Opens a dialog to edit the per-model meta template (`config/meta_config.json`), including add/remove/reorder fields. **Save** writes the file; **Set as default** saves then copies it to the global [`default_meta_config.json`](data/config/default_meta_config.json). Disabled until a model is open. |

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
- **Default meta-field template** is **`data/config/default_meta_config.json`** (validated against [`schemas/meta_config.json`](schemas/meta_config.json)). A model can override it with **`data/models/<technical_name>/config/meta_config.json`**.

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
| `schemas/` | JSON Schema for model, layout, naming, meta config |
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
