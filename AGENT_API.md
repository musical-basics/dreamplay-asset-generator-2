# DreamPlay Asset Generator — Agent API Reference

This app is a Next.js pipeline for generating AI merchandise images.
All generated assets are stored in **Cloudflare R2** and indexed in **Supabase** (`asset_indexer` schema).

---

## Base URL

When running locally: `http://localhost:3000`
When deployed: set by your hosting provider.

---

## Authentication

All `/api/agent/` routes require an API key header:

```
x-api-key: <AGENT_API_KEY>
```

---

## Endpoints

### `POST /api/agent/generate`
Generate a new image and automatically save it to R2 + Supabase.

**Request:**
```json
{
  "prompt": "string (required)",
  "modelId": "string (optional, default: gemini-3.1-flash-image-preview)",
  "aspectRatio": "string (optional, default: 1:1, e.g. 4:5, 16:9, 9:16)",
  "campaignMode": "merch | product (optional, default: merch)",
  "refImageUrls": ["https://...r2.dev/product-images/... (optional, max 4)"],
  "formatLabel": "string (optional, e.g. Instagram Portrait)"
}
```

**Response:**
```json
{
  "success": true,
  "id": "1744213948000_agent_x3k2ab",
  "url": "https://pub-ae162277c7104eb2b558af08104deafc.r2.dev/generated/2026-04-09/....png",
  "prompt": "..."
}
```

---

### `POST /api/promote-generation`
Promote an approved generation into `asset_indexer.assets` (visible to dreamplay-media-indexer-2).

**Request:**
```json
{ "id": "<jobId from generate response>" }
```

**Response:**
```json
{ "success": true }
```

---

### `GET /api/product-images`
List all reference images available in the product image library (R2-backed).

**Response:**
```json
{
  "grouped": {
    "Different Angles": [
      { "path": "https://...r2.dev/product-images/...", "name": "hero.jpg", "type": "image" }
    ],
    "New Product Drafts/Hoodies": [ ... ]
  },
  "total": 136,
  "source": "r2"
}
```

Use these `path` values as `refImageUrls` in your generate call.

---

### `GET /api/media-library`
Query the full `asset_indexer.assets` library (all approved assets from indexer-2).

**Query params:** `limit`, `offset`, `subject`, `mediaType`, `finalStatus`, `search`, etc.

**Response:**
```json
{
  "assets": [ { "id": "...", "filePath": "...", "aiDescription": "...", ... } ],
  "total": 320,
  "stats": { "total": 936, "finals": 450, "highPriority": 23 }
}
```

---

## Asset Storage

| Store | Contents | Access |
|---|---|---|
| Cloudflare R2 `generated/` | AI-generated images | Public CDN URL |
| Cloudflare R2 `product-images/` | Reference/inspiration photos | Public CDN URL |
| Supabase `asset_indexer.merch_generations` | Metadata + R2 URLs for generations | Service role |
| Supabase `asset_indexer.product_image_catalog` | Metadata + R2 URLs for reference images | Service role |
| Supabase `asset_indexer.assets` | All promoted + indexed assets (shared with media-indexer-2) | Service role |

---

## Example Agent Flow

```python
import requests

BASE = "http://localhost:3000"
HEADERS = {"x-api-key": "dp-agent-key-2026", "Content-Type": "application/json"}

# 1. Browse reference images
refs = requests.get(f"{BASE}/api/product-images", headers=HEADERS).json()
hoodie_url = refs["grouped"]["New Product Drafts/Hoodies"][0]["path"]

# 2. Generate
result = requests.post(f"{BASE}/api/agent/generate", headers=HEADERS, json={
    "prompt": "DreamPlay hoodie worn by young pianist in moody studio lighting",
    "campaignMode": "merch",
    "aspectRatio": "4:5",
    "formatLabel": "Instagram Portrait",
    "refImageUrls": [hoodie_url]
}).json()

image_url = result["url"]   # R2 CDN URL, permanent
job_id    = result["id"]

# 3. Promote to asset library (optional — makes it visible in media-indexer-2)
requests.post(f"{BASE}/api/promote-generation", headers=HEADERS, json={"id": job_id})
```

---

## Available Models

| modelId | Description |
|---|---|
| `gemini-3.1-flash-image-preview` | Best quality (default) |
| `gemini-2.5-flash-image` | Fast flash image |
| `imagen-4.0-generate-001` | Imagen 4 |
| `imagen-4.0-ultra-generate-001` | Imagen 4 Ultra (highest quality) |
| `imagen-4.0-fast-generate-001` | Imagen 4 Fast |
