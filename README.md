# GENIA (Geospatial Natural-language Interaction Assistant)

**Thesis title:** *Integrating Local Large Language Models into WebGIS: An Open Framework for Natural-Language Interaction.*

GENIA is a chat-driven WebGIS prototype where a **local LLM** (via Ollama) interprets user intent into **structured JSON actions**, and the **Leaflet frontend executes** those actions deterministically.

## Core design
- **LLM = interpreter** (proposes actions)
- **Frontend = executor** (runs predefined map functions)
- **Backend = controller** (schema validation + safe fallback + explainability metadata)

## Repository layout
- `backend/` Flask backend (LLM call, schema validation, fallback, `/chat`, `/geocode`)
- `frontend/` UI assets (Leaflet chat-driven WebGIS)
- `schema/` JSON schema for the response payload
- `docs/` setup notes, diagrams, screenshots
- `evaluation/` prompts/use cases + results summaries

## Requirements

To run GENIA locally you need:

- **Python 3.10+** (Flask backend)
- **pip** (Python package manager)
- **Ollama** (to run a local LLM)
- A local LLM model pulled in Ollama (e.g., `llama3.1`, `mistral`, etc.)
- A modern browser (Chrome/Firefox/Edge) to run the Leaflet frontend
- Internet access (for WFS / geocoding / routing services, depending on your config)

Optional (recommended):
- **Git** (clone + version control)
- **VS Code** (or any editor)


## Quick start

### 1 Start Ollama
```bash
ollama serve
```

### 2 Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python app.py
```

### 3 Open the app
Visit `http://127.0.0.1:5000/`

## Configuration
See `backend/.env.example`.

## License
MIT (see `LICENSE`).

## Citation
See `CITATION.cff`.
