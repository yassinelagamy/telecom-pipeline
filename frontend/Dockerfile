FROM python:3.12-alpine

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY static ./static

EXPOSE 8088
HEALTHCHECK --interval=15s --timeout=5s --retries=10 \
  CMD wget -q -O - http://127.0.0.1:8088/health || exit 1

CMD ["python", "server.py"]
