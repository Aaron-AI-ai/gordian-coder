#!/bin/bash
# =============================================================================
# fetch-opencode.sh - OpenCode 오프라인 반입용 바이너리 내려받기
#
#   인터넷 되는 환경에서 실행 → 플랫폼별 바이너리 + 설치 스크립트를 받아
#   반입용 아카이브 하나(opencode-<version>-offline.tar.gz)로 묶습니다.
#   대상 서버에서는 풀고 install-opencode.sh 만 실행하면 됩니다.
#
# 사용법:
#   bash scripts/offline/fetch-opencode.sh              # 최신 버전 확인 후 선택
#   bash scripts/offline/fetch-opencode.sh 1.18.4       # 버전 지정
#
# 환경변수:
#   PLATFORMS   받을 플랫폼 (기본: windows-x64 linux-x64 linux-arm64)
#               그 외: windows-arm64, windows-x64-baseline,
#                      linux-x64-musl, linux-arm64-musl,
#                      linux-x64-baseline, linux-x64-baseline-musl,
#                      darwin-x64, darwin-arm64
#   OUT_DIR     저장 위치 (기본: <project>/opencode-dist/<version>)
#   EXTRACT=1   .tgz 외에 실행 바이너리도 함께 풀어둠 (플랫폼당 약 180MB 추가)
#   WITH_PLUGIN_DEPS=1  @opencode-ai/plugin 트리도 담음 (+10MB, 보통 불필요)
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

REGISTRY="https://registry.npmjs.org"
read -r -a PLATFORMS <<< "${PLATFORMS:-windows-x64 linux-x64 linux-arm64}"

log_step() {
  echo ""
  echo "============================================"
  echo "  $1"
  echo "============================================"
}

log_info() { echo "  → $1"; }
log_ok()   { echo "  [OK] $1"; }

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
log_error() { echo "  [ERROR] $1" >&2; }

need() {
  command -v "$1" &>/dev/null || { log_error "$1 명령이 필요합니다."; exit 1; }
}

need curl
need tar

# -----------------------------------------------------------------------------
# 1. 원격 버전 확인
# -----------------------------------------------------------------------------

log_step "1/4 원격 버전 확인"

# ponytail: npm 없이도 되게 registry의 /latest 엔드포인트만 긁는다 (jq도 불필요).
LATEST=$(curl -fsSL "$REGISTRY/opencode-ai/latest" \
  | tr ',' '\n' | grep -m1 '"version"' | sed 's/.*"version" *: *"\([^"]*\)".*/\1/')

if [ -z "$LATEST" ]; then
  log_error "최신 버전을 조회하지 못했습니다. 네트워크/프록시를 확인해 주세요."
  exit 1
fi

log_info "최신 버전: $LATEST"

# 최근 안정 버전 목록 (조회 실패해도 진행 — 선택에 참고용일 뿐)
RECENT=$(curl -fsSL -H "Accept: application/vnd.npm.install-v1+json" \
  "$REGISTRY/opencode-ai" 2>/dev/null \
  | tr ',' '\n' | grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"' \
  | sort -u | sort -t. -k1,1n -k2,2n -k3,3n | tail -10 | tr '\n' ' ' || true)

[ -n "$RECENT" ] && log_info "최근 버전: $RECENT"

# -----------------------------------------------------------------------------
# 2. 버전 선택
# -----------------------------------------------------------------------------

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  # 비대화형(EOF)에서 read가 set -e로 스크립트를 죽이지 않도록 `|| true`.
  read -r -p "  받을 버전 [$LATEST]: " VERSION || true
  VERSION="${VERSION:-$LATEST}"
fi

log_info "선택한 버전: $VERSION"

OUT_DIR="${OUT_DIR:-$PROJECT_ROOT/opencode-dist/$VERSION}"
mkdir -p "$OUT_DIR"

# -----------------------------------------------------------------------------
# 3. 플랫폼별 다운로드
# -----------------------------------------------------------------------------

log_step "2/4 플랫폼별 다운로드 (v$VERSION)"

FAILED=()

for platform in "${PLATFORMS[@]}"; do
  pkg="opencode-${platform}"
  file="${pkg}-${VERSION}.tgz"
  dest="$OUT_DIR/$file"

  if [ -f "$dest" ]; then
    log_info "이미 존재함: $file, 다운로드 스킵"
  else
    log_info "다운로드: $file"
    if ! curl -fSL --progress-bar -o "$dest.part" "$REGISTRY/$pkg/-/$file"; then
      rm -f "$dest.part"
      log_error "$platform 실패 — 해당 버전에 없는 플랫폼일 수 있습니다."
      FAILED+=("$platform")
      continue
    fi
    # 완전히 받은 것만 최종 이름으로. 중단된 파일이 캐시로 남지 않게.
    mv "$dest.part" "$dest"
  fi

  # 추출은 다운로드 여부와 무관하게 판단한다 — 캐시된 파일에도 EXTRACT가 먹도록.
  if [ "${EXTRACT:-}" = "1" ]; then
    bindir="$OUT_DIR/$platform"
    mkdir -p "$bindir"
    # npm 패키지 구조: package/bin/opencode(.exe)
    tar -xzf "$dest" -C "$bindir" --strip-components=2 package/bin
    chmod +x "$bindir"/opencode 2>/dev/null || true
    log_ok "$platform → $file + $platform/$(ls "$bindir" | tr '\n' ' ')"
  else
    log_ok "$platform → $file"
  fi
done

if [ ${#PLATFORMS[@]} -eq ${#FAILED[@]} ]; then
  log_error "모든 플랫폼 다운로드에 실패했습니다. 버전 번호를 확인해 주세요: $VERSION"
  exit 1
fi

# -----------------------------------------------------------------------------
# 4. 체크섬 + 설치 안내
# -----------------------------------------------------------------------------

log_step "3/4 설치 스크립트 · 체크섬 · 안내 파일"

# 모델 카탈로그(models.dev, 4.3MB)는 담지 않는다. 폐쇄망에서는 213개 provider를
# 하나도 쓸 수 없고, 사내 provider는 opencode.json에 전부 선언돼 있어 카탈로그
# 없이도 목록·호출이 정상 동작한다. 기동 지연은 OPENCODE_DISABLE_MODELS_FETCH=1
# 만으로 사라진다. 필요하면 https://models.dev/api.json 을 받아
# ~/.cache/opencode/models.json 에 두면 된다.
rm -f "$OUT_DIR/models.json"

# OpenCode는 기동할 때 ~/.opencode 를 플러그인 디렉토리로 보고 그 안의 package.json
# 의존성(@opencode-ai/plugin)을 npm에서 설치한다. 이름은 "background dependency
# install"이지만 실제로는 기동을 붙잡아, 폐쇄망에서는 레지스트리 접속이 실패할
# 때까지(약 70초) 화면이 비어 있다. 미리 설치해 둔 트리를 통째로 넣어 그 호출을 없앤다.
# 기본은 담지 않는다. .npmrc(offline/fetch-retries=0)로 기동 지연이 해결되므로
# 이 트리는 사용자가 직접 플러그인을 작성해 @opencode-ai/plugin 을 import 할 때만
# 필요하다. 10MB를 매번 옮길 이유가 없다.
if [ "${WITH_PLUGIN_DEPS:-}" = "1" ]; then
log_info "플러그인 의존성(@opencode-ai/plugin) 준비"
PLUGIN_DEPS_DIR="$OUT_DIR/plugin-deps"
rm -rf "$PLUGIN_DEPS_DIR"
mkdir -p "$PLUGIN_DEPS_DIR"

# OpenCode는 자기 버전과 같은 @opencode-ai/plugin 을 설치한다. 버전이 어긋나면
# 대상 서버에서 "맞는 버전"을 다시 받으러 나가므로 반드시 동일하게 고정한다.
PLUGIN_PKG_VERSION="$VERSION"
if ! curl -fsSL -o /dev/null "$REGISTRY/@opencode-ai/plugin/$PLUGIN_PKG_VERSION" 2>/dev/null; then
  log_error "@opencode-ai/plugin@$PLUGIN_PKG_VERSION 이 없습니다 — latest로 대체합니다."
  PLUGIN_PKG_VERSION="latest"
fi
printf '{\n  "dependencies": {\n    "@opencode-ai/plugin": "%s"\n  }\n}\n' \
  "$PLUGIN_PKG_VERSION" > "$PLUGIN_DEPS_DIR/package.json"

if (cd "$PLUGIN_DEPS_DIR" && npm install --silent --no-audit --no-fund >/dev/null 2>&1); then
  # 파일 4천 개를 그대로 옮기면 Windows에서 복사만 수 분이 걸린다. tar 하나로 묶는다.
  tar -czf "$OUT_DIR/plugin-deps.tar.gz" -C "$PLUGIN_DEPS_DIR" .
  rm -rf "$PLUGIN_DEPS_DIR"
  log_ok "plugin-deps.tar.gz ($(du -h "$OUT_DIR/plugin-deps.tar.gz" | cut -f1), @opencode-ai/plugin $PLUGIN_PKG_VERSION)"
else
  rm -rf "$PLUGIN_DEPS_DIR"
  log_error "@opencode-ai/plugin 설치 실패 — WITH_PLUGIN_DEPS 없이 진행합니다."
fi
else
  rm -f "$OUT_DIR/plugin-deps.tar.gz"
  log_info "플러그인 의존성 생략 (필요하면 WITH_PLUGIN_DEPS=1)"
fi

# 설치 스크립트가 바이너리와 같이 이동해야 대상 서버에서 바로 쓸 수 있다.
cp "$SCRIPT_DIR/install-opencode.sh" "$OUT_DIR/install-opencode.sh"
cp "$SCRIPT_DIR/install-opencode.ps1" "$OUT_DIR/install-opencode.ps1"
# 제거 스크립트도 같이 넣는다 — 폐쇄망에서는 나중에 따로 받아올 수 없다.
cp "$SCRIPT_DIR/uninstall.sh" "$OUT_DIR/uninstall.sh"
cp "$SCRIPT_DIR/uninstall.ps1" "$OUT_DIR/uninstall.ps1"
chmod +x "$OUT_DIR/uninstall.sh"
chmod +x "$OUT_DIR/install-opencode.sh"
log_ok "install-opencode.sh / .ps1"

cd "$OUT_DIR"
SUM_FILES=()
for platform in "${PLATFORMS[@]}"; do
  [ -f "./opencode-${platform}-${VERSION}.tgz" ] && SUM_FILES+=("./opencode-${platform}-${VERSION}.tgz")
done
rm -f SHA256SUMS
if [ ${#SUM_FILES[@]} -gt 0 ]; then
  if command -v sha256sum &>/dev/null; then
    sha256sum "${SUM_FILES[@]}" > SHA256SUMS
  elif command -v shasum &>/dev/null; then
    shasum -a 256 "${SUM_FILES[@]}" > SHA256SUMS
  fi
fi
[ -f SHA256SUMS ] && log_ok "SHA256SUMS"

cat > INSTALL.txt <<EOF
OpenCode v${VERSION} 오프라인 설치 안내
========================================

이 디렉토리 하나로 설치가 끝납니다. 바이너리와 설치 스크립트가 함께 있습니다.

무결성 확인 (반입 전/후)
------------------------
  sha256sum -c SHA256SUMS        # Linux
  shasum -a 256 -c SHA256SUMS    # macOS

설치 (Linux / macOS)
--------------------
  bash install-opencode.sh

    → 현재 플랫폼을 감지해 기본 선택으로 보여주고, 목록에서 고르면 됩니다.
    → 바이너리 설치 + PATH 등록 + opencode.json provider 설정까지 진행합니다.
    → apiKey는 반드시 입력해야 하며, 나머지는 엔터로 기본값을 씁니다.

  무인 설치:
    PLATFORM=linux-x64 API_KEY=sk-... FORCE=1 bash install-opencode.sh

설치 (Windows)
--------------
  powershell -ExecutionPolicy Bypass -File install-opencode.ps1

설정 파일 위치 (전 플랫폼 공통)
-------------------------------
  ~/.config/opencode/opencode.json    설정 (apiKey는 {env:...} 참조만 저장)
  ~/.config/opencode/env              실제 apiKey (권한 600)
  ~/.opencode/.npmrc                  npm 재시도 차단 (기동 70초 지연 방지)
  ~/.config/opencode/.npmrc           같음
  ~/.local/share/opencode/auth.json   opencode auth login 사용 시

모델 카탈로그
-------------
  담지 않습니다. 폐쇄망에서는 외부 provider를 쓸 수 없고, 사내 provider는
  opencode.json에 선언돼 있어 카탈로그 없이 동작합니다.
  필요하면 https://models.dev/api.json 을 받아 ~/.cache/opencode/models.json 에 두세요.

플러그인 연결
-------------
  gordian-coder 설치 후:
    gdc --init-opencode --global

참고
----
  Alpine 등 musl 기반 배포판은 linux-x64-musl 파일이 필요합니다.
  PLATFORMS="linux-x64-musl" bash fetch-opencode.sh ${VERSION}
EOF

log_ok "INSTALL.txt"

# -----------------------------------------------------------------------------
# 5. 반입용 아카이브
# -----------------------------------------------------------------------------

log_step "4/4 반입용 아카이브 생성"

# 대상 서버로는 이 파일 하나만 옮기면 된다. EXTRACT=1로 풀어둔 바이너리
# 디렉토리는 .tgz와 중복이므로 아카이브에는 넣지 않는다.
BUNDLE_ITEMS=()
# 이번에 요청한 플랫폼만 담는다. OUT_DIR에는 예전에 받은 것도 남아 있다.
for platform in "${PLATFORMS[@]}"; do
  f="$OUT_DIR/opencode-${platform}-${VERSION}.tgz"
  [ -f "$f" ] && BUNDLE_ITEMS+=("$VERSION/$(basename "$f")")
done
for f in "$OUT_DIR"/install-opencode.sh "$OUT_DIR"/install-opencode.ps1 \
         "$OUT_DIR"/uninstall.sh "$OUT_DIR"/uninstall.ps1 \
         "$OUT_DIR/INSTALL.txt" "$OUT_DIR/SHA256SUMS"; do
  [ -f "$f" ] && BUNDLE_ITEMS+=("$VERSION/$(basename "$f")")
done
[ -f "$OUT_DIR/plugin-deps.tar.gz" ] && BUNDLE_ITEMS+=("$VERSION/plugin-deps.tar.gz")

# 실행할 때마다 새 파일이 생긴다 — 어느 시점 산출물인지 파일명만 보고 구분하려는 것.
# 옛 아카이브는 자동으로 지우지 않으니 주기적으로 정리할 것.
STAMP="$(timestamp)"
ARCHIVE="$PROJECT_ROOT/opencode-${VERSION}-offline-${STAMP}.tar.gz"
tar -czf "$ARCHIVE" -C "$(dirname "$OUT_DIR")" "${BUNDLE_ITEMS[@]}"

log_ok "$(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1))"

# -----------------------------------------------------------------------------
# 요약
# -----------------------------------------------------------------------------

echo ""
echo "============================================"
echo "  다운로드 완료 (OpenCode v${VERSION})"
echo "============================================"
echo ""
echo "  아카이브: $ARCHIVE"
echo "  작업 폴더: $OUT_DIR"
echo ""
ls -lh "$OUT_DIR" | tail -n +2 | awk '{printf "    %-45s %s\n", $9, $5}'
echo ""
[ ${#FAILED[@]} -gt 0 ] && echo "  실패한 플랫폼: ${FAILED[*]}" && echo ""
cat <<EOF
  대상 서버(인터넷 X)에서:
    tar -xzf $(basename "$ARCHIVE")
    cd ${VERSION}
    bash install-opencode.sh                                  # Linux/macOS
    powershell -ExecutionPolicy Bypass -File install-opencode.ps1   # Windows

EOF
