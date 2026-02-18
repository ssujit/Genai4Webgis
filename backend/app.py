"""
WebGIS + LLM backend for the Parking ChatMap prototype.

This Flask backend supports a chat-driven WebGIS frontend (Leaflet/JS).
The system follows a controlled architecture:

- The LLM is an *interpreter* that outputs structured JSON actions.
- The frontend is the *executor* that performs deterministic map operations.
- A JSON schema validates LLM outputs for robustness and safety.
- A rule-based fallback ensures the system still responds if the LLM fails.

Main responsibilities:
1) Serve the web map UI (Flask templates + static assets).
2) Provide a lightweight geocoding endpoint (Nominatim /geocode).
3) Provide a /chat endpoint that converts user input to map actions.
4) Integrate a local LLM (Ollama through OpenAI-compatible API endpoint).
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

# Optional: CORS support for development environments (e.g., frontend served from another port).
# This is kept optional so production deployments can avoid extra dependencies.
try:
    from flask_cors import CORS  # type: ignore
except Exception:  # pragma: no cover
    CORS = None


# ---------------------------------------------------------------------------
# Flask application setup
# ---------------------------------------------------------------------------

# templates/  -> HTML templates (e.g., index.html)
# static/     -> JS, CSS, images (Leaflet frontend)
app = Flask(__name__, static_folder="static", template_folder="templates")

if CORS:
    # Allow requests from the JS frontend during local development.
    CORS(app)

# Loads environment variables from a .env file (local dev convenience).
# Example env vars: OPENAI_BASE_URL, OLLAMA_MODEL, MAX_TOKENS, etc.
load_dotenv()


# ---------------------------------------------------------------------------
# Nominatim geocoding helper (with simple caching)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=512)
def _nominatim_query(q: str) -> Dict[str, float] | None:
    """
    Query OpenStreetMap Nominatim for a free-text location string.

    Why caching?
    - Avoids repeated network calls when the user requests the same place again.
    - Reduces load on Nominatim (important for fair usage).
    - Improves response time for repeated interactions.

    Args:
        q: Place query string (e.g., "Karlsruhe Hauptbahnhof").

    Returns:
        Minimal dict with name/lat/lon if found, otherwise None.
    """
    params = {"q": q, "format": "json", "limit": 5, "countrycodes": "de"}
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

    # Prefer more "specific" objects over broad administrative areas.
    # Example: "station" results are usually better than a city boundary polygon.
    def score(item):
        cls = (item.get("class") or "")
        typ = (item.get("type") or "")
        imp = float(item.get("importance") or 0)

        bonus = 0
        if cls in ("railway", "amenity", "building", "tourism", "shop", "office", "highway"):
            bonus += 2
        if typ in ("station", "train_station", "tram_stop", "bus_station"):
            bonus += 2

        return bonus + imp

    best = max(arr, key=score)
    return {
        "name": best.get("display_name"),
        "lat": float(best["lat"]),
        "lon": float(best["lon"]),
    }


@app.get("/geocode")
def geocode() -> tuple[Any, int] | Any:
    """
    Lightweight geocoding endpoint.

    Intended usage:
    - Called by the frontend when an action uses a "place" string.
    - Can also be used during testing and debugging.

    Request:
        /geocode?q=Karlsruhe Hauptbahnhof

    Response:
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
        # Any network error, timeout, or parsing failure will return a server error.
        return jsonify({"ok": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# Health check and main page
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    """Simple health check endpoint for quick monitoring/diagnostics."""
    return jsonify(ok=True)


@app.get("/")
def index():
    """
    Serve the main web map page.

    Flask renders templates/index.html, which then loads JS/CSS from static/.
    """
    return render_template("index.html")


# ---------------------------------------------------------------------------
# LLM configuration (Ollama via OpenAI-compatible API)
# ---------------------------------------------------------------------------

# Using OpenAI client pointed at a local Ollama server (OpenAI-compatible API).
# This keeps the code compatible with both local models and OpenAI-hosted models.
client = OpenAI(
    base_url=os.getenv("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1"),
    api_key=os.getenv("OPENAI_API_KEY", "ollama"),
)

# Model + runtime constraints are configured via environment variables for portability.
MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct-q4_K_M")
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "256"))
REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "240"))

def warmup_ollama() -> None:
    """
    Optional warmup call to reduce first-request latency and verify connectivity.

    Notes:
    - If Ollama is down or misconfigured, this will print an error but will not crash the app.
    - The prompt is intentionally small and forces strict JSON output.
    """
    try:
        client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "Return STRICT JSON: {\"reply\":\"ok\",\"actions\":[]}"},
                {"role": "user", "content": "warmup"},
            ],
            temperature=0,
            max_tokens=128,
            response_format={"type": "json_object"},
            timeout=30,
        )
        print("Ollama warmup: OK")
    except Exception as e:
        print("Ollama warmup: FAILED", repr(e))

# Warm up once during app startup (safe in dev; in production, you may prefer delayed warmup).
warmup_ollama()

# System prompt: forces the model to output ONLY a JSON object following a strict action schema.
# This is the core "LLM as interpreter" mechanism: the model plans actions, but does not execute them.
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
If the user specifies distance in meters (m), convert it to kilometers:
radiusKm = meters / 1000.
Example: "within 200 m" → radiusKm = 0.2


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

7) filterWithin  (highlight features within a radius)

{
  "type": "filterWithin",
  "place": "<string>"?,     // preferred
  "lat": <number>?,         // only if user provides coords
  "lon": <number>?,
  "radiusM": <number>
}

Use when user asks:
"show parking within 200m of Karlsruhe Hbf"
"points within 100 meters of X"

8) findByAttribute (find/highlight features by attribute match)

{
  "type": "findByAttribute",
  "field": "<string>",      // e.g., "id", "address", "name"
  "values": ["<string>", "<string>", "..."],      // user’s search text
  "limit": <number>?        // optional, default 20
}

Use when user asks:
"show id 34399"
"find address Grüne Meile"
"search Heidelberg"
"find parking named X"
Rules:
If user says “id”, set field="id" and value="<number as string>".
If user says “address”, set field="address".
If user doesn’t specify field, use field="*".

9) openAttributeTable  (open the attribute table for the active layer)

{
  "type": "openAttributeTable"
}

Use when the user says:
"open attribute table"
"show attribute table"
"open table"

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
# This prevents “free-form” model output from breaking the client.
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
                        # filterWithin (highlight features within radius of a place/coords)
                        "required": ["type"],
                        "properties": {
                            "type": {"const": "filterWithin"},
                            "place": {"type": "string"},
                            "lat": {"type": "number"},
                            "lon": {"type": "number"},
                            "radiusM": {"type": "number"},
                        },
                        "anyOf": [
                            {"required": ["type", "place", "radiusM"]},
                            {"required": ["type", "lat", "lon", "radiusM"]},
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
                        # openAttributeTable
                        "required": ["type"],
                        "properties": {
                            "type": {"const": "openAttributeTable"},
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
                        # findByAttribute
                        "required": ["type", "field", "values"],
                        "properties": {
                            "type": { "const": "findByAttribute" },
                            "field": { "type": "string" },
                            "values": {
                            "type": "array",
                            "items": { "type": "string" },
                            "minItems": 1
                            },
                            "limit": { "type": "number" }
                        },
                        "additionalProperties": False
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
                            # Distance mode:
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
    Extract a JSON object from the model output.

    Even though we request response_format={"type": "json_object"},
    some models may still wrap or append text. This function attempts to
    safely parse the last JSON object in the response.

    Args:
        text: Raw model output.

    Returns:
        Parsed JSON object as a Python dict.

    Raises:
        json.JSONDecodeError if no valid JSON can be parsed.
    """
    m = re.search(r"\{.*\}\s*$", text, re.DOTALL)
    candidate = m.group(0) if m else text.strip()
    return json.loads(candidate)


def validate_or_raise(payload: Dict[str, Any]) -> None:
    """
    Validate the LLM JSON output against RESPONSE_SCHEMA.

    Raises:
        jsonschema.ValidationError if payload does not match the schema.
    """
    validate(instance=payload, schema=RESPONSE_SCHEMA)


def rule_fallback(user_message: str, center: Dict[str, float]) -> Dict[str, Any]:
    """
    Rule-based fallback action planner.

    This is used when:
    - The LLM is unavailable (Ollama not running / timeout).
    - The model response fails parsing or schema validation.
    - The system is running in "fallback" mode.

    Design goal:
    Always return a syntactically valid {"reply": ..., "actions": [...]} object
    so the frontend never breaks.

    Args:
        user_message: Raw user input from the chat box.
        center: Current map center from frontend (lat/lon), if provided.

    Returns:
        Dict matching the response schema (reply + actions).
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
        text = user_message or ""

        # radius: support "500m" or "2 km"
        radius_km = 5
        m_m = re.search(r"(\d+(?:\.\d+)?)\s*m\b", text, re.IGNORECASE)
        m_km = re.search(r"(\d+(?:\.\d+)?)\s*km\b", text, re.IGNORECASE)
        if m_m:
            radius_km = float(m_m.group(1)) / 1000.0
        elif m_km:
            radius_km = float(m_km.group(1))

        # place: support "of Karlsruhe Hbf"
        place = None
        m_place = re.search(r"\b(?:of|from|near)\s+(.+)$", text, re.IGNORECASE)
        if m_place:
            place = m_place.group(1).strip()

        return {
            "reply": "Loading parking near your requested location.",
            "actions": [
                {"type": "loadParking", "place": place or "", "radiusKm": radius_km},
            ],
        }

    # --- Find by ID / attribute fallback ---
    # Supports common patterns like:
    # - "show id 34897, 36975 and 34912"
    # - "find id:34897"
    m_multi = re.search(r"\bid\b", user_message or "", re.IGNORECASE)
    if m_multi:
        ids = re.findall(r"\b\d+\b", user_message or "")
        if ids:
            ids = list(dict.fromkeys(ids))  # unique, keep order
            return {
                "reply": f"Finding {len(ids)} feature(s) by id.",
                "actions": [
                    {"type": "findByAttribute", "field": "id", "values": ids, "limit": 50}
                ],
            }

    # Single ID variant
    m_id = re.search(r"\b(?:show|find|search)\s+id\s*[:#]?\s*(\d+)\b", user_message or "", re.IGNORECASE)
    if m_id:
        val = m_id.group(1)
        return {
            "reply": f"Finding feature with id {val}.",
            "actions": [
                {"type": "findByAttribute", "field": "id", "values": [val], "limit": 20}
            ],
        }

    # Address variant
    m_addr = re.search(r"\b(?:show|find|search)\s+address\s+(.+)$", user_message or "", re.IGNORECASE)
    if m_addr:
        val = m_addr.group(1).strip()
        return {
            "reply": "Searching features by address.",
            "actions": [
                {"type": "findByAttribute", "field": "address", "values": [val], "limit": 20}
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
        m = re.search(r"between\s+(.+?)\s+(?:and|to)\s+(.+)", text, re.IGNORECASE)
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
        
    # open attribute table
    if "attribute table" in msg or "open table" in msg or "show table" in msg:
        return {
            "reply": "Opening the attribute table.",
            "actions": [{"type": "openAttributeTable"}],
        }


    # --- Zoom / center / view fallback ---
    if any(k in msg for k in ["zoom", "center", "view"]):
        # Extract a place name after common prepositions (to/on/at).
        m = re.search(r"(?:to|on|at)\s+(.+)", user_message or "", re.IGNORECASE)
        place = (m.group(1).strip() if m else (user_message or "")).strip()

        # Default: use current center if available; otherwise use Stuttgart coordinates.
        lat = center.get("lat", 48.7758)
        lon = center.get("lon", 9.1829)

        # If a place string exists, attempt geocoding; if it fails, keep current center.
        if place:
            try:
                loc = _nominatim_query(place)
                if loc:
                    lat = loc["lat"]
                    lon = loc["lon"]
            except Exception:
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
    Call the LLM and validate its JSON output.

    This function encapsulates:
    1) model request
    2) JSON extraction/parsing
    3) schema validation

    Args:
        messages: OpenAI-style chat messages list (system/user roles).

    Returns:
        (ok, payload, raw_text_or_error)
        - ok=True: payload contains validated JSON; raw contains raw model text.
        - ok=False: payload is empty; raw contains exception string.
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
        # Debug output helps diagnose local Ollama issues (connection, timeout, invalid JSON, etc.).
        print("LLM ERROR:", repr(e))
        return False, {}, str(e)

# ---------------------------------------------------------------------------
# Ollama Warmup (HTTP endpoint)
# ---------------------------------------------------------------------------

@app.get("/ollama-warmup")
def ollama_warmup():
    """
    Manual warmup endpoint.

    Useful when running demos:
    - Hit /ollama-warmup after starting Ollama to ensure the model responds.
    - Returns success/failure plus the validated result (if available).
    """
    msgs = [
        {"role": "system", "content": 'Return STRICT JSON: {"reply":"ok","actions":[]}'},
        {"role": "user", "content": "warmup"},
    ]
    ok, payload, err = call_llm(msgs)
    return jsonify({"ok": ok, "error": err, "result": payload})

# ---------------------------------------------------------------------------
# LLM test endpoint
# ---------------------------------------------------------------------------

@app.get("/llm-test")
def llm_test():
    """
    Quick sanity check endpoint.

    Purpose:
    - Verifies the LLM endpoint is reachable.
    - Verifies strict JSON output format + schema validation.
    - Provides fallback output if LLM fails.

    Returns:
        JSON object with either the model's structured response
        or the rule-based fallback response.
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
    Convert a user message into structured WebGIS actions.

    Request body (JSON):
        {
          "message": "find parking near Karlsruhe Hbf",
          "center": { "lat": 48.99, "lon": 8.40 }   # optional (current map center)
        }

    Query parameter:
        mode=auto|llm|fallback
        - auto (default): try LLM, fallback if LLM fails.
        - llm: fail hard if LLM fails (no fallback).
        - fallback: always use rule-based fallback (useful for debugging/demos).

    Response (JSON):
        { "reply": "...", "actions": [ ... ], "meta": { ... } }

    Meta field:
    - Includes request_id, decision_source, schema validity, action types, latency, etc.
    - Useful for evaluation and explainability in your thesis.
    """
    body = request.get_json(force=True) or {}
    msg = (body.get("message") or "").strip()
    center = body.get("center") or {}
    
    mode = request.args.get("mode", "auto")  # auto | llm | fallback

    if not msg:
        return jsonify({"reply": "Please type a message.", "actions": [], "meta": {"decision_source": "system"}})

    # Request tracking + latency measurement (useful for evaluation results)
    request_id = str(uuid.uuid4())[:8]
    t0 = time.time()

    # Provide map context to the model: it can reason about "near me" / "here" etc.
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

    # -------------------------------
    # LLM path: schema-valid JSON returned
    # -------------------------------
    if ok:
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

    # -------------------------------
    # LLM-only mode: DO NOT fallback (useful when debugging Ollama failures)
    # -------------------------------
    if mode == "llm":
        return jsonify({
            "ok": False,
            "decision_source": "ollama",
            "error": err,
            "latency_ms": dt_ms
        }), 500

    # -------------------------------
    # Auto mode (default) OR forced fallback mode
    # -------------------------------
    fb = rule_fallback(msg, center)

    # Validate fallback output too (defensive programming).
    # If fallback fails schema validation, return a minimal safe response.
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
        "llm_error": err,
        "latency_ms": dt_ms,
        "action_types": [a.get("type") for a in (fb.get("actions") or []) if isinstance(a, dict)],
    }

    return jsonify(fb)

# ---------------------------------------------------------------------------
# Entry point for local development
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Local development server only.
    # Production deployments should use a WSGI server (gunicorn/uwsgi) instead.
    app.run(host="127.0.0.1", port=5000, debug=True)
