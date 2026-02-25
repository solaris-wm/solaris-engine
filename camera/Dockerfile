FROM nvidia/cuda:13.0.0-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HOME=/root \
    JAVA_BIN=/usr/lib/jvm/temurin-21-jre-amd64/bin/java \
    # VirtualGL display (GPU) - set to :0 for the host X server GPU access
    VGL_DISPLAY=egl \
    # Disable software rendering - use GPU
    __GLX_VENDOR_LIBRARY_NAME=nvidia

# Configure APT for better network reliability
RUN printf '%s\n' \
      'Acquire::Retries "5";' \
      'Acquire::By-Hash "yes";' \
      'Acquire::http::Pipeline-Depth "0";' \
      'Acquire::http::No-Cache "true";' \
      'Acquire::https::No-Cache "true";' \
      > /etc/apt/apt.conf.d/99network-tuning

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        fluxbox \
        novnc \
        websockify \
        ffmpeg \
        curl \
        wget \
        gnupg \
        ca-certificates \
        fonts-dejavu-core \
        libxi6 \
        libxrender1 \
        libxtst6 \
        libxrandr2 \
        xdotool \
        libxv1 \
        libglu1-mesa \
        libegl1 \
        libgl1 \
        python3 \
        python3-pip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install VirtualGL for GPU-accelerated rendering on virtual display
RUN curl -fsSL -o /tmp/virtualgl.deb \
    https://github.com/VirtualGL/virtualgl/releases/download/3.1.1/virtualgl_3.1.1_amd64.deb && \
    dpkg -i /tmp/virtualgl.deb || apt-get install -f -y && \
    rm /tmp/virtualgl.deb

# Install Java 21 (Temurin JRE)
RUN wget -O - https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/trusted.gpg.d/adoptium.gpg && \
    echo "deb [signed-by=/etc/apt/trusted.gpg.d/adoptium.gpg] https://packages.adoptium.net/artifactory/deb jammy main" \
        > /etc/apt/sources.list.d/adoptium.list && \
    apt-get update && \
    apt-get install -y temurin-21-jre && \
    rm -rf /var/lib/apt/lists/*
    
# Install Python dependencies
RUN pip3 install --no-cache-dir \
    minecraft-launcher-lib==6.5 \
    requests==2.31.0

WORKDIR /app

# Copy application scripts
COPY entrypoint.sh /app/entrypoint.sh
COPY launch_minecraft.py /app/launch_minecraft.py

RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
