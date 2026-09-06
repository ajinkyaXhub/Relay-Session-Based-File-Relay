import os
import sys
import time
import socket
import tempfile
import shutil
import atexit
import threading
import zipfile
import io
import uuid
import secrets
import mimetypes
import argparse
import webbrowser
from datetime import datetime
from flask import Flask, render_template, request, send_file, redirect, url_for, jsonify, abort, session as flask_session
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# App Configuration
app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", secrets.token_hex(32))

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", 5000))
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
SESSION_TIMEOUT_MINUTES = int(os.getenv("SESSION_TIMEOUT_MINUTES", 20))
MAX_CONTENT_LENGTH_MB = int(os.getenv("MAX_CONTENT_LENGTH_MB", 250))
ENABLE_SESSION_PIN = os.getenv("ENABLE_SESSION_PIN", "false").lower() in ("true", "1", "yes")
OPEN_BROWSER = os.getenv("OPEN_BROWSER", "false").lower() in ("true", "1", "yes")

app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH_MB * 1024 * 1024

# ------------------------------------------------------------------------------
# In-Memory Session Registry
# Note: Designed for single-instance, single-process deployment (1 Gunicorn worker
# with multiple threads, e.g. `workers = 1`, `threads = 8`).
#
# IMPORTANT FOR HOSTED PLATFORMS (Render / Railway):
# Deploy this service with strictly 1 replica / 1 instance and NO horizontal autoscaling.
#
# Horizontal Scaling Path:
# If scaling across multiple instances or multiple Gunicorn processes:
# 1. Move `SESSIONS` registry to a shared in-memory store like Redis (e.g. Upstash Redis
#    available on Render / Railway).
# 2. Store files in shared S3 / Cloudflare R2 object storage or an attached shared volume
#    rather than local ephemeral temp directories.
# ------------------------------------------------------------------------------
SESSIONS = {}
sessions_lock = threading.Lock()

def get_local_ip():
    """Detect LAN IP address for QR code and local network access."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Does not actually create an external connection, used to select local interface
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

def get_session_url(session_id):
    """Constructs the full shareable URL for a session.
    
    In production (Render/Railway), uses PUBLIC_BASE_URL if configured.
    Falls back to local LAN IP detection only in local/offline environments.
    """
    if PUBLIC_BASE_URL:
        return f"{PUBLIC_BASE_URL}/s/{session_id}"

    local_ip = get_local_ip()
    port_str = f":{PORT}" if PORT not in (80, 443) else ""
    return f"http://{local_ip}{port_str}/s/{session_id}"

def format_file_size(size_bytes):
    """Format bytes into human-readable size string."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.1f} {unit}" if unit != 'B' else f"{int(size_bytes)} B"
        size_bytes /= 1024.0
    return f"{size_bytes:.1f} PB"

def is_safe_path(base_dir, path, follow_symlinks=True):
    """Path traversal prevention check."""
    if follow_symlinks:
        matchpath = os.path.realpath(path)
        basepath = os.path.realpath(base_dir)
    else:
        matchpath = os.path.abspath(path)
        basepath = os.path.abspath(base_dir)
    return basepath == os.path.commonpath((basepath, matchpath))

# ------------------------------------------------------------------------------
# Session Management Functions
# ------------------------------------------------------------------------------
def create_session():
    """Creates a new isolated session with its own temp folder and capability tokens."""
    session_id = uuid.uuid4().hex
    temp_dir = tempfile.mkdtemp(prefix=f"session_{session_id[:8]}_")
    now = time.time()
    expires_at = now + (SESSION_TIMEOUT_MINUTES * 60)
    csrf_token = secrets.token_hex(16)
    pin = f"{secrets.randbelow(9000) + 1000}" if ENABLE_SESSION_PIN else None

    session_data = {
        "id": session_id,
        "folder": temp_dir,
        "created_at": now,
        "expires_at": expires_at,
        "csrf_token": csrf_token,
        "pin": pin,
        "files": {},  # file_id -> file_meta
        "verified_pins": set()  # Client IPs or tokens that passed PIN check
    }

    with sessions_lock:
        SESSIONS[session_id] = session_data

    return session_data

def get_session(session_id):
    """Retrieves session by ID if it exists and has not expired."""
    now = time.time()
    with sessions_lock:
        session_data = SESSIONS.get(session_id)
        if not session_data:
            return None
        if now > session_data["expires_at"]:
            # Session expired, delete folder and entry
            _cleanup_session_dir(session_data["folder"])
            del SESSIONS[session_id]
            return None
        return session_data

def _cleanup_session_dir(folder_path):
    """Safely removes a session temporary folder from disk."""
    if not folder_path or not os.path.exists(folder_path):
        return

    def handle_remove_readonly(func, path, exc_info):
        import stat
        try:
            os.chmod(path, stat.S_IWRITE)
            func(path)
        except Exception:
            pass

    for attempt in range(3):
        try:
            if not os.path.exists(folder_path):
                break
            shutil.rmtree(folder_path, onexc=handle_remove_readonly)
        except TypeError:
            shutil.rmtree(folder_path, onerror=handle_remove_readonly)
        except Exception:
            shutil.rmtree(folder_path, ignore_errors=True)
        if not os.path.exists(folder_path):
            break
        time.sleep(0.05)

def terminate_session(session_id):
    """Immediately ends a session and deletes its files."""
    with sessions_lock:
        session_data = SESSIONS.pop(session_id, None)
    if session_data:
        _cleanup_session_dir(session_data["folder"])
        return True
    return False

# ------------------------------------------------------------------------------
# Background Session Sweeper & Server Cleanup
# ------------------------------------------------------------------------------
def sweep_expired_sessions():
    """Background worker that periodically deletes expired session folders."""
    while True:
        try:
            time.sleep(30)
            now = time.time()
            expired_folders = []
            with sessions_lock:
                expired_ids = [
                    sid for sid, s in SESSIONS.items()
                    if now > s["expires_at"]
                ]
                for sid in expired_ids:
                    expired_folders.append(SESSIONS[sid]["folder"])
                    del SESSIONS[sid]

            for folder in expired_folders:
                _cleanup_session_dir(folder)
        except Exception as e:
            app.logger.warning(f"Error in session sweeper thread: {e}")

def cleanup_all_sessions():
    """Executed on server shutdown to remove all active session directories."""
    with sessions_lock:
        for sid, s in SESSIONS.items():
            _cleanup_session_dir(s.get("folder"))
        SESSIONS.clear()

# Register atexit cleanup BEFORE starting application execution
atexit.register(cleanup_all_sessions)

# Start daemon sweeper thread
sweeper_thread = threading.Thread(target=sweep_expired_sessions, daemon=True)
sweeper_thread.start()

# ------------------------------------------------------------------------------
# Request Verification & Helpers
# ------------------------------------------------------------------------------
def check_pin_authorization(session_data):
    """Validates if client has entered the session PIN (if enabled)."""
    if not session_data.get("pin"):
        return True
    client_token = flask_session.get(f"pin_auth_{session_data['id']}")
    return client_token == session_data["pin"]

@app.errorhandler(413)
def request_entity_too_large(error):
    if request.is_json or request.path.endswith("/upload"):
        return jsonify({
            "error": f"File exceeds maximum allowed size of {MAX_CONTENT_LENGTH_MB} MB."
        }), 413
    return f"File exceeds maximum allowed size of {MAX_CONTENT_LENGTH_MB} MB.", 413

# ------------------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------------------

@app.route("/")
def index():
    """Root route creates a new isolated session and redirects to its dedicated URL."""
    session_data = create_session()
    return redirect(url_for("session_view", session_id=session_data["id"]))

@app.route("/s/<session_id>")
def session_view(session_id):
    """Renders the transfer interface for a specific isolated session."""
    session_data = get_session(session_id)
    if not session_data:
        return render_template("expired.html"), 404

    session_url = get_session_url(session_id)
    
    requires_pin = False
    if session_data.get("pin") and not check_pin_authorization(session_data):
        requires_pin = True

    remaining_seconds = max(0, int(session_data["expires_at"] - time.time()))

    return render_template(
        "session.html",
        session_id=session_id,
        session_url=session_url,
        csrf_token=session_data["csrf_token"],
        pin=session_data.get("pin"),
        requires_pin=requires_pin,
        remaining_seconds=remaining_seconds,
        max_upload_mb=MAX_CONTENT_LENGTH_MB,
        files=list(session_data["files"].values())
    )

@app.route("/s/<session_id>/qr.png")
def session_qr(session_id):
    """Generates and serves QR code on the fly in memory for the full session URL."""
    session_data = get_session(session_id)
    if not session_data:
        abort(404)

    import qrcode
    session_url = get_session_url(session_id)

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(session_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0f172a", back_color="#ffffff")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")

@app.route("/s/<session_id>/verify-pin", methods=["POST"])
def verify_pin(session_id):
    """Verifies PIN for PIN-protected sessions."""
    session_data = get_session(session_id)
    if not session_data:
        return jsonify({"error": "Session expired or not found."}), 404

    data = request.get_json(silent=True) or request.form
    entered_pin = (data.get("pin") or "").strip()

    if session_data.get("pin") and entered_pin == session_data["pin"]:
        flask_session[f"pin_auth_{session_id}"] = entered_pin
        return jsonify({"success": True})
    return jsonify({"error": "Incorrect PIN. Please try again."}), 403

@app.route("/s/<session_id>/files")
def session_files(session_id):
    """JSON API for real-time polling of files and session expiration countdown."""
    session_data = get_session(session_id)
    if not session_data:
        return jsonify({"error": "Session expired"}), 404

    now = time.time()
    remaining_seconds = max(0, int(session_data["expires_at"] - now))

    return jsonify({
        "session_id": session_id,
        "remaining_seconds": remaining_seconds,
        "expires_at": session_data["expires_at"],
        "files": list(session_data["files"].values())
    })

@app.route("/s/<session_id>/upload", methods=["POST"])
def upload_file(session_id):
    """Handles secure file uploads scoped exclusively to this session folder."""
    session_data = get_session(session_id)
    if not session_data:
        return jsonify({"error": "Session expired or not found."}), 404

    # CSRF Check
    submitted_csrf = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    if not submitted_csrf or submitted_csrf != session_data["csrf_token"]:
        return jsonify({"error": "Invalid or missing CSRF token."}), 403

    # PIN Check
    if session_data.get("pin") and not check_pin_authorization(session_data):
        return jsonify({"error": "PIN authorization required."}), 403

    if "file" not in request.files and "files" not in request.files and not request.files:
        return jsonify({"error": "No file part in request."}), 400

    uploaded_files = request.files.getlist("file") or request.files.getlist("files")
    saved_files = []

    for file_storage in uploaded_files:
        if not file_storage or not file_storage.filename:
            continue

        raw_name = file_storage.filename
        safe_name = secure_filename(raw_name)
        if not safe_name:
            safe_name = f"file_{secrets.token_hex(4)}"

        # Generate unique identifier and stored filename to prevent overwrites/collisions
        file_id = secrets.token_hex(8)
        stored_filename = f"{file_id}_{safe_name}"
        destination = os.path.join(session_data["folder"], stored_filename)

        # Path traversal verification
        if not is_safe_path(session_data["folder"], destination):
            return jsonify({"error": "Security error: Path traversal detected."}), 400

        file_storage.save(destination)
        file_size = os.path.getsize(destination)

        # Detect MIME and determine if image for preview
        mime_type, _ = mimetypes.guess_type(raw_name)
        is_image = bool(mime_type and mime_type.startswith("image/"))

        file_meta = {
            "id": file_id,
            "filename": stored_filename,
            "display_name": raw_name,
            "size_bytes": file_size,
            "size_formatted": format_file_size(file_size),
            "uploaded_at": datetime.now().strftime("%I:%M %p"),
            "is_image": is_image,
            "mime_type": mime_type or "application/octet-stream",
            "download_url": url_for("download_file", session_id=session_id, file_id=file_id)
        }

        session_data["files"][file_id] = file_meta
        saved_files.append(file_meta)

    return jsonify({
        "success": True,
        "message": f"Successfully uploaded {len(saved_files)} file(s).",
        "files": saved_files
    })

@app.route("/s/<session_id>/download/<file_id>")
def download_file(session_id, file_id):
    """Serves a file strictly from the session directory with original download name."""
    session_data = get_session(session_id)
    if not session_data:
        return render_template("expired.html"), 404

    # PIN Check
    if session_data.get("pin") and not check_pin_authorization(session_data):
        return redirect(url_for("session_view", session_id=session_id))

    file_meta = session_data["files"].get(file_id)
    if not file_meta:
        abort(404)

    file_path = os.path.join(session_data["folder"], file_meta["filename"])

    if not is_safe_path(session_data["folder"], file_path) or not os.path.isfile(file_path):
        abort(404)

    # If it's an inline image preview request (e.g. ?preview=1), serve inline
    as_attachment = request.args.get("preview") != "1"

    return send_file(
        file_path,
        as_attachment=as_attachment,
        download_name=file_meta["display_name"],
        mimetype=file_meta["mime_type"]
    )

@app.route("/s/<session_id>/download-all")
def download_all(session_id):
    """Creates a zip archive in memory (or outside session folder) and serves it."""
    session_data = get_session(session_id)
    if not session_data:
        return render_template("expired.html"), 404

    if session_data.get("pin") and not check_pin_authorization(session_data):
        return redirect(url_for("session_view", session_id=session_id))

    if not session_data["files"]:
        return "No files to download", 400

    # Build zip file into an in-memory buffer so session folder is never polluted
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zipf:
        for file_id, file_meta in session_data["files"].items():
            file_path = os.path.join(session_data["folder"], file_meta["filename"])
            if os.path.isfile(file_path) and is_safe_path(session_data["folder"], file_path):
                zipf.write(file_path, arcname=file_meta["display_name"])

    zip_buffer.seek(0)
    zip_name = f"transfer_{session_id[:8]}.zip"

    return send_file(
        zip_buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name=zip_name
    )

@app.route("/s/<session_id>/extend", methods=["POST"])
def extend_session(session_id):
    """Extends the lifetime of a session by 15 minutes."""
    session_data = get_session(session_id)
    if not session_data:
        return jsonify({"error": "Session expired or not found."}), 404

    # CSRF Check
    submitted_csrf = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    if not submitted_csrf or submitted_csrf != session_data["csrf_token"]:
        return jsonify({"error": "Invalid CSRF token."}), 403

    # Add 15 minutes, capped at max 2 hours from now
    additional_seconds = 15 * 60
    new_expires = min(time.time() + (120 * 60), session_data["expires_at"] + additional_seconds)
    session_data["expires_at"] = new_expires

    remaining_seconds = max(0, int(new_expires - time.time()))

    return jsonify({
        "success": True,
        "remaining_seconds": remaining_seconds,
        "expires_at": new_expires
    })

@app.route("/s/<session_id>/end", methods=["POST"])
def end_session(session_id):
    """Immediately ends session and purges files. Supports sendBeacon and AJAX."""
    session_data = get_session(session_id)
    if session_data:
        # Check CSRF if provided (sendBeacon may send empty or form-encoded)
        submitted_csrf = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
        if submitted_csrf and submitted_csrf != session_data["csrf_token"]:
            return jsonify({"error": "Invalid CSRF token."}), 403

        terminate_session(session_id)

    if request.is_json:
        return jsonify({"success": True})
    return redirect(url_for("index"))

# ------------------------------------------------------------------------------
# Optional Browser Auto-launch
# ------------------------------------------------------------------------------
def maybe_open_browser(host, port):
    """Opens browser automatically if configured via CLI flag or .env."""
    url = f"http://127.0.0.1:{port}"
    print(f"[*] Opening browser at {url}...")
    try:
        webbrowser.open(url)
    except Exception as e:
        print(f"[!] Could not launch browser: {e}")

# ------------------------------------------------------------------------------
# Entry Point
# ------------------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Relay - Local File Transfer App with Session Isolation")
    parser.add_argument("--port", type=int, default=PORT, help=f"Port to bind (default: {PORT})")
    parser.add_argument("--host", type=str, default=HOST, help=f"Host to bind (default: {HOST})")
    parser.add_argument("--open", action="store_true", help="Automatically open browser on start")
    args = parser.parse_args()

    active_port = args.port
    active_host = args.host
    should_open_browser = args.open or OPEN_BROWSER

    if should_open_browser:
        threading.Timer(1.2, maybe_open_browser, args=(active_host, active_port)).start()

    local_ip = get_local_ip()
    print("=" * 60)
    print(" Relay - File Transfer App (Session Isolated) ")
    print("=" * 60)
    print(f" * Local Address:   http://127.0.0.1:{active_port}")
    if PUBLIC_BASE_URL:
        print(f" * Public Address:  {PUBLIC_BASE_URL}")
    else:
        print(f" * Network Address: http://{local_ip}:{active_port}")
    print(f" * Default Timeout: {SESSION_TIMEOUT_MINUTES} minutes")
    print(f" * Max Upload Size: {MAX_CONTENT_LENGTH_MB} MB")
    print("=" * 60)

    app.run(host=active_host, port=active_port, debug=False)
