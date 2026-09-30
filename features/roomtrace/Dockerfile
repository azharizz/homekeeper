FROM python:3.11-slim-bookworm
ARG COMPUTE_PROFILE=cpu
WORKDIR /app/features/roomtrace
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libgl1 git && rm -rf /var/lib/apt/lists/*
COPY requirements*.txt ./
RUN if [ "$COMPUTE_PROFILE" = cpu ]; then pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.14.0 torchvision==0.29.0; fi
RUN if [ "$COMPUTE_PROFILE" = cuda ]; then pip install --no-cache-dir -r requirements-cuda.txt; else pip install --no-cache-dir -r requirements.txt; fi
RUN pip install --no-cache-dir --no-deps -r requirements-engines.txt
RUN useradd --uid 10001 --create-home roomtrace && mkdir data models && chown -R roomtrace:roomtrace /app
COPY --chown=roomtrace:roomtrace app/ app/
COPY --chown=roomtrace:roomtrace run.py ./
USER roomtrace
ENV ROOMTRACE_HOST=0.0.0.0 ROOMTRACE_PORT=8000 PYTHONUNBUFFERED=1 HF_HOME=/app/features/roomtrace/models
EXPOSE 8000
CMD ["python", "run.py"]
