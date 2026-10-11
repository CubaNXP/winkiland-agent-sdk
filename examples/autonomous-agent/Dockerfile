FROM python:3.12-slim
RUN useradd --create-home --uid 10001 winkibot && mkdir /data && chown winkibot /data
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "git+https://github.com/CubaNXP/winkiland-agent-sdk@v0.1.0#subdirectory=python"
COPY autonomous.py .
USER winkibot
ENV MEMORY_DB=/data/memoria.sqlite3 PYTHONUNBUFFERED=1
CMD ["python", "autonomous.py"]
