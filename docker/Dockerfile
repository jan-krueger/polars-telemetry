# Development image only; the package ships as a pure-Python wheel.
ARG PYTHON_VERSION=3.12
FROM python:${PYTHON_VERSION}-slim

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /bin/

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /workspace

# Dependency layer first so source edits do not invalidate it.
COPY pyproject.toml uv.lock* README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project 2>/dev/null || uv sync --no-install-project

# Pin a specific polars to test one matrix cell:
#   docker build --build-arg POLARS_VERSION=1.44.1 .
ARG POLARS_VERSION=""
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ -n "$POLARS_VERSION" ]; then uv pip install "polars==${POLARS_VERSION}"; fi

COPY . .
RUN --mount=type=cache,target=/root/.cache/uv uv sync --no-editable --inexact || true

CMD ["bash"]
