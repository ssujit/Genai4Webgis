# Local Setup (Thesis Demo)

## 1) Start Ollama
Install Ollama, then pull and run a model (example):

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama serve
```

> The backend expects an OpenAI-compatible endpoint at `http://127.0.0.1:11434/v1`.

## 2) Run the backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python app.py
```

## 3) Open the frontend
Open the app at:
- `http://127.0.0.1:5000/`

## Troubleshooting
- If every answer falls back to rule-based output, your Ollama endpoint/model is not reachable.
- Check `/health` and the backend terminal logs.
