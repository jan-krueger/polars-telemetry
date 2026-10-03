# Development image only; the package ships as a pure-Python wheel.
ARG PYTHON_VERSION=3.12
FROM python:${PYTHON_VERSION}-slim

# The uv that writes uv.lock: older ones cannot read it, nor a relative
# exclude-newer such as "7 days".
COPY --from=ghcr.io/astral-sh/uv:0.12.21 /uv /uvx /bin/

# The environment lives outside /workspace: a devcontainer mounts the project
# there, and must not overwrite the host's own .venv.
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Bytecode the host left in the mounted project names host paths, and
    # pytest would reuse it; the container keeps its own elsewhere.
    PYTHONPYCACHEPREFIX=/tmp/pycache

WORKDIR /workspace

# Dependency layer first so source edits do not invalidate it.
COPY pyproject.toml uv.lock* README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project

COPY . .
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --inexact

# Last, so no sync puts the locked polars back. Pin a specific polars to test one matrix cell:
#   docker build --build-arg POLARS_VERSION=1.44.1 .
ARG POLARS_VERSION=""
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ -n "$POLARS_VERSION" ]; then uv pip install "polars==${POLARS_VERSION}"; fi

CMD ["bash"]
