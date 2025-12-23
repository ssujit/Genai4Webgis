"""
WebGIS + LLM backend for the Parking ChatMap prototype.

Responsibilities:
- Serve the main web map (Flask + Leaflet frontend).
- Provide a small geocoding helper endpoint (Nominatim).
- Expose a /chat endpoint that turns natural language instructions
  into structured "actions" the web map can execute.
- Use a local LLM (Ollama via OpenAI-compatible API) with a strict
  JSON schema for safe responses.
"""

from typing import Any, Dict, List, Tuple
from functools import lru_cache
import json
import os
import re

import requests
from dotenv import load_dotenv
from jsonschema import ValidationError, validate
from openai import OpenAI
from flask import Flask, jsonify, render_template, request
import time
import uuid

# Optional CORS for local dev (not required in production)
try:
    from flask_cors import CORS  # type: ignore
except Exception:  # pragma: no cover
    CORS = None


# ---------------------------------------------------------------------------
# Flask application setup
# ---------------------------------------------------------------------------

# templates/  -> HTML templates (index.html)
# static/     -> JS, CSS, images for the web map
app = Flask(__name__, static_folder="static", template_folder="templates")

if CORS:
    # Allow requests from the JS frontend during local development.
    CORS(app)

load_dotenv()


# ---------------------------------------------------------------------------
# Nominatim geocoding helper (with simple caching)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=512)
def _nominatim_query(q: str) -> Dict[str, float] | None:
    """
    Query Nominatim once for a free-text location and return a minimal dict.

    Uses a small LRU cache to avoid hammering the service with repeated queries.
    """
    params = {"q": q, "format": "json", "limit": 1}
    r = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params=params,
        headers={"User-Agent": "thesis-webgis"},
        timeout=8,
    )
    r.raise_for_status()
    arr = r.json() or []
    if not arr:
        return None

    return {
        "name": arr[0].get("display_name"),
        "lat": float(arr[0]["lat"]),
        "lon": float(arr[0]["lon"]),
    }


@app.get("/geocode")
def geocode() -> tuple[Any, int] | Any:
    """
    Lightweight geocoding endpoint that the frontend or LLM can call.

    Query:
        /geocode?q=Karlsruhe Hauptbahnhof

    Response (JSON):
        { "ok": true, "name": "...", "lat": 48.99, "lon": 8.40 }
    """
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"ok": False, "error": "missing q"}), 400

    try:
        res = _nominatim_query(q)
        if res is None:
            return jsonify({"ok": False, "error": "not_found"}), 404
        return jsonify({"ok": True, **res})
    except Exception as e:  # pragma: no cover
        return jsonify({"ok": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# Health check and main page
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    """Simple health check endpoint."""
    return jsonify(ok=True)


@app.get("/")
def index():
    """
    Serve the main web map page.

    Flask will load templates/index.html and the page will then
    pull JS/CSS from the static/ folder.
    """
    return render_template("index.html")


# ---------------------------------------------------------------------------
# LLM configuration (Ollama via OpenAI-compatible API)
# ---------------------------------------------------------------------------

client = OpenAI(
    # In dev, this points to the local Ollama server.
    base_url=os.getenv("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1"),
    api_key=os.getenv("OPENAI_API_KEY", "ollama"),
)

MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct-q4_K_M")
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "256"))
REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "120"))

SYSTEM_PROMPT = """
You are the WebGIS Action Planner for a chat-driven mapping application.

Your ONLY job is to understand the user’s message and return a single JSON object
with this structure:

{
  "reply": "<short human-facing message>",
  "actions": [ Action, Action, ... ]
}

────────────────────────────────────────────────────────
GENERAL RULES
────────────────────────────────────────────────────────
1. Always return STRICT JSON. No markdown, no comments, no extra text.
2. "reply" must ALWAYS contain 3–20 words. NEVER leave reply empty.
3. "actions" must be an array. Use [] if no actions are needed.
4. NEVER invent keys or actions not listed below.
5. NEVER guess coordinates if a place name is available.
6. If the user is just greeting (“hi”, “hello”, “how are you”, “nice”), reply briefly and set "actions": [].

────────────────────────────────────────────────────────
AVAILABLE ACTIONS
────────────────────────────────────────────────────────

1) setView  (map navigation)
Move the map to a specific place or coordinate.

A) Using coordinates:
{
  "type": "setView",
  "lat": <number>,
  "lon": <number>,
  "zoom": <number>
}

B) Using a place name (frontend will geocode):
{
  "type": "setView",
  "place": "<place name>",
  "zoom": <number>
}

Use when the user says things like:
"zoom to Berlin", "go to Stuttgart", "center map on Freiburg", "fly to Munich".

────────────────────────────────────────────────────────

2) loadParking  (query active WFS for nearby parking)

{
  "type": "loadParking",
  "city": "<string>"?,        // optional
  "place": "<string>"?,       // optional
  "nearMe": <boolean>?,       // optional
  "lat": <number>?,           // optional
  "lon": <number>?,           // optional
  "radiusKm": <number>?       // optional (default 5)
}

Use when the user asks for parking, for example:
"show parking near Stuttgart",
"parking within 2 km of Karlsruhe Hbf",
"find parking around me".

If the user only gives a city, set "place" to that city.
If the user says "near me" or "around me", set "nearMe": true and default "radiusKm": 2.
If only a city is given, default "radiusKm": 5.

────────────────────────────────────────────────────────

3) loadWFS  (load a WFS GetFeature URL as a layer)

{
  "type": "loadWFS",
  "url": "<full WFS GetFeature URL>"
}

Use when the user shares or references a WFS URL to load.

────────────────────────────────────────────────────────

4) measureDistance  (distance between two locations)

DEFAULT:
• Use DRIVING distance (car route) unless the user explicitly asks for straight-line/air/flight distance.

Action format (place names preferred):
{
  "type": "measureDistance",
  "fromPlace": "<place A>",
  "toPlace": "<place B>",
  "mode": "car",         // "car" (default) or "air" (straight-line)
  "units": "km"
}

Coordinate form (only if the user explicitly provides coordinates):
{
  "type": "measureDistance",
  "fromLat": <number>,
  "fromLon": <number>,
  "toLat": <number>,
  "toLon": <number>,
  "mode": "car",
  "units": "km"
}

When to use:
• "distance between Stuttgart and Munich" → mode="car"
• "how far is Berlin from Freiburg" → mode="car"
• "driving distance Karlsruhe to Mannheim" → mode="car"

ONLY use mode="air" if the user explicitly says:
• "air distance", "flight distance", "straight line", "as the crow flies"
Example:
• "flight distance between Karlsruhe and Stuttgart" → mode="air"

NEVER invent coordinates — use place names whenever possible.

5) describeLayer  (summarize the currently loaded data layer)

{
  "type": "describeLayer"
}

Use when the user asks things like:
"describe this dataset"
"what fields are available?"
"what data is loaded?"
"summarize the layer"
"show dataset info"

This action summarizes the layer currently loaded in the map.

6) countLayer  (count features in the currently loaded layer)

Preferred form:
{
  "type": "countLayer",
  "metric": "total"
}

Realtime count:
{
  "type": "countLayer",
  "metric": "realtime"
}

Use when the user asks:
"how many points are loaded?"
"how many parking points?"
"count the features"
"how many have realtime data?"


────────────────────────────────────────────────────────
BEHAVIOR GUIDANCE
────────────────────────────────────────────────────────

• If the user message is vague or small talk (e.g. "nice", "ok", "how are you"):
  Return something like:
  {
    "reply": "I'm here to help. What would you like to do with the map?",
    "actions": []
  }
  
• If the user asks to describe, summarize, or explain the currently loaded data:
  ALWAYS use the "describeLayer" action.


• If the user asks to show or go to a place:
  Use "setView" with a place name and an appropriate zoom level.

• If the user asks for distance between two named places:
  Use a single "measureDistance" action with "fromPlace" and "toPlace".

• If the user asks for parking near a place or city:
  Use "loadParking" with "place" or "city" and a reasonable "radiusKm".

• If you truly do not understand the request:
  Return:
  {
    "reply": "I am not sure what you want. Please describe what to do on the map.",
    "actions": []
  }

────────────────────────────────────────────────────────
OUTPUT EXAMPLES
────────────────────────────────────────────────────────

Example A – “zoom to Stuttgart”
{
  "reply": "Zooming to Stuttgart on the map.",
  "actions": [
    { "type": "setView", "place": "Stuttgart", "zoom": 12 }
  ]
}

Example B – “distance between Munich and Berlin”
{
  "reply": "Measuring the distance between Munich and Berlin.",
  "actions": [
    {
      "type": "measureDistance",
      "fromPlace": "Munich",
      "toPlace": "Berlin",
      "units": "km"
    }
  ]
}

Example C – “show parking near Freiburg”
{
  "reply": "Loading parking options near Freiburg.",
  "actions": [
    {
      "type": "loadParking",
      "place": "Freiburg",
      "radiusKm": 5
    }
  ]
}

Return ONLY the JSON object. Nothing else.
"""


# JSON schema used to validate the LLM output before sending it to the frontend.
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
                        "required": ["type"],
                        "properties": {
                            "type": {"const": "setView"},
                            # Option A: explicit coordinates
                            "lat": {"type": "number"},
                            "lon": {"type": "number"},
                            "zoom": {"type": "number"},
                            # Option B: place name (frontend will geocode)
                            "place": {"type": "string"},
                        },
                        # At least type + (lat+lon) OR type + place
                        "anyOf": [
                            {"required": ["type", "lat", "lon"]},
                            {"required": ["type", "place"]},
                        ],
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
                    {
                        # describeLayer
                        "required": ["type"],
                        "properties": {
                            "type": {"const": "describeLayer"},
                        },
                        "additionalProperties": False,
                    },

                    {
                        # countLayer
                        "required": ["type"],
                        "properties": {
                            "type": {"const": "countLayer"},
                            "metric": {"type": "string", "enum": ["total", "realtime"]},
                        },
                        "additionalProperties": False,
                    },

                    {
                        # measureDistance (places or coords for A and B)
                        "required": ["type"],
                        "properties": {
                            "type": {"const": "measureDistance"},
                            # Option 1: place names (preferred)
                            "fromPlace": {"type": "string"},
                            "toPlace": {"type": "string"},
                            # Option 2: explicit coords (ONLY if user provides them)
                            "fromLat": {"type": "number"},
                            "fromLon": {"type": "number"},
                            "toLat": {"type": "number"},
                            "toLon": {"type": "number"},
                            # NEW: distance mode
                            # "car" = driving (DEFAULT)
                            # "air" = straight-line / flight
                            "mode": {
                                "type": "string",
                                "enum": ["car", "air"]
                            },
                            # Optional units (frontend still formats)
                            "units": {"type": "string"},
                        },
                        "additionalProperties": False,
                    },
                ],
            },
        },
    },
    "additionalProperties": False,
}


# ---------------------------------------------------------------------------
# Helper functions around the LLM
# ---------------------------------------------------------------------------

def extract_json(text: str) -> Dict[str, Any]:
    """
    Try to extract the last JSON object from the LLM response.

    We still keep this as a safety net even though we request
    response_format={"type": "json_object"}.
    """
    m = re.search(r"\{.*\}\s*$", text, re.DOTALL)
    candidate = m.group(0) if m else text.strip()
    return json.loads(candidate)


def validate_or_raise(payload: Dict[str, Any]) -> None:
    """Validate the LLM JSON output against RESPONSE_SCHEMA."""
    validate(instance=payload, schema=RESPONSE_SCHEMA)


def rule_fallback(user_message: str, center: Dict[str, float]) -> Dict[str, Any]:
    """
    Very simple rule-based fallback in case the LLM fails.

    Ensures the frontend always gets a syntactically valid action structure.
    """
    msg = (user_message or "").lower()
    
    # --- Describe layer fallback ---
    if any(k in msg for k in ["describe", "summary", "summarize", "dataset", "layer info", "what fields", "data info"]):
        return {
            "reply": "Summarizing the currently loaded dataset.",
            "actions": [
                {"type": "describeLayer"}
            ],
        }


    # --- Parking fallback ---
    if "parking" in msg:
        city = "stuttgart"
        for c in ["stuttgart", "karlsruhe", "heidelberg", "mannheim", "ulm"]:
            if c in msg:
                city = c
        return {
            "reply": f"Loading parking near {city.title()}.",
            "actions": [
                {
                    "type": "setView",
                    "lat": center.get("lat", 48.7758),
                    "lon": center.get("lon", 9.1829),
                    "zoom": 12,
                },
                {"type": "loadParking", "city": city, "radiusKm": 10},
            ],
        }
        
    # --- CountLayer fallback ---
    if "how many" in msg or "count" in msg:
        metric = "realtime" if ("realtime" in msg or "real time" in msg) else "total"
        return {
            "reply": "Counting features in the currently loaded dataset.",
            "actions": [{"type": "countLayer", "metric": metric}],
        }

    # --- WFS fallback ---
    if "wfs" in msg or "http" in msg:
        m = re.search(r"(https?://\S+)", user_message or "")
        url = m.group(1) if m else ""
        return {
            "reply": "Loading WFS layer." if url else "Provide a WFS URL.",
            "actions": [{"type": "loadWFS", "url": url}] if url else [],
        }
        
    # --- Distance fallback ---
    if "distance" in msg or "how far" in msg:
        # Try patterns:
        #  - "distance between A and B"
        #  - "distance from A to B"
        text = user_message or ""
        m = re.search(r"between\s+(.+)\s+and\s+(.+)", text, re.IGNORECASE)
        if not m:
            m = re.search(r"from\s+(.+)\s+to\s+(.+)", text, re.IGNORECASE)

        if m:
            from_place = m.group(1).strip()
            to_place = m.group(2).strip()
            return {
                "reply": f"Measuring distance between {from_place} and {to_place}.",
                "actions": [
                    {
                        "type": "measureDistance",
                        "fromPlace": from_place,
                        "toPlace": to_place,
                        "units": "km",
                    }
                ],
            }

        # If we can't parse two places, ask the user to rephrase.
        return {
            "reply": "I could not read the two places. Try 'distance between A and B'.",
            "actions": [],
        }


    # --- Zoom / center / view fallback ---
    if any(k in msg for k in ["zoom", "center", "view"]):
        # Try to extract a place name after "to/on/at"
        m = re.search(r"(?:to|on|at)\s+(.+)", user_message or "", re.IGNORECASE)
        place = (m.group(1).strip() if m else (user_message or "")).strip()

        # Default: current center or Stuttgart
        lat = center.get("lat", 48.7758)
        lon = center.get("lon", 9.1829)

        if place:
            try:
                loc = _nominatim_query(place)
                if loc:
                    lat = loc["lat"]
                    lon = loc["lon"]
            except Exception:
                # If geocode fails, we just keep the center coords
                pass

        return {
            "reply": f"Setting the map view{f' to {place}' if place else ''}.",
            "actions": [
                {
                    "type": "setView",
                    "lat": lat,
                    "lon": lon,
                    "zoom": 12,
                }
            ],
        }

    # --- Default ---
    return {"reply": "How can I help with the map?", "actions": []}


def call_llm(messages: List[Dict[str, str]]) -> Tuple[bool, Dict[str, Any], str]:
    """
    Call the LLM and validate its JSON answer.

    Returns:
        (ok, payload, raw_text)
    """
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
    except Exception as e:  # pragma: no cover
         # *** debug print ***
        print("LLM ERROR:", repr(e))
        return False, {}, str(e)


# ---------------------------------------------------------------------------
# LLM test endpoint
# ---------------------------------------------------------------------------

@app.get("/llm-test")
def llm_test():
    """
    Quick sanity check to verify that the LLM + schema validation works.

    Returns either the model's structured response or the rule-based fallback.
    """
    center = {"lat": 48.7758, "lon": 9.1829}
    user_prompt = (
        'User message: "hello from test". '
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
    return jsonify(
        {
            "ok": False,
            "model": MODEL,
            "fallback_used": True,
            "error": err,
            "result": fb,
        }
    )


# ---------------------------------------------------------------------------
# Main /chat endpoint used by the frontend chat box
# ---------------------------------------------------------------------------

@app.post("/chat")
def chat():
    """
    Turn a free-text user message into structured WebGIS actions.

    Expects JSON body:
        {
          "message": "find parking near Karlsruhe Hbf",
          "center": { "lat": 48.99, "lon": 8.40 }   # optional
        }

    Returns JSON:
        { "reply": "...", "actions": [ ... ] }
    """
    body = request.get_json(force=True) or {}
    msg = (body.get("message") or "").strip()
    center = body.get("center") or {}

    if not msg:
        return jsonify({"reply": "Please type a message.", "actions": [], "meta": {"decision_source": "system"}})

    request_id = str(uuid.uuid4())[:8]
    t0 = time.time()

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
    dt_ms = int((time.time() - t0) * 1000)

    if ok:
        # --- Explainability meta (LLM path) ---
        actions = payload.get("actions") or []
        payload["meta"] = {
            "request_id": request_id,
            "decision_source": "ollama",
            "model": MODEL,
            "schema_valid": True,
            "lat": center.get("lat"),
            "lon": center.get("lon"),
            "action_types": [a.get("type") for a in actions if isinstance(a, dict)],
            "latency_ms": dt_ms,
        }
        return jsonify(payload)

    # --- Fallback (rule-based path) ---
    fb = rule_fallback(msg, center)
    try:
        validate_or_raise(fb)
        schema_ok = True
    except ValidationError:
        fb = {"reply": "Sorry, something went wrong.", "actions": []}
        schema_ok = False

    fb["meta"] = {
        "request_id": request_id,
        "decision_source": "rule_fallback",
        "schema_valid": schema_ok,
        "lat": center.get("lat"),
        "lon": center.get("lon"),
        "llm_error": err,           # keep for evaluation/debug; you can hide in UI later
        "latency_ms": dt_ms,
        "action_types": [a.get("type") for a in (fb.get("actions") or []) if isinstance(a, dict)],
    }
    return jsonify(fb)


# ---------------------------------------------------------------------------
# Entry point for local development
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # For local dev only. In production, use gunicorn/uwsgi etc.
    app.run(host="127.0.0.1", port=5000, debug=True)
