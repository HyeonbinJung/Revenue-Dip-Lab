FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
COPY backend backend
COPY dist dist
EXPOSE 8000
CMD ["/opt/venv/bin/uvicorn","backend.app:app","--host","0.0.0.0","--port","8000"]
