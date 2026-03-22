#!/bin/bash
# =============================================================================
# install.sh - gordian-coder 오프라인 설치 스크립트 (Linux / macOS)
# 인터넷 연결 없이 Bun 설치, 의존성 복원, 프로젝트 빌드를 수행합니다.
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_BASE="${INSTALL_DIR:-$HOME/gordian-coder}"
BUN_INSTALL_DIR="${BUN_DIR:-$HOME/.bun}"

# -----------------------------------------------------------------------------
# 함수 정의
# -----------------------------------------------------------------------------

log_step() {
  echo ""
  echo "============================================"
  echo "  $1"
  echo "============================================"
}

log_info() {
  echo "  → $1"
}

log_ok() {
  echo "  [OK] $1"
}

log_error() {
  echo "  [ERROR] $1" >&2
}

detect_platform() {
  local os arch

  case "$(uname -s)" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    *)
      log_error "지원하지 않는 OS입니다: $(uname -s)"
      log_error "Linux 또는 macOS에서 실행해 주세요."
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *)
      log_error "지원하지 않는 아키텍처입니다: $(uname -m)"
      exit 1
      ;;
  esac

  echo "${os}-${arch}"
}

# -----------------------------------------------------------------------------
# 사전 체크
# -----------------------------------------------------------------------------

echo ""
echo "============================================"
echo "  gordian-coder 오프라인 설치"
echo "============================================"

# 필수 파일 존재 확인
if [ ! -d "$SCRIPT_DIR/bin" ] || [ ! -d "$SCRIPT_DIR/packages" ] || [ ! -d "$SCRIPT_DIR/project" ]; then
  log_error "오프라인 패키지 구조가 올바르지 않습니다."
  log_error "prepare.sh를 먼저 실행해 주세요."
  exit 1
fi

PLATFORM=$(detect_platform)
log_info "감지된 플랫폼: $PLATFORM"

# -----------------------------------------------------------------------------
# 1. Bun 설치
# -----------------------------------------------------------------------------

log_step "1/4 Bun 설치"

BUN_ARCHIVE="$SCRIPT_DIR/bin/bun-${PLATFORM}.zip"

if [ ! -f "$BUN_ARCHIVE" ]; then
  log_error "Bun 바이너리를 찾을 수 없습니다: $BUN_ARCHIVE"
  log_error "현재 플랫폼(${PLATFORM})용 바이너리가 포함되어 있는지 확인해 주세요."
  exit 1
fi

# 이미 설치된 bun이 있으면 확인
if command -v bun &>/dev/null; then
  EXISTING_BUN_VER=$(bun --version 2>/dev/null || echo "unknown")
  log_info "기존 Bun 발견: v${EXISTING_BUN_VER}"
  read -p "  Bun을 덮어쓰시겠습니까? (y/N): " OVERWRITE_BUN
  if [[ "$OVERWRITE_BUN" != "y" && "$OVERWRITE_BUN" != "Y" ]]; then
    log_info "기존 Bun 유지"
  else
    log_info "Bun 설치 진행..."
  fi
else
  OVERWRITE_BUN="y"
fi

if [[ "$OVERWRITE_BUN" == "y" || "$OVERWRITE_BUN" == "Y" ]]; then
  mkdir -p "$BUN_INSTALL_DIR/bin"

  # zip 해제 (bun-{platform}/bun 구조)
  TEMP_DIR=$(mktemp -d)
  unzip -q -o "$BUN_ARCHIVE" -d "$TEMP_DIR"

  # bun 바이너리 복사
  BUN_EXTRACTED=$(find "$TEMP_DIR" -name "bun" -type f | head -1)
  if [ -z "$BUN_EXTRACTED" ]; then
    log_error "아카이브에서 bun 바이너리를 찾을 수 없습니다."
    rm -rf "$TEMP_DIR"
    exit 1
  fi

  cp "$BUN_EXTRACTED" "$BUN_INSTALL_DIR/bin/bun"
  chmod +x "$BUN_INSTALL_DIR/bin/bun"
  rm -rf "$TEMP_DIR"

  log_ok "Bun 설치 완료: $BUN_INSTALL_DIR/bin/bun"
fi

# PATH에 bun 추가 (현재 세션)
export PATH="$BUN_INSTALL_DIR/bin:$PATH"
export BUN_INSTALL="$BUN_INSTALL_DIR"

# 셸 설정 파일에 PATH 추가
SHELL_NAME="$(basename "$SHELL" 2>/dev/null || echo "bash")"
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash) RC_FILE="$HOME/.bashrc" ;;
  *)    RC_FILE="$HOME/.profile" ;;
esac

BUN_PATH_LINE='export BUN_INSTALL="$HOME/.bun"'
BUN_PATH_LINE2='export PATH="$BUN_INSTALL/bin:$PATH"'

if ! grep -q '.bun/bin' "$RC_FILE" 2>/dev/null; then
  {
    echo ""
    echo "# bun (gordian-coder offline install)"
    echo "$BUN_PATH_LINE"
    echo "$BUN_PATH_LINE2"
  } >> "$RC_FILE"
  log_info "PATH 설정 추가됨: $RC_FILE"
else
  log_info "PATH 설정 이미 존재: $RC_FILE"
fi

# 설치 확인
log_info "Bun 버전: $(bun --version)"

# -----------------------------------------------------------------------------
# 2. 프로젝트 복사
# -----------------------------------------------------------------------------

log_step "2/4 프로젝트 설치"

if [ -d "$INSTALL_BASE" ]; then
  log_info "기존 설치 발견: $INSTALL_BASE"
  read -p "  덮어쓰시겠습니까? (y/N): " OVERWRITE_PROJECT
  if [[ "$OVERWRITE_PROJECT" != "y" && "$OVERWRITE_PROJECT" != "Y" ]]; then
    log_error "설치 중단. 다른 경로를 지정하려면 INSTALL_DIR 환경변수를 사용하세요."
    log_error "예: INSTALL_DIR=/opt/gordian-coder bash install.sh"
    exit 1
  fi
fi

mkdir -p "$INSTALL_BASE"
cp -R "$SCRIPT_DIR/project/." "$INSTALL_BASE/"

log_ok "프로젝트 복사 완료: $INSTALL_BASE"

# -----------------------------------------------------------------------------
# 3. 의존성 복원
# -----------------------------------------------------------------------------

log_step "3/4 의존성 복원"

NODE_MODULES_ARCHIVE="$SCRIPT_DIR/packages/node_modules.tar.gz"

if [ ! -f "$NODE_MODULES_ARCHIVE" ]; then
  log_error "node_modules 아카이브를 찾을 수 없습니다."
  exit 1
fi

log_info "node_modules 압축 해제 중..."
tar -xzf "$NODE_MODULES_ARCHIVE" -C "$INSTALL_BASE"

log_ok "의존성 복원 완료"

# -----------------------------------------------------------------------------
# 4. 빌드 및 링크
# -----------------------------------------------------------------------------

log_step "4/4 빌드 및 링크"

cd "$INSTALL_BASE"

log_info "프로젝트 빌드 중..."
bun run build

log_info "글로벌 링크 등록 중..."
bun link

log_ok "빌드 및 링크 완료"

# -----------------------------------------------------------------------------
# 설치 완료
# -----------------------------------------------------------------------------

echo ""
echo "============================================"
echo "  gordian-coder 설치 완료!"
echo "============================================"
echo ""
echo "  설치 경로: $INSTALL_BASE"
echo "  Bun 경로:  $BUN_INSTALL_DIR/bin/bun"
echo ""
echo "  사용 가능한 명령어:"
echo "    gdc --help      도움말"
echo "    gdc --init      Cline 훅 설치"
echo ""

if ! command -v gdc &>/dev/null; then
  echo "  ※ 셸을 재시작하거나 아래 명령을 실행하세요:"
  echo "     source $RC_FILE"
  echo ""
fi
