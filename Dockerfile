FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    MINER_AUTOSTART=1 \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system miner \
    && useradd --system --gid miner --home-dir /app miner

COPY --chown=miner:miner miner.py /app/miner.py

USER miner

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=12s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.getenv('PORT','8080') + '/health', timeout=3).read()" || exit 1

CMD ["python", "-u", "/app/miner.py"]
