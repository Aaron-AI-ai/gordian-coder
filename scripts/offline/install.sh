#!/bin/bash
# =============================================================================
# install.sh - gordian-coder 오프라인 설치 (Linux / macOS)
#
#   tar -xzf gordian-coder-offline-<version>.tar.gz
#   cd offline-package && bash install.sh
#
# 인터넷 연결 없이 Bun 설치 → 빌드 산출물 배치 → 글로벌 링크를 수행합니다.
# dist는 의존성이 번들된 산출물이라 대상 서버에서 빌드하지 않습니다.
#
# 환경변수:
#   INSTALL_DIR  설치 경로 (기본 ~/gordian-coder)
#   BUN_DIR      Bun 설치 경로 (기본 ~/.bun)
#   FORCE=1      기존 설치 경로를 확인 없이 덮어쓰기 (재설치/업그레이드 자동화용)
#   SKIP_BUN=1   Bun 설치 건너뜀 (대상 서버에 이미 Bun이 있는 경우)
#   FORCE_BUN=1  기존 Bun을 확인 없이 번들된 버전으로 덮어쓰기
#
# FORCE는 Bun에 영향을 주지 않습니다 — 기존 Bun은 FORCE_BUN 없이는 교체되지 않습니다.
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

# 기본값 no. 비대화형(EOF)에서도 no —
# `read`의 EOF 실패가 set -e로 스크립트를 죽이지 않도록 `|| true`가 필요하다.
# 강제 yes는 호출부에서 각자의 환경변수로 판단한다 (FORCE가 Bun까지 덮어쓰면 안 되므로).
confirm() {
  local answer
  read -r -p "  $1 (y/N): " answer || true
  [[ "$answer" == "y" || "$answer" == "Y" ]]
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

if [ ! -d "$SCRIPT_DIR/bin" ] || [ ! -d "$SCRIPT_DIR/project/dist" ]; then
  log_error "오프라인 패키지 구조가 올바르지 않습니다 (bin/, project/dist/ 필요)."
  log_error "압축을 푼 offline-package 디렉토리 안에서 실행해 주세요."
  exit 1
fi

PLATFORM=$(detect_platform)
log_info "감지된 플랫폼: $PLATFORM"

# -----------------------------------------------------------------------------
# 1. Bun 설치
# -----------------------------------------------------------------------------

log_step "1/3 Bun 설치"

BUN_ARCHIVE="$SCRIPT_DIR/bin/bun-${PLATFORM}.zip"
HAS_BUN=$(command -v bun &>/dev/null && echo true || echo false)

# 설치 여부 결정. 기존 Bun은 명시적 동의 없이는 건드리지 않는다.
if [ "${SKIP_BUN:-}" = "1" ]; then
  INSTALL_BUN=false
  log_info "SKIP_BUN=1 — Bun 설치 건너뜀"
elif [ "$HAS_BUN" = false ]; then
  INSTALL_BUN=true
elif [ "${FORCE_BUN:-}" = "1" ]; then
  INSTALL_BUN=true
  log_info "기존 Bun v$(bun --version) → FORCE_BUN=1, 덮어씀"
else
  log_info "기존 Bun 발견: v$(bun --version 2>/dev/null || echo unknown)"
  if confirm "Bun을 덮어쓰시겠습니까?"; then
    INSTALL_BUN=true
  else
    INSTALL_BUN=false
    log_info "기존 Bun 유지"
  fi
fi

if [ "$INSTALL_BUN" = false ] && [ "$HAS_BUN" = false ]; then
  log_error "Bun이 없는데 설치를 건너뛰었습니다. Bun 없이는 실행할 수 없습니다."
  exit 1
fi

# 아카이브 확인은 실제로 설치할 때만 — 이미 Bun이 있으면 해당 플랫폼 zip이 없어도 무방.
if [ "$INSTALL_BUN" = true ] && [ ! -f "$BUN_ARCHIVE" ]; then
  log_error "Bun 바이너리를 찾을 수 없습니다: $BUN_ARCHIVE"
  log_error "현재 플랫폼(${PLATFORM})용 바이너리가 포함되어 있는지 확인해 주세요."
  log_error "이미 Bun이 설치된 서버라면 SKIP_BUN=1 로 건너뛸 수 있습니다."
  exit 1
fi

if [ "$INSTALL_BUN" = true ]; then
  mkdir -p "$BUN_INSTALL_DIR/bin"

  # zip 해제 (bun-{platform}/bun 구조)
  TEMP_DIR=$(mktemp -d)
  unzip -q -o "$BUN_ARCHIVE" -d "$TEMP_DIR"

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

SHELL_NAME="$(basename "$SHELL" 2>/dev/null || echo "bash")"
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash) RC_FILE="$HOME/.bashrc" ;;
  *)    RC_FILE="$HOME/.profile" ;;
esac

# 기존 Bun을 그대로 쓰는 경우엔 PATH도 rc 파일도 건드리지 않는다.
if [ "$INSTALL_BUN" = true ]; then
  export PATH="$BUN_INSTALL_DIR/bin:$PATH"
  export BUN_INSTALL="$BUN_INSTALL_DIR"

  if ! grep -q "$BUN_INSTALL_DIR/bin" "$RC_FILE" 2>/dev/null; then
    {
      echo ""
      echo "# bun (gordian-coder offline install)"
      echo "export BUN_INSTALL=\"$BUN_INSTALL_DIR\""
      echo 'export PATH="$BUN_INSTALL/bin:$PATH"'
    } >> "$RC_FILE"
    log_info "PATH 설정 추가됨: $RC_FILE"
  else
    log_info "PATH 설정 이미 존재: $RC_FILE"
  fi
fi

log_info "Bun 버전: $(bun --version)"

# -----------------------------------------------------------------------------
# 2. 빌드 산출물 배치
# -----------------------------------------------------------------------------

log_step "2/3 빌드 산출물 배치"

if [ -d "$INSTALL_BASE" ]; then
  log_info "기존 설치 발견: $INSTALL_BASE"
  if [ "${FORCE:-}" != "1" ] && ! confirm "덮어쓰시겠습니까?"; then
    log_error "설치 중단. 다른 경로는 INSTALL_DIR, 자동 덮어쓰기는 FORCE=1을 사용하세요."
    log_error "예: INSTALL_DIR=/opt/gordian-coder bash install.sh"
    exit 1
  fi
  # 이전 버전의 dist가 남지 않도록 제거
  rm -rf "$INSTALL_BASE/dist"
fi

mkdir -p "$INSTALL_BASE"
cp -R "$SCRIPT_DIR/project/." "$INSTALL_BASE/"

log_ok "설치 완료: $INSTALL_BASE"

# -----------------------------------------------------------------------------
# 3. 글로벌 링크
# -----------------------------------------------------------------------------

log_step "3/3 글로벌 링크"

cd "$INSTALL_BASE"
bun link

log_ok "링크 완료"

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
