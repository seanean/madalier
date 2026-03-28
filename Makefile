.PHONY: setup run

VENV := venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

setup:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -r requirements.txt

run:
	@if [ ! -x "$(PYTHON)" ]; then \
		echo "Run 'make setup' first."; exit 1; \
	fi
	$(PYTHON) app.py
