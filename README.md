# Relay — Session-Based File Relay with Total Isolation

Relay is a secure, ephemeral peer-to-peer file transfer web app built with Flask. Anyone on the same network or accessing the public web link can scan a dynamic QR code or open a shareable link in their browser to upload and download files instantly, with zero setup and full per-transfer session isolation.

---

## Key Features & Architecture

- **Per-Transfer Session Isolation:** Each transfer creates a unique session with a UUID4 capability token and dedicated temporary folder (`tempfile.mkdtemp`). No shared global upload folder, and no cross-device data leaks.
- **Dynamic In-Memory QR Codes:** QR codes encode the complete session URL and are rendered on the fly in memory (`/s/<session_id>/qr.png`), preventing race conditions and static file conflicts.
- **Public & Local URL Detection:** Supports `PUBLIC_BASE_URL` for cloud deployments (Render, Railway), seamlessly falling back to LAN IP detection (`http://<lan-ip>:5000`) for local Wi-Fi transfers.
- **Real-Time Live Updates:** Client interfaces poll `/s/<session_id>/files` every 2.5 seconds, immediately showing incoming files on all connected devices without full page refreshes.
- **Drag-and-Drop with Progress Bars:** Smooth multi-file upload queue powered by `XMLHttpRequest` featuring real-time upload percentage, file sizes, and animated progress bars.
- **Automatic & Manual Session Cleanup:**
  - Background sweeper thread periodically (every 30s) prunes expired sessions and removes their directories from disk.
  - An `atexit` hook guarantees all active session directories are purged upon server shutdown.
  - "End Session" button allows users to immediately wipe files from disk on demand.
  - Live countdown timer with "+15 Mins" extension capability.
- **Safe Single & Batch Downloads:**
  - Individual downloads preserve original filenames and prevent path traversal.
  - "Download All (.zip)" builds an archive outside the session folder (via in-memory buffer) so it never pollutes the upload directory.
- **Security Hardened:**
  - Filename sanitization via `secure_filename()` with collision-proof token prefixes.
  - Request body size cap via `MAX_CONTENT_LENGTH_MB`.
  - CSRF validation tokens per session.
  - Optional 4-digit PIN protection (`ENABLE_SESSION_PIN=true`).

---

## Deployment Target: Render or Railway (Not Vercel)

> [!CAUTION]
> **Why this app does NOT run on Vercel:**
> This application depends on:
> 1. A **persistent, long-running Python process** (for in-memory state and the background cleanup sweeper).
> 2. A **writable local filesystem** (`tempfile.mkdtemp`) to isolate session folders.
> 3. **Shared in-memory state** across concurrent requests (uploads, polling, and downloads).
>
> Vercel's serverless functions run in ephemeral, isolated containers with no shared memory, no background threads, short execution timeouts, and a read-only filesystem outside `/tmp`.
>
> **Target a persistent container platform instead:** [Render](https://render.com) or [Railway](https://railway.app).

---

### Deployment Setup (Zero-Config)

The repository includes ready-to-deploy configuration:
- `Procfile`: Declares `web: gunicorn app:app`
- `gunicorn.conf.py`: Sets `workers = 1`, `threads = 8`, and dynamic `$PORT` binding
- `render.yaml`: Render Blueprint definition
- `railway.json`: Railway Nixpacks definition

### 1. Deploying on Render
1. Connect your GitHub repository to **Render**.
2. Create a **New Web Service** (or use **New > Blueprint** with `render.yaml`).
3. Set the following:
   - **Environment:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app`
   - **Plan:** Free or Starter (Set **Instances: 1**, do not enable autoscaling)
4. Under **Environment Variables**, add:
   - `PUBLIC_BASE_URL`: Your Render service URL (e.g. `https://relay.onrender.com`)
   - `SESSION_TIMEOUT_MINUTES`: `20` (optional)
   - `MAX_CONTENT_LENGTH_MB`: `250` (optional)
   - `SECRET_KEY`: A strong random string (e.g. run `python -c "import secrets; print(secrets.token_hex(32))"`)

### 2. Deploying on Railway
1. Click **New Project** > **Deploy from GitHub Repo** in Railway.
2. Railway automatically detects `railway.json`, `Procfile`, and `requirements.txt`.
3. In your Railway service settings under **Variables**, add:
   - `PUBLIC_BASE_URL`: Your Railway domain (e.g. `https://relay.up.railway.app`)
   - `SECRET_KEY`: A strong random string
4. Under service **Settings**, ensure replicas are set to **1** (single instance).

---

### Critical Deployment Notes

#### 1. Single-Instance / In-Memory Registry Requirement
- Render and Railway can run multiple instances/replicas depending on the plan. The current in-memory `SESSIONS` registry requires that all requests route to the **same process**.
- **Requirement:** Keep your service deployed to **1 instance** with **no autoscaling**.
- **Gunicorn Concurrency:** In `gunicorn.conf.py`, `workers = 1` and `threads = 8` ensures that all concurrent uploads, polling requests, and downloads run within the same process and share the same in-memory `SESSIONS` registry without memory isolation bugs.

#### 2. Ephemeral Disk Caveat
- Local disk storage on Render and Railway containers is ephemeral and will reset when the container restarts or redeploys.
- Because this app handles temporary, short-lived file transfers (with default 20-minute expiry), ephemeral storage is ideal. Files are intended to be automatically cleaned up anyway.

#### 3. Horizontal Scaling Path (Redis + Object Storage)
If you wish to scale this application horizontally across multiple container instances in the future:
1. **Shared State:** Replace `SESSIONS = {}` with a Redis client (such as [Upstash Redis](https://upstash.com/), which is available with one click on both Render and Railway).
2. **Shared Storage:** Replace `tempfile.mkdtemp` with an S3-compatible object store (e.g. AWS S3, Cloudflare R2, or an attached persistent volume).

---

## Configuration (`.env`)

Configuration is managed via environment variables. Copy `.env.example` to `.env` to customize settings:

```bash
cp .env.example .env
```

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PUBLIC_BASE_URL` | *(empty)* | Public production URL (e.g. `https://your-app.onrender.com`). If unset, falls back to local LAN IP detection. |
| `HOST` | `0.0.0.0` | IP address to bind server |
| `PORT` | `5000` | Port to bind server (automatically provided by Render / Railway) |
| `SESSION_TIMEOUT_MINUTES` | `20` | Session lifetime in minutes before auto-cleanup |
| `MAX_CONTENT_LENGTH_MB` | `250` | Maximum file upload size limit in MB |
| `ENABLE_SESSION_PIN` | `false` | If `true`, requires devices to enter a 4-digit PIN |
| `OPEN_BROWSER` | `false` | Automatically launch default browser on startup (local dev only) |
| `SECRET_KEY` | *(auto-generated)* | Flask session secret key |

---

## Local Development

### 1. Install Dependencies
Ensure Python 3.10+ is installed:
```bash
pip install -r requirements.txt
```

### 2. Start the Server Locally
Standard local dev server:
```bash
python app.py
```

Run with automatic browser opening:
```bash
python app.py --open
```

Run with production WSGI server (Gunicorn):
```bash
gunicorn app:app
```

Run on custom port:
```bash
python app.py --port 8080 --host 0.0.0.0
```

### 3. Using the App
1. Open the local link in your browser: `http://127.0.0.1:5000` (or your public Render/Railway URL).
2. Scan the displayed QR code with your mobile camera.
3. Drag and drop or browse files on either device.
4. Watch files appear in real-time on both screens!
5. Click **Download** or **Download All (.zip)** to save files.
