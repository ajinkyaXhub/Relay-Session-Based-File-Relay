import os

# Gunicorn Production Configuration for Render / Railway
#
# IMPORTANT:
# - workers = 1 is MANDATORY for the in-memory session registry (SESSIONS dict).
#   Multiple worker processes would each have isolated memory spaces.
# - threads = 8 handles concurrent uploads, polling requests, and downloads
#   within the single process.
#
raw_port = os.environ.get("PORT", "").strip()
port = raw_port if raw_port.isdigit() else "5000"
bind = f"0.0.0.0:{port}"

workers = 1
threads = 8
worker_class = "gthread"
timeout = 120
keepalive = 5

accesslog = "-"
errorlog = "-"
loglevel = "info"
