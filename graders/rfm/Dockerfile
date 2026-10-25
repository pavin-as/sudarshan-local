# RFM research grader (D-044). CPU only; no RFM repository code inside; weights mounted read-only from D:\models\rfm\weights.
FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 HOME=/tmp \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 RFM_WEIGHTS=/weights
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
# PyTorch CPU build pinned to the RFM reference environment (2.5.1); weights are always loaded with weights_only=True.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchvision==0.20.1 \
 && pip install timm==1.0.24 pillow==11.1.0 numpy==1.26.4 fastapi==0.115.12 uvicorn==0.30.6 \
 && pip freeze > /opt/requirements.lock.txt
WORKDIR /app
COPY app.py /app/app.py
RUN useradd --uid 1000 --create-home appuser
USER appuser
EXPOSE 7861
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7861/health',timeout=8).status==200 else 1)" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "app.py"]
