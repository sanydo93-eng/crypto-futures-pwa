FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MPLCONFIGDIR=/tmp/matplotlib

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot ./bot
COPY web ./web

RUN useradd --create-home --uid 10001 bot && mkdir -p /data && chown bot:bot /data
USER bot

VOLUME ["/data"]
EXPOSE 8080

CMD ["python", "-m", "bot.main"]
