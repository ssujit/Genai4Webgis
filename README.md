<<<<<<< HEAD
# GENIA (Geospatial Natural-language Interaction Assistant)
=======
# Master Thesis= Integrating Local Large Language Models into WebGIS: An Open Framework for Natural-Language Interaction.
## Overview

This repository contains the code, data, and documentation, **"Integrating Local Large Language Models into WebGIS: An Open Framework for Natural-Language Interaction."**.
>>>>>>> cc40aae3f72449c927bffd1f07531fcfbf6dc410

GENIA is a chat-driven WebGIS prototype where a **local LLM** (via Ollama) interprets user intent into **structured JSON actions**, and the **Leaflet frontend executes** those actions deterministically.

## Core design
- **LLM = interpreter** (proposes actions)
- **Frontend = executor** (runs predefined map functions)
- **Backend = controller** (schema validation + safe fallback + explainability metadata)

## Repository layout
- `code/` Flask backend (LLM call, schema validation, fallback, `/chat`, `/geocode`), UI assets (Leaflet chat-driven WebGIS)
- `docs/` setup notes, diagrams, screenshots

## Quick start

### 1) Start Ollama
```bash
ollama serve
```

### 2) Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python app.py
```

### 3) Open the app
Visit `http://127.0.0.1:5000/`

## Configuration
See `backend/.env.example`.

## License
MIT (see `LICENSE`).

## Citation
See `CITATION.cff`.
