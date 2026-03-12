#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Project Sid — Setup Script
# Sets up Minecraft server, Ollama, and required models
# ═══════════════════════════════════════════════════════════════

set -e

echo "╔══════════════════════════════════════════════╗"
echo "║   Project Sid — Setup                        ║"
echo "╚══════════════════════════════════════════════╝"

# ── Colors ────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ── 1. Check Node.js ─────────────────────────────────────────
echo -e "\n${YELLOW}[1/5] Checking Node.js...${NC}"
if command -v node &> /dev/null; then
    NODE_VER=$(node -v)
    echo -e "${GREEN}✓ Node.js ${NODE_VER} found${NC}"
else
    echo -e "${RED}✗ Node.js not found. Install Node.js >= 18: https://nodejs.org${NC}"
    exit 1
fi

# ── 2. Install npm dependencies ──────────────────────────────
echo -e "\n${YELLOW}[2/5] Installing npm dependencies...${NC}"
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# ── 3. Check/Install Ollama ──────────────────────────────────
echo -e "\n${YELLOW}[3/5] Checking Ollama...${NC}"
if command -v ollama &> /dev/null; then
    echo -e "${GREEN}✓ Ollama found${NC}"
else
    echo -e "${YELLOW}Installing Ollama...${NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "Please install Ollama from: https://ollama.com/download/mac"
        echo "Or: brew install ollama"
    else
        curl -fsSL https://ollama.com/install.sh | sh
    fi
fi

# ── 4. Pull LLM models ──────────────────────────────────────
echo -e "\n${YELLOW}[4/5] Pulling LLM models...${NC}"

# Check if Ollama is running
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo -e "${YELLOW}Starting Ollama...${NC}"
    ollama serve &
    sleep 3
fi

echo "Pulling qwen3.5:9b (reasoning model)..."
ollama pull qwen3.5:9b

echo "Pulling nomic-embed-text (embedding model)..."
ollama pull nomic-embed-text

echo -e "${GREEN}✓ Models ready${NC}"

# ── 5. Setup Minecraft Server ────────────────────────────────
echo -e "\n${YELLOW}[5/5] Setting up Minecraft server...${NC}"
MC_DIR="./minecraft-server"

if [ ! -d "$MC_DIR" ]; then
    mkdir -p "$MC_DIR"
    cd "$MC_DIR"

    # Download Paper 1.20.4
    echo "Downloading Paper MC 1.20.4..."
    PAPER_URL="https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/496/downloads/paper-1.20.4-496.jar"
    curl -LO "$PAPER_URL" -o paper.jar 2>/dev/null || {
        echo -e "${YELLOW}Could not auto-download Paper. Please download manually:${NC}"
        echo "  https://papermc.io/downloads/paper"
        echo "  Place paper.jar in ./minecraft-server/"
    }

    # Create server.properties
    cat > server.properties << 'EOF'
# Project Sid — Minecraft Server Configuration
server-port=25565
online-mode=false
max-players=30
view-distance=8
simulation-distance=8
spawn-protection=0
difficulty=normal
gamemode=survival
pvp=false
allow-flight=true
enable-command-block=true
motd=Project Sid - AI Civilization
level-name=sid-world
level-type=minecraft:normal
max-tick-time=-1
EOF

    # Accept EULA
    echo "eula=true" > eula.txt

    cd ..
    echo -e "${GREEN}✓ Minecraft server configured in ./minecraft-server/${NC}"
else
    echo -e "${GREEN}✓ Minecraft server directory exists${NC}"
fi

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "To run the simulation:"
echo "  1. Start Minecraft server:  cd minecraft-server && java -jar paper*.jar"
echo "  2. Start Ollama (if not running): ollama serve"
echo "  3. Start simulation:        npm run dev"
echo "  4. Open dashboard:          http://localhost:3001"
echo ""
echo "Options:"
echo "  npm run dev -- --agents 5     # Run with 5 agents"
echo "  npm run dev -- --log debug    # Debug logging"
echo "═══════════════════════════════════════════════"
