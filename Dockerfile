FROM node:22

RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential python3 python3-pip python3-venv python-is-python3 pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    libx11-dev libxi-dev libxext-dev libxrandr-dev libxinerama-dev libxcursor-dev \
    libgl1-mesa-dev libglu1-mesa-dev libegl1-mesa-dev libgles2-mesa-dev \
    libgl1-mesa-dri libegl1 libgles2 libgbm1 libosmesa6 \
    xvfb xauth x11-utils mesa-utils \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:99
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV GALLIUM_DRIVER=llvmpipe
ENV MESA_GL_VERSION_OVERRIDE=3.3
ENV MESA_GLSL_VERSION_OVERRIDE=330
# (Optional) library lookup hints
ENV LIBGL_DRIVERS_PATH=/usr/lib/x86_64-linux-gnu/dri
ENV LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu:/usr/lib/x86_64-linux-gnu
ENV PKG_CONFIG_PATH="/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/lib/pkgconfig:/usr/share/pkgconfig"


# Helps some node-gyp flows, though the shim above is the key
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /usr/src/app

# Install dependencies first to leverage Docker layer caching
COPY requirements-docker.txt ./
RUN python -m pip install --upgrade pip setuptools wheel && \
    python -m pip install --no-cache-dir -r requirements-docker.txt
# Install all node deps (incl. github-pinned forks) from the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci
# Install prismarine-viewer-colalab from a local clone instead of as a git dep.
# npm builds git deps in an isolated temp dir (even under --ignore-scripts),
# where the viewer's floating webpack ^5 devDependency resolves to webpack
# 5.109.0 (2026-07-23) and breaks its install-time browser-bundle build with
# resolver ENOENT errors on @ljharb/tsconfig; no override from this repo can
# reach that temp dir. A local clone lets us pin webpack to 5.108.4. The sha is
# the one the lockfile pinned while the viewer was still a git dependency.
RUN set -eux; \
  git clone https://github.com/georgysavva/prismarine-viewer-colalab /opt/prismarine-viewer-colalab; \
  git -C /opt/prismarine-viewer-colalab checkout 4ed884d0c19f585efc12eeb9d80bada15d258b09; \
  cd /opt/prismarine-viewer-colalab; \
  npm pkg set devDependencies.webpack=5.108.4; \
  npm install; \
  cd /usr/src/app; \
  npm install /opt/prismarine-viewer-colalab
RUN set -eux; \
  PKG_DIR="node_modules/prismarine-viewer-colalab"; \
  mkdir -p "$PKG_DIR/public/textures/1.16.4/entity"; \
  cp -r "$PKG_DIR/assets/skins" "$PKG_DIR/public/textures/1.16.4/entity/"
# Copy the bot script
COPY . ./
# Use a deterministic display


RUN chmod +x controller/entrypoint.sh
RUN chmod +x controller/act_recorder/entrypoint.sh

# Reset the Node base image entrypoint so .sh scripts run as shell, not node
ENTRYPOINT []
CMD ["./controller/entrypoint.sh"]
