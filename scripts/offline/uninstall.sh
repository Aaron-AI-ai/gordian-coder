#!/bin/bash
# =============================================================================
# uninstall.sh - gordian-coder / OpenCode 제거 (Linux / macOS)
#
#   무엇이 설치돼 있는지 먼저 보여주고, 항목별로 확인을 받아 지웁니다.
#   지우기 전에 대상 경로를 반드시 출력합니다.
#
# 사용법:
#   bash uninstall.sh              # 항목별로 물어봄
#   ALL=1 bash uninstall.sh        # 확인 없이 기본 항목 전체 삭제
#
# 환경변수:
#   ALL=1           프롬프트 없이 진행 (아래 "기본 N" 항목은 여전히 제외)
#   WITH_DATA=1     opencode 세션 DB / auth.json 까지 삭제
#   WITH_BUN=1      Bun 런타임(~/.bun)까지 삭제
#   INSTALL_DIR     gordian-coder 설치 경로 (기본 ~/gordian-coder)
#   CONFIG_DIR      opencode 설정 경로 (기본 ~/.config/opencode)
#   CACHE_DIR       opencode 캐시 경로 (기본 ~/.cache/opencode)
#   DATA_DIR        opencode 데이터 경로 (기본 ~/.local/share/opencode)
#   OPENCODE_DIR    opencode 설치 경로 (기본 ~/.opencode)
#   BUN_DIR         Bun 경로 (기본 ~/.bun)
# =============================================================================

set -e

INSTALL_BASE="${INSTALL_DIR:-$HOME/gordian-coder}"
OPENCODE_BASE="${OPENCODE_DIR:-$HOME/.opencode}"
BUN_BASE="${BUN_DIR:-$HOME/.bun}"
CONFIG_BASE="${CONFIG_DIR:-$HOME/.config/opencode}"
DATA_BASE="${DATA_DIR:-$HOME/.local/share/opencode}"
CACHE_BASE="${CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/opencode}"

log_step() {
  echo ""
  echo "============================================"
  echo "  $1"
  echo "============================================"
}

log_info()  { echo "  → $1"; }
log_ok()    { echo "  [OK] $1"; }
log_warn()  { echo "  [WARN] $1"; }
log_error() { echo "  [ERROR] $1" >&2; }

# 기본값 no. EOF(비대화형)에서 set -e로 죽지 않도록 `|| true`.
confirm() {
  local answer
  [ "${ALL:-}" = "1" ] && return 0
  read -r -p "  $1 (y/N): " answer || true
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

# 삭제는 HOME 아래로만 허용한다. 경로 변수가 비거나 잘못 들어왔을 때
# rm -rf 가 엉뚱한 곳을 지우는 사고를 막기 위한 최소한의 방어선.
safe_rm() {
  local target="$1" label="$2"
  if [ -z "$target" ] || [ "$target" = "/" ] || [ "$target" = "$HOME" ]; then
    log_error "안전 검사 실패 — 삭제하지 않습니다: '${target}'"
    return 1
  fi
  case "$target" in
    "$HOME"/*) ;;
    *)
      log_error "HOME 밖 경로라 삭제하지 않습니다: $target"
      return 1
      ;;
  esac
  if [ ! -e "$target" ]; then
    log_info "$label — 없음 (건너뜀)"
    return 0
  fi
  rm -rf "$target"
  log_ok "$label 삭제: $target"
}

size_of() {
  [ -e "$1" ] && du -sh "$1" 2>/dev/null | cut -f1 || echo "-"
}

# -----------------------------------------------------------------------------
# 1. 현재 설치 상태
# -----------------------------------------------------------------------------

echo ""
echo "============================================"
echo "  gordian-coder / OpenCode 제거"
echo "============================================"

log_step "1/3 현재 설치 상태"

printf "  %-22s %-46s %s\n" "항목" "경로" "크기"
printf "  %-22s %-46s %s\n" "----" "----" "----"
printf "  %-22s %-46s %s\n" "gordian-coder" "$INSTALL_BASE" "$(size_of "$INSTALL_BASE")"
printf "  %-22s %-46s %s\n" "opencode 실행파일" "$OPENCODE_BASE/bin" "$(size_of "$OPENCODE_BASE/bin")"
printf "  %-22s %-46s %s\n" "opencode 설정" "$CONFIG_BASE" "$(size_of "$CONFIG_BASE")"
printf "  %-22s %-46s %s\n" "opencode 데이터" "$DATA_BASE" "$(size_of "$DATA_BASE")"
printf "  %-22s %-46s %s\n" "opencode 캐시" "$CACHE_BASE" "$(size_of "$CACHE_BASE")"
printf "  %-22s %-46s %s\n" "Bun 런타임" "$BUN_BASE" "$(size_of "$BUN_BASE")"
echo ""

command -v gdc &>/dev/null      && log_info "gdc: $(command -v gdc)"
command -v opencode &>/dev/null && log_info "opencode: $(command -v opencode)"

echo ""
log_warn "설정(opencode.json, apiKey)과 데이터(세션 DB, auth.json)는 복구되지 않습니다."

# -----------------------------------------------------------------------------
# 2. 삭제
# -----------------------------------------------------------------------------

log_step "2/3 삭제"

# --- gordian-coder ---
if confirm "gordian-coder를 삭제할까요? ($INSTALL_BASE)"; then
  # 디렉토리를 지우기 전에 링크를 먼저 끊어야 ~/.bun/bin에 죽은 심볼릭 링크가 남지 않는다.
  if [ -f "$INSTALL_BASE/package.json" ] && command -v bun &>/dev/null; then
    (cd "$INSTALL_BASE" && bun unlink >/dev/null 2>&1) || log_warn "bun unlink 실패 — 링크를 직접 정리합니다"
  fi
  rm -f "$BUN_BASE/bin/gdc" "$BUN_BASE/bin/gordian-coder-cli" "$BUN_BASE/bin/gordian-coder-mcp"
  rm -rf "$BUN_BASE/install/global/node_modules/gordian-coder"
  safe_rm "$INSTALL_BASE" "gordian-coder" || true
  log_ok "글로벌 링크 정리 완료"
fi

# --- opencode 실행 파일 ---
if confirm "opencode 실행 파일을 삭제할까요? ($OPENCODE_BASE)"; then
  safe_rm "$OPENCODE_BASE" "opencode" || true
fi

# --- opencode 설정 ---
if confirm "opencode 설정을 삭제할까요? ($CONFIG_BASE — opencode.json, apiKey 포함)"; then
  safe_rm "$CONFIG_BASE" "opencode 설정" || true
fi

# --- opencode 캐시 (모델 카탈로그) ---
if confirm "opencode 캐시를 삭제할까요? ($CACHE_BASE — 모델 카탈로그)"; then
  safe_rm "$CACHE_BASE" "opencode 캐시" || true
fi

# --- opencode 데이터 (기본 제외) ---
if [ "${WITH_DATA:-}" = "1" ]; then
  safe_rm "$DATA_BASE" "opencode 데이터" || true
elif [ -e "$DATA_BASE" ]; then
  if [ "${ALL:-}" = "1" ]; then
    log_info "opencode 데이터 유지 (WITH_DATA=1 로 삭제 가능): $DATA_BASE"
  elif confirm "opencode 데이터(세션 DB, auth.json)도 삭제할까요? ($DATA_BASE)"; then
    safe_rm "$DATA_BASE" "opencode 데이터" || true
  fi
fi

# --- Bun (기본 제외: 다른 도구가 함께 쓸 수 있다) ---
if [ "${WITH_BUN:-}" = "1" ]; then
  safe_rm "$BUN_BASE" "Bun 런타임" || true
elif [ -e "$BUN_BASE" ]; then
  if [ "${ALL:-}" = "1" ]; then
    log_info "Bun 유지 (WITH_BUN=1 로 삭제 가능): $BUN_BASE"
  elif confirm "Bun 런타임도 삭제할까요? (다른 도구가 쓰고 있을 수 있습니다)"; then
    safe_rm "$BUN_BASE" "Bun 런타임" || true
  fi
fi

# -----------------------------------------------------------------------------
# 3. 셸 설정 정리
# -----------------------------------------------------------------------------

log_step "3/3 셸 설정 정리"

SHELL_NAME="$(basename "${SHELL:-bash}" 2>/dev/null || echo bash)"
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash) RC_FILE="$HOME/.bashrc" ;;
  *)    RC_FILE="$HOME/.profile" ;;
esac

if [ ! -f "$RC_FILE" ]; then
  log_info "$RC_FILE 없음 — 건너뜀"
elif ! grep -qE "gordian-coder offline install|opencode \(offline install\)|opencode provider credentials|폐쇄망 오프라인 설정" "$RC_FILE"; then
  log_info "설치 스크립트가 추가한 줄이 없습니다: $RC_FILE"
elif confirm "$RC_FILE 에서 설치 스크립트가 추가한 줄을 지울까요?"; then
  RC_BACKUP="${RC_FILE}.bak-$(date +%Y%m%dT%H%M%S)"
  cp "$RC_FILE" "$RC_BACKUP"

  # 마커 주석을 만나면 뒤따르는 export / source 줄까지 함께 버린다.
  # 우리가 넣은 블록만 정확히 지우기 위해 마커 문구로 식별한다.
  awk '
    /^# bun \(gordian-coder offline install\)$/ { skip = 1; next }
    /^# opencode \(offline install\)$/          { skip = 1; next }
    /^# opencode provider credentials \(offline install\)$/ { skip = 1; next }
    /^# opencode: 폐쇄망 오프라인 설정 \(offline install\)$/ { skip = 1; next }
    skip && (/^export /  || /^\[ -f /) { next }
    { skip = 0; print }
  ' "$RC_FILE" > "${RC_FILE}.tmp"
  mv "${RC_FILE}.tmp" "$RC_FILE"

  log_ok "정리 완료 (백업: $RC_BACKUP)"
fi

# -----------------------------------------------------------------------------
# 요약
# -----------------------------------------------------------------------------

echo ""
echo "============================================"
echo "  제거 완료"
echo "============================================"
echo ""
echo "  남아 있는 항목:"
for p in "$INSTALL_BASE" "$OPENCODE_BASE" "$CONFIG_BASE" "$DATA_BASE" "$CACHE_BASE" "$BUN_BASE"; do
  [ -e "$p" ] && echo "    - $p"
done
echo ""
echo "  새 터미널을 열어야 PATH 변경이 반영됩니다."
echo "  (현재 셸에서는 gdc / opencode 가 아직 잡힐 수 있습니다)"
echo ""
