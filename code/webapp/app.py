from flask import Flask, jsonify, send_from_directory, request
from pathlib import Path
from datetime import datetime
from random import randint, uniform
import os, json, re
from typing import Any, Dict, List, Tuple

# Optional CORS for local dev
try:
    from flask_cors import CORS  # type: ignore
except Exception:
    CORS = None

# Env + LLM client + schema validation
from dotenv import load_dotenv
from openai import OpenAI
from jsonschema import validate, ValidationError

# ----------------- App setup -----------------
app = Flask(__name__)
if CORS:
    CORS(app)

ROOT = Path(__file__).parent
load_dotenv()


# Add a simple Nominatim geocoder endpoint the LLM can use.
import requests

@app.get("/geocode")
def geocode():
    q = (request.args.get("q") or "").strip()
    if not q: return jsonify({"ok": False, "error": "missing q"}), 400
    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": q, "format": "json", "limit": 1},
            headers={"User-Agent": "thesis-webgis"},
            timeout=8
        )
        r.raise_for_status()
        arr = r.json() or []
        if not arr: return jsonify({"ok": False, "error": "not_found"}), 404
        item = arr[0]
        return jsonify({
            "ok": True,
            "name": item.get("display_name"),
            "lat": float(item["lat"]),
            "lon": float(item["lon"])
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# ----------------- Health & static -----------------
@app.get("/health")
def health():
    return jsonify(ok=True)

@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")

@app.get("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(ROOT / "static", filename)

# ----------------- LLM (Ollama via OpenAI-compatible API) -----------------
client = OpenAI(
    base_url=os.getenv("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1"),
    api_key=os.getenv("OPENAI_API_KEY", "ollama"),
)
MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct-q4_K_M")
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "256"))
REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "18"))

SYSTEM_PROMPT = """
You are a WebGIS Action Planner. Return ONLY one valid JSON object:

{
  "reply": "short user-facing text (<=25 words)",
  "actions": [ Action, ... ]
}

Actions:
1) {"type":"setView","lat":<num>,"lon":<num>,"zoom":<num>}
2) {"type":"loadParking","city":"<string>"?,"place":"<string>"?,"nearMe":<bool>?,"lat":<num>?,"lon":<num>?,"radiusKm":<num>?}
3) {"type":"loadWFS","url":"<string>"}

Rules:
- Strict JSON only (no markdown, no prose).
- Use lowercase keys exactly.
- Distances: convert meters→km (e.g., 500 m → 0.5).
- If user says “near me / around me”, set "nearMe": true and a default "radiusKm": 2.
- If a place/landmark is mentioned (e.g. “Karlsruhe Hauptbahnhof”), set "place" with that text; coords are optional.
- If only a city is given, set "city" and default "radiusKm": 5.
- Include "setView" if you know lat/lon; otherwise omit.
- If unsure, return {"reply":"", "actions": []}.

Examples:

User: "Find available parking near Karlsruhe Hauptbahnhof"
Response:
{"reply":"Showing parking near Karlsruhe Hauptbahnhof.","actions":[
  {"type":"loadParking","place":"Karlsruhe Hauptbahnhof","radiusKm":2}
]}

User: "Find parking within 5 km of Stuttgart Hauptbahnhof"
Response:
{"reply":"Showing parking within 5 km of Stuttgart Hauptbahnhof.","actions":[
  {"type":"loadParking","place":"Stuttgart Hauptbahnhof","radiusKm":5}
]}

User: "Show parking near me"
Response:
{"reply":"Showing parking near your location.","actions":[
  {"type":"loadParking","nearMe":true,"radiusKm":2}
]}

User: "Add WFS https://demo/wfs?service=WFS&request=GetFeature&typeName=verkehr:parkplaetze&outputFormat=application/json"
Response:
{"reply":"Loading WFS layer.","actions":[
  {"type":"loadWFS","url":"https://demo/wfs?service=WFS&request=GetFeature&typeName=verkehr:parkplaetze&outputFormat=application/json"}
]}
"""
# Strict response schema (put this right after SYSTEM_PROMPT)
RESPONSE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["reply", "actions"],
    "properties": {
        "reply": {"type": "string"},
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "oneOf": [
                    {
                        # setView
                        "required": ["type", "lat", "lon", "zoom"],
                        "properties": {
                            "type": {"const": "setView"},
                            "lat": {"type": "number"},
                            "lon": {"type": "number"},
                            "zoom": {"type": "number"},
                        },
                        "additionalProperties": False,
                    },
                    {
                        # loadParking (all fields optional except type)
                        "required": ["type"],
                        "properties": {
                            "type": {"const": "loadParking"},
                            "city": {"type": "string"},
                            "place": {"type": "string"},
                            "nearMe": {"type": "boolean"},
                            "lat": {"type": "number"},
                            "lon": {"type": "number"},
                            "radiusKm": {"type": "number"},
                        },
                        "additionalProperties": False,
                    },
                    {
                        # loadWFS
                        "required": ["type", "url"],
                        "properties": {
                            "type": {"const": "loadWFS"},
                            "url": {"type": "string"},
                        },
                        "additionalProperties": False,
                    },
                ],
            },
        },
    },
    "additionalProperties": False,
}


# ---------- Helpers ----------
def extract_json(text: str) -> Dict[str, Any]:
    m = re.search(r"\{.*\}\s*$", text, re.DOTALL)
    candidate = m.group(0) if m else text.strip()
    return json.loads(candidate)

def validate_or_raise(payload: Dict[str, Any]) -> None:
    validate(instance=payload, schema=RESPONSE_SCHEMA)

def rule_fallback(user_message: str, center: Dict[str, float]) -> Dict[str, Any]:
    msg = (user_message or "").lower()
    if "parking" in msg:
        city = "stuttgart"
        for c in ["stuttgart", "karlsruhe", "heidelberg", "mannheim", "ulm"]:
            if c in msg: city = c
        return {
            "reply": f"Loading parking near {city.title()}.",
            "actions": [
                {"type": "setView",
                "lat": center.get("lat", 48.7758),
                "lon": center.get("lon", 9.1829),
                "zoom": 12},
                {"type": "loadParking", "city": city, "radiusKm": 10},
            ],
        }
    if "wfs" in msg or "http" in msg:
        m = re.search(r"(https?://\S+)", user_message or "")
        url = m.group(1) if m else ""
        return {
            "reply": "Loading WFS layer." if url else "Provide a WFS URL.",
            "actions": [{"type": "loadWFS", "url": url}] if url else [],
        }
    if any(k in msg for k in ["zoom", "center", "view"]):
        return {
            "reply": "Setting the map view.",
            "actions": [{"type": "setView",
                         "lat": center.get("lat", 48.7758),
                         "lon": center.get("lon", 9.1829),
                         "zoom": 12}],
        }
    return {"reply": "How can I help with the map?", "actions": []}

def call_llm(messages: List[Dict[str, str]]) -> Tuple[bool, Dict[str, Any], str]:
    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            temperature=0.1,
            max_tokens=MAX_TOKENS,
            response_format={"type": "json_object"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        raw = resp.choices[0].message.content or ""
        data = extract_json(raw)
        validate_or_raise(data)
        return True, data, raw
    except Exception as e:
        return False, {}, str(e)

# ----------------- LLM health check -----------------
@app.get("/llm-test")
def llm_test():
    center = {"lat": 48.7758, "lon": 9.1829}
    user_prompt = (
        "User message: \"hello from test\". "
        "Current center: lat=48.7758, lon=9.1829. "
        "Return a setView with zoom 12."
    )
    msgs = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]
    ok, payload, err = call_llm(msgs)
    if ok:
        return jsonify({"ok": True, "model": MODEL, "result": payload})
    fb = rule_fallback("hello from test", center)
    return jsonify({"ok": False, "model": MODEL, "fallback_used": True, "error": err, "result": fb})

# ----------------- Main chat: returns strict action JSON -----------------
@app.post("/chat")
def chat():
    body = request.get_json(force=True) or {}
    msg = (body.get("message") or "").strip()
    center = body.get("center") or {}

    if not msg:
        return jsonify({"reply": "Please type a message.", "actions": []})

    prompt = (
        f'User message: "{msg}"\n'
        f'Current center: lat={center.get("lat","")}, lon={center.get("lon","")}.\n'
        "Return only the JSON per schema."
    )
    msgs = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    ok, payload, err = call_llm(msgs)
    if ok:
        return jsonify(payload)

    fb = rule_fallback(msg, center)
    try:
        validate_or_raise(fb)
    except ValidationError:
        fb = {"reply": "Sorry, something went wrong.", "actions": []}
    return jsonify(fb)

# ----------------- Run -----------------
if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)

# app.py
import requests
from functools import lru_cache
from flask import request

@lru_cache(maxsize=512)
def _nom_q(q, viewbox=None, countrycodes=None):
    params = {"q": q, "format": "json", "limit": 1}
    if viewbox: params["viewbox"] = viewbox  # "minLon,minLat,maxLon,maxLat"
    if countrycodes: params["countrycodes"] = countrycodes
    r = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params=params,
        headers={"User-Agent": "thesis-webgis"},
        timeout=8
    )
    r.raise_for_status()
    arr = r.json() or []
    if not arr: return None
    return {
        "name": arr[0].get("display_name"),
        "lat": float(arr[0]["lat"]),
        "lon": float(arr[0]["lon"]),
    }
