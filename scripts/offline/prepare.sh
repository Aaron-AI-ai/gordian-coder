#!/bin/bash
# =============================================================================
# prepare.sh - 오프라인 설치 패키지 준비 스크립트
# 인터넷이 연결된 환경에서 실행하여 오프라인 설치에 필요한 파일을 다운로드합니다.
#
# 지원 플랫폼: linux-x64, linux-aarch64, darwin-x64, darwin-aarch64, windows-x64
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
OFFLINE_DIR="$PROJECT_ROOT/offline-package"

# Bun 버전 (프로젝트에서 사용 중인 버전에 맞춰 설정)
BUN_VERSION="${BUN_VERSION:-1.3.6}"

# 다운로드할 플랫폼 목록
PLATFORMS=(
  "linux-x64"
  "linux-aarch64"
  "darwin-x64"
  "darwin-aarch64"
  "windows-x64"
)

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

log_warn() {
  echo "  [WARN] $1"
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
# 1. 디렉토리 구조 생성
# -----------------------------------------------------------------------------

log_step "1/5 디렉토리 구조 생성"

rm -rf "$OFFLINE_DIR"
mkdir -p "$OFFLINE_DIR"/{bin,packages,project}

log_ok "디렉토리 생성 완료: $OFFLINE_DIR"

# -----------------------------------------------------------------------------
# 2. Bun 바이너리 다운로드 (각 플랫폼별)
# -----------------------------------------------------------------------------

log_step "2/5 Bun v${BUN_VERSION} 바이너리 다운로드"

for platform in "${PLATFORMS[@]}"; do
  dest_dir="$OFFLINE_DIR/bin"

  if [[ "$platform" == windows-* ]]; then
    filename="bun-${platform}.zip"
  else
    filename="bun-${platform}.zip"
  fi

  download_file "${BUN_BASE_URL}/${filename}" "${dest_dir}/${filename}"
done

log_ok "전체 플랫폼 Bun 바이너리 다운로드 완료"

# -----------------------------------------------------------------------------
# 3. 프로젝트 소스 및 설정 파일 복사
# -----------------------------------------------------------------------------

log_step "3/5 프로젝트 파일 복사"

cd "$PROJECT_ROOT"

# 핵심 파일만 복사 (node_modules, dist, .git 제외)
rsync -a \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='offline-package' \
  --exclude='.claude' \
  . "$OFFLINE_DIR/project/"

log_ok "프로젝트 소스 복사 완료"

# -----------------------------------------------------------------------------
# 4. node_modules 캐시 (bun install 결과물 복사)
# -----------------------------------------------------------------------------

log_step "4/5 의존성 패키지 캐시"

cd "$PROJECT_ROOT"

# 최신 의존성 설치 확인
log_info "bun install 실행 중..."
bun install --frozen-lockfile 2>/dev/null || bun install

# node_modules 전체를 packages에 tar로 묶기
log_info "node_modules 아카이브 생성 중..."
tar -czf "$OFFLINE_DIR/packages/node_modules.tar.gz" -C "$PROJECT_ROOT" node_modules

log_ok "의존성 패키지 캐시 완료"

# -----------------------------------------------------------------------------
# 5. 설치 스크립트 복사
# -----------------------------------------------------------------------------

log_step "5/5 설치 스크립트 복사"

cp "$SCRIPT_DIR/install.sh" "$OFFLINE_DIR/install.sh"
cp "$SCRIPT_DIR/install.ps1" "$OFFLINE_DIR/install.ps1"
cp "$SCRIPT_DIR/install.bat" "$OFFLINE_DIR/install.bat"
chmod +x "$OFFLINE_DIR/install.sh"

log_ok "설치 스크립트 복사 완료"

# -----------------------------------------------------------------------------
# 요약
# -----------------------------------------------------------------------------

echo ""
echo "============================================"
echo "  오프라인 패키지 준비 완료"
echo "============================================"
echo ""
echo "  위치: $OFFLINE_DIR"
echo "  Bun 버전: v${BUN_VERSION}"
echo "  플랫폼: ${PLATFORMS[*]}"
echo ""
echo "  디렉토리 구조:"
echo "    offline-package/"
echo "    ├── bin/                 # Bun 바이너리 (플랫폼별)"
echo "    ├── packages/            # node_modules 캐시"
echo "    ├── project/             # 프로젝트 소스"
echo "    ├── install.sh           # Linux/macOS 설치 스크립트"
echo "    ├── install.ps1          # Windows PowerShell 설치 스크립트"
echo "    └── install.bat          # Windows CMD 설치 스크립트"
echo ""
echo "  배포:"
echo "    전체 offline-package/ 디렉토리를 USB 등으로 대상 서버에 복사한 후"
echo "    Linux/macOS: bash install.sh"
echo "    Windows:     install.bat 또는 powershell -File install.ps1"
echo ""

# 패키지 크기 표시
TOTAL_SIZE=$(du -sh "$OFFLINE_DIR" | cut -f1)
echo "  전체 크기: $TOTAL_SIZE"
echo ""
