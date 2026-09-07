#!/bin/bash
# =============================================================================
# prepare.sh - 오프라인 배포 아카이브 생성 (인터넷 되는 환경에서 실행)
#
#   빌드 → offline-package/ 구성 → tar.gz 압축
#
# 결과물 gordian-coder-offline-<version>.tar.gz 한 개만 대상 서버로 옮기면 됩니다.
#
# 환경변수:
#   BUN_VERSION  번들할 Bun 버전 (기본 1.3.6)
#   PLATFORMS    번들할 플랫폼 (기본 5종 전체). 예: PLATFORMS="linux-x64"
#   SKIP_BUN=1   Bun 바이너리를 번들하지 않음 (대상 서버에 이미 Bun이 있는 경우)
#                → 설치 시에도 SKIP_BUN=1 로 실행해야 합니다.
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
OFFLINE_DIR="$PROJECT_ROOT/offline-package"

BUN_VERSION="${BUN_VERSION:-1.3.6}"

# ponytail: 기본은 전 플랫폼. 대상 서버가 정해져 있으면 PLATFORMS로 줄여서 용량 절약.
read -r -a PLATFORMS <<< "${PLATFORMS:-linux-x64 linux-aarch64 darwin-x64 darwin-aarch64 windows-x64}"

BUN_BASE_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"

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

# 아카이브 파일명을 구분하기 위한 밀리초 타임스탬프.
# GNU date는 %N을 주지만 BSD(macOS)는 아니라 대체 경로를 둔다.
timestamp() {
  local base ns ms
  base="$(date +%Y%m%d-%H%M%S)"
  ns="$(date +%N 2>/dev/null)"
  if [ ${#ns} -eq 9 ] && [ -z "${ns//[0-9]/}" ]; then
    ms="${ns:0:3}"
  else
    ms="$(python3 -c 'import time; print(f"{int(time.time()*1000)%1000:03d}")' 2>/dev/null || echo 000)"
  fi
  printf '%s-%s' "$base" "$ms"
}

download_file() {
  local url="$1"
  local dest="$2"

  if [ -f "$dest" ]; then
    log_info "이미 존재함: $(basename "$dest"), 스킵"
    return 0
  fi

  log_info "다운로드: $(basename "$dest")"
  if command -v curl &>/dev/null; then
    curl -fSL --progress-bar -o "$dest" "$url"
  elif command -v wget &>/dev/null; then
    wget -q --show-progress -O "$dest" "$url"
  else
    echo "ERROR: curl 또는 wget이 필요합니다." >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# 1. 빌드
# -----------------------------------------------------------------------------

log_step "1/5 프로젝트 빌드"

cd "$PROJECT_ROOT"
bash "$PROJECT_ROOT/scripts/build.sh"

VERSION=$(bun --print "require('./package.json').version")
log_ok "빌드 완료 (v${VERSION})"

# -----------------------------------------------------------------------------
# 2. 디렉토리 구조 생성
# -----------------------------------------------------------------------------

log_step "2/5 패키지 디렉토리 생성"

# ponytail: bin/은 남겨두고 project/만 비운다 — 받아둔 Bun zip을 재다운로드하지 않기 위해.
rm -rf "$OFFLINE_DIR/project"
mkdir -p "$OFFLINE_DIR"/{bin,project}

log_ok "$OFFLINE_DIR"

# -----------------------------------------------------------------------------
# 3. Bun 바이너리 다운로드
# -----------------------------------------------------------------------------

if [ "${SKIP_BUN:-}" = "1" ]; then
  log_step "3/5 Bun 번들 생략 (SKIP_BUN=1)"
  # bin/은 재다운로드를 피하려고 유지되는 캐시라, 여기서 비우지 않으면
  # 이전 실행에서 받아둔 zip이 그대로 아카이브에 딸려 들어간다.
  rm -rf "$OFFLINE_DIR/bin" && mkdir -p "$OFFLINE_DIR/bin"
  log_info "대상 서버에서도 SKIP_BUN=1 bash install.sh 로 실행해야 합니다."
  BUNDLED_BUN="번들 안 함 (SKIP_BUN=1)"
else
  log_step "3/5 Bun v${BUN_VERSION} 바이너리 다운로드"

  for platform in "${PLATFORMS[@]}"; do
    download_file "${BUN_BASE_URL}/bun-${platform}.zip" "$OFFLINE_DIR/bin/bun-${platform}.zip"
  done

  log_ok "플랫폼: ${PLATFORMS[*]}"
  BUNDLED_BUN="v${BUN_VERSION} (${PLATFORMS[*]})"
fi

# -----------------------------------------------------------------------------
# 4. 빌드 산출물 + 설치 스크립트 복사
# -----------------------------------------------------------------------------

log_step "4/5 배포 파일 복사"

# dist는 의존성이 번들된 자체 실행 가능한 산출물이라 node_modules도 소스도 필요 없다.
cp -R "$PROJECT_ROOT/dist" "$OFFLINE_DIR/project/dist"
cp "$PROJECT_ROOT/package.json" "$OFFLINE_DIR/project/package.json"

cp "$SCRIPT_DIR/install.sh" "$OFFLINE_DIR/install.sh"
cp "$SCRIPT_DIR/install.ps1" "$OFFLINE_DIR/install.ps1"
cp "$SCRIPT_DIR/install.bat" "$OFFLINE_DIR/install.bat"
# 제거 스크립트도 같이 넣는다 — 폐쇄망에서는 나중에 따로 받아올 수 없다.
cp "$SCRIPT_DIR/uninstall.sh" "$OFFLINE_DIR/uninstall.sh"
cp "$SCRIPT_DIR/uninstall.ps1" "$OFFLINE_DIR/uninstall.ps1"
chmod +x "$OFFLINE_DIR/uninstall.sh"
chmod +x "$OFFLINE_DIR/install.sh"

log_ok "dist + package.json + 설치 스크립트"

# -----------------------------------------------------------------------------
# 5. 압축
# -----------------------------------------------------------------------------

log_step "5/5 아카이브 생성"

# 실행할 때마다 새 파일이 생긴다 — 어느 시점 산출물인지 파일명만 보고 구분하려는 것.
# 옛 아카이브는 자동으로 지우지 않으니 주기적으로 정리할 것.
STAMP="$(timestamp)"
ARCHIVE="$PROJECT_ROOT/gordian-coder-offline-${VERSION}-${STAMP}.tar.gz"
tar -czf "$ARCHIVE" -C "$PROJECT_ROOT" offline-package

log_ok "$(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1))"

# -----------------------------------------------------------------------------
# 요약
# -----------------------------------------------------------------------------

cat <<EOF

============================================
  오프라인 아카이브 준비 완료
============================================

  파일:      $ARCHIVE
  버전:      v${VERSION}
  Bun:       ${BUNDLED_BUN}

  구조:
    offline-package/
    ├── bin/            Bun 바이너리 (플랫폼별 zip)
    ├── project/        dist/ + package.json
    ├── install.sh      Linux/macOS 설치
    ├── install.ps1     Windows PowerShell 설치
    └── install.bat     Windows CMD 설치

  대상 서버(인터넷 X)에서:
    tar -xzf $(basename "$ARCHIVE")
    cd offline-package
    bash install.sh            # Linux/macOS
    install.bat                # Windows

EOF
