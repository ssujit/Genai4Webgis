# GENIA (Geospatial Natural-language Interaction Assistant)

GENIA is a chat-driven WebGIS prototype where a **local LLM** (via Ollama) interprets user intent into **structured JSON actions**, and the **Leaflet frontend executes** those actions deterministically.

![](asset\screenshoot_ui.png)



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

### 1. Start Ollama
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
Visit `http://your local host`

### Example data import

Use "Add data" button and add this example WFS: 

```
https://api.mobidata-bw.de/geoserver/MobiData-BW/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=MobiData-BW%3Acharge_points&outputFormat=application%2Fjson&maxFeatures=50

```

## Configuration
See `backend/.env.example`.

## License
MIT (see `LICENSE`).

## Citation
See `CITATION.cff`.

## Notes: 
This software is part of the Master thesis topic defined by [Dr.-Ing. Sujit Kumar Sikder](https://www.ioer.de/institut/beschaeftigte/sikder) and hosted at the Leibniz Institute of Ecological Urban and Regional Development (IOER) in Dresden. The **Thesis title:** *Integrating Local Large Language Models into WebGIS: An Open Framework for Natural Language Interaction.* conducted by [Mr. Rahaman](https://de.linkedin.com/in/mdashifurrahaman).  Acknowledgement goes to the Prof. Dr.-Ing. Angela Blanco-Vogt at the Hochschule für Technik Stuttgart, for her kind insightful feedbacks and co-operation.
