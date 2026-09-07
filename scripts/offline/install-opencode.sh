#!/bin/bash
# =============================================================================
# install-opencode.sh - OpenCode 오프라인 설치 (Linux / macOS)
#
#   fetch-opencode.sh 로 받은 파일이 있는 디렉토리에서 실행합니다.
#   사용 가능한 플랫폼을 보여주고, 감지된 것을 기본값으로 선택하게 합니다.
#
# 사용법:
#   bash install-opencode.sh                    # 목록에서 선택
#   PLATFORM=linux-x64-musl bash install-opencode.sh
#
# 환경변수:
#   DIST_DIR       파일 위치 (기본: 이 스크립트가 있는 디렉토리)
#   OPENCODE_DIR   설치 경로 (기본: ~/.opencode)
#   PLATFORM       플랫폼 직접 지정 (프롬프트 생략)
#   FORCE=1        기존 설치를 확인 없이 덮어쓰기
#   SKIP_CONFIG=1  opencode.json 구성 단계를 건너뜀
#   API_KEY        provider apiKey (지정 시 프롬프트 없이 사용, 무인 설치용)
#   WITH_PLUGIN_DEPS=1  @opencode-ai/plugin 트리도 배치 (사용자 플러그인 작성용)
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="${DIST_DIR:-$SCRIPT_DIR}"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.opencode}"

# OpenCode는 이 파일을 자동 생성하지 않으므로 여기서 만든다.
#
# 위치는 문서상 전 플랫폼(Windows 포함) 공통으로 ~/.config/opencode/opencode.json 이다.
# OPENCODE_CONFIG_DIR 은 agents/commands/plugins 디렉토리를 가리키는 변수라
# 설정 파일 위치로 쓰면 안 된다 — OpenCode가 읽지 않는 파일에 쓰게 된다.
resolve_config_path() {
  if [ -n "${OPENCODE_CONFIG:-}" ]; then echo "$OPENCODE_CONFIG"; return; fi
  echo "$HOME/.config/opencode/opencode.json"
}

# rc 파일과 설정 파일 경로는 여러 단계에서 쓰이므로 여기서 한 번만 정한다.
CONFIG_PATH="$(resolve_config_path)"

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
  read -r -p "  $1 (y/N): " answer || true
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

# -----------------------------------------------------------------------------
# 1. 사용 가능한 파일 수집
# -----------------------------------------------------------------------------

echo ""
echo "============================================"
echo "  OpenCode 오프라인 설치"
echo "============================================"

# opencode-<platform>-<version>.tgz 에서 플랫폼과 버전을 뽑는다.
PLATFORMS=()
FILES=()
VERSION=""

for f in "$DIST_DIR"/opencode-*.tgz; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  # opencode-linux-x64-1.18.27.tgz → platform=linux-x64, version=1.18.27
  meta="${base#opencode-}"
  meta="${meta%.tgz}"
  ver="${meta##*-}"
  plat="${meta%-"$ver"}"
  PLATFORMS+=("$plat")
  FILES+=("$f")
  VERSION="$ver"
done

if [ ${#PLATFORMS[@]} -eq 0 ]; then
  log_error "설치할 파일이 없습니다: $DIST_DIR/opencode-*.tgz"
  log_error "fetch-opencode.sh 로 받은 파일과 같은 디렉토리에서 실행하거나,"
  log_error "DIST_DIR 환경변수로 위치를 지정해 주세요."
  exit 1
fi

# -----------------------------------------------------------------------------
# 2. 현재 플랫폼 감지
# -----------------------------------------------------------------------------

detect_platform() {
  local os arch libc=""

  case "$(uname -s)" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    *)       echo ""; return ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)             echo ""; return ;;
  esac

  # musl(Alpine 등)에 glibc 빌드를 넣으면 실행 시점에야 깨진다. 미리 갈라둔다.
  if [ "$os" = "linux" ] && ! ldd --version 2>&1 | grep -qi glibc; then
    if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* &>/dev/null; then
      libc="-musl"
    fi
  fi

  echo "${os}-${arch}${libc}"
}

DETECTED="$(detect_platform)"

# -----------------------------------------------------------------------------
# 3. 선택
# -----------------------------------------------------------------------------

log_step "1/4 설치할 플랫폼 선택"

[ -n "$VERSION" ] && log_info "버전: v${VERSION}"
if [ -n "$DETECTED" ]; then
  log_info "감지된 플랫폼: $DETECTED"
else
  log_warn "현재 플랫폼을 자동 감지하지 못했습니다. 직접 선택해 주세요."
fi

DEFAULT_IDX=""
echo ""
echo "  사용 가능한 파일:"
for i in "${!PLATFORMS[@]}"; do
  mark=" "
  if [ "${PLATFORMS[$i]}" = "$DETECTED" ]; then
    mark="*"
    DEFAULT_IDX=$((i + 1))
  fi
  printf "   %s %2d) %-24s %s\n" "$mark" "$((i + 1))" "${PLATFORMS[$i]}" "$(basename "${FILES[$i]}")"
done
echo ""

CHOICE=""
if [ -n "${PLATFORM:-}" ]; then
  for i in "${!PLATFORMS[@]}"; do
    [ "${PLATFORMS[$i]}" = "$PLATFORM" ] && CHOICE=$((i + 1))
  done
  if [ -z "$CHOICE" ]; then
    log_error "PLATFORM=$PLATFORM 에 해당하는 파일이 없습니다."
    exit 1
  fi
  log_info "PLATFORM=$PLATFORM 지정됨"
else
  read -r -p "  설치할 번호 [${DEFAULT_IDX:-?}]: " CHOICE || true
  CHOICE="${CHOICE:-$DEFAULT_IDX}"
fi

if ! [[ "$CHOICE" =~ ^[0-9]+$ ]] || [ "$CHOICE" -lt 1 ] || [ "$CHOICE" -gt ${#PLATFORMS[@]} ]; then
  log_error "잘못된 선택입니다: ${CHOICE:-(없음)}"
  exit 1
fi

SEL_PLATFORM="${PLATFORMS[$((CHOICE - 1))]}"
SEL_FILE="${FILES[$((CHOICE - 1))]}"

log_info "선택: $SEL_PLATFORM"

# 현재 OS와 다른 바이너리는 여기서 실행되지 않는다. 스테이징 목적일 수 있으니
# 막지는 않되, 반드시 확인을 받는다 (모르고 고르면 설치 후에야 깨진다).
case "$SEL_PLATFORM" in
  windows-*) SEL_OS="windows" ;;
  darwin-*)  SEL_OS="darwin" ;;
  *)         SEL_OS="linux" ;;
esac
CURRENT_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
[ "$CURRENT_OS" = "darwin" ] || CURRENT_OS="linux"

if [ "$SEL_OS" != "$CURRENT_OS" ]; then
  log_warn "선택한 플랫폼($SEL_PLATFORM)은 현재 OS($CURRENT_OS)에서 실행할 수 없습니다."
  log_warn "다른 서버로 옮길 목적이라면 계속 진행해도 됩니다 (실행 검증은 생략됩니다)."
  if [ "${FORCE:-}" != "1" ] && ! confirm "계속하시겠습니까?"; then
    log_error "설치를 중단했습니다."
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# 4. 설치
# -----------------------------------------------------------------------------

log_step "2/4 바이너리 설치"

BIN_DIR="$OPENCODE_DIR/bin"

if command -v opencode &>/dev/null; then
  log_info "기존 OpenCode 발견: v$(opencode --version 2>/dev/null || echo unknown)"
  if [ "${FORCE:-}" != "1" ] && ! confirm "덮어쓰시겠습니까?"; then
    log_error "설치를 중단했습니다. FORCE=1 로 확인 없이 덮어쓸 수 있습니다."
    exit 1
  fi
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

log_info "압축 해제 중..."
tar -xzf "$SEL_FILE" -C "$TEMP_DIR"

SRC_BIN="$(find "$TEMP_DIR" -type f -name "opencode" -o -type f -name "opencode.exe" | head -1)"
if [ -z "$SRC_BIN" ]; then
  log_error "아카이브에서 opencode 실행 파일을 찾을 수 없습니다: $SEL_FILE"
  exit 1
fi

mkdir -p "$BIN_DIR"
cp "$SRC_BIN" "$BIN_DIR/$(basename "$SRC_BIN")"
chmod +x "$BIN_DIR/$(basename "$SRC_BIN")"

log_ok "설치 완료: $BIN_DIR/$(basename "$SRC_BIN")"

# -----------------------------------------------------------------------------
# 5. PATH 등록 + 확인
# -----------------------------------------------------------------------------

log_step "3/4 PATH 등록"

if [ "$SEL_OS" != "$CURRENT_OS" ]; then
  log_info "다른 OS용 바이너리라 PATH 등록과 실행 확인을 건너뜁니다."
else
  SHELL_NAME="$(basename "$SHELL" 2>/dev/null || echo bash)"
  case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    *)    RC_FILE="$HOME/.profile" ;;
  esac

  if grep -q "$BIN_DIR" "$RC_FILE" 2>/dev/null; then
    log_info "PATH 설정 이미 존재: $RC_FILE"
  else
    {
      echo ""
      echo "# opencode (offline install)"
      echo "export PATH=\"$BIN_DIR:\$PATH\""
    } >> "$RC_FILE"
    log_info "PATH 설정 추가됨: $RC_FILE"
  fi

  export PATH="$BIN_DIR:$PATH"

  # OpenCode는 기동 시 models.dev에서 모델 카탈로그를 받아온다. 폐쇄망에서는 이
  # 호출이 타임아웃까지 매달려 화면이 한참 비어 있다가 실패한다.
  #   - 카탈로그를 캐시에 미리 넣으면 그게 먼저 반환되어 대기가 사라지고
  #   - OPENCODE_DISABLE_MODELS_FETCH 로 60분마다 도는 재조회까지 끈다.
  # OpenCode는 ~/.opencode 를 플러그인 디렉토리로 보고 그 안 package.json의
  # 의존성(@opencode-ai/plugin)을 npm에서 설치한다. "background dependency install"
  # 이라는 이름과 달리 기동을 붙잡아, 폐쇄망에서는 레지스트리 접속이 실패할 때까지
  # (약 70초) 화면이 비어 있다. 미리 받아둔 트리를 넣어 그 호출 자체를 없앤다.
  # 설치 대상은 ~/.opencode 와 설정 디렉토리 두 곳이다. OpenCode가 두 곳 모두를
  # 플러그인 디렉토리로 보고 각각 의존성을 설치하려 들기 때문이다.
  # 기동을 붙잡던 70초의 정체는 npm 재시도 백오프였다. .npmrc 로 끊는다.
  for d in "$OPENCODE_DIR" "$(dirname "$CONFIG_PATH")"; do
    mkdir -p "$d"
    cat > "$d/.npmrc" <<'NPMRC'
# opencode 오프라인 설치 (gordian-coder)
#
# opencode는 기동할 때 이 디렉토리에 @opencode-ai/plugin 을 설치하려 한다.
# 폐쇄망에서는 실패할 수밖에 없는데, npm 기본 재시도(2회: 10초 + 60초)
# 때문에 기동이 약 70초 지연된다. 아래 두 줄이 그 대기를 없앤다.
#   offline        네트워크를 아예 시도하지 않는다
#   fetch-retries  실패해도 재시도하지 않는다 (70초의 정체)
offline=true
fetch-retries=0
NPMRC
    log_ok "npm 재시도 차단: $d/.npmrc"
  done

  # 사용자가 직접 만든 플러그인이 @opencode-ai/plugin 을 import 하는 경우에만 필요하다.
  # 파일 4천 개를 쓰는 비용이 커서 기본값은 끔.
  if [ "${WITH_PLUGIN_DEPS:-}" = "1" ] && [ -f "$DIST_DIR/plugin-deps.tar.gz" ]; then
    for d in "$OPENCODE_DIR" "$(dirname "$CONFIG_PATH")"; do
      # 같은 버전이 이미 있으면 건드리지 않는다. 파일 4천 개를 다시 쓰는 비용이 크다.
      if [ -f "$d/node_modules/@opencode-ai/plugin/package.json" ] &&
         grep -q "\"version\": *\"$VERSION\"" "$d/node_modules/@opencode-ai/plugin/package.json" 2>/dev/null; then
        log_info "플러그인 의존성 이미 배치됨 (v$VERSION): $d"
        continue
      fi
      log_info "플러그인 의존성 푸는 중: $d"
      log_info "  파일 약 4천 개라 Windows에서는 수 분 걸릴 수 있습니다 (백신 검사)."
      mkdir -p "$d"
      rm -rf "$d/node_modules"
      tar -xzf "$DIST_DIR/plugin-deps.tar.gz" -C "$d"
      log_ok "플러그인 의존성 배치: $d/node_modules"
    done
  else
    log_info "플러그인 의존성 배치 생략 (필요하면 WITH_PLUGIN_DEPS=1)"
  fi

  # 폐쇄망에서 기동을 붙잡는 바깥 호출을 전부 끈다.
  #   MODELS_FETCH  모델 카탈로그 조회 (10초 타임아웃 + 재시도)
  #   LSP_DOWNLOAD  언어 서버 자동 다운로드 — 프로젝트를 열 때마다 시도한다
  #   AUTOUPDATE    새 버전 확인
  #   SHARE         세션 공유 업로드 (폐쇄망에서는 나갈 곳도 없다)
  OFFLINE_VARS="OPENCODE_DISABLE_MODELS_FETCH OPENCODE_DISABLE_LSP_DOWNLOAD OPENCODE_DISABLE_AUTOUPDATE OPENCODE_DISABLE_SHARE"

  if grep -q "opencode: 폐쇄망 오프라인 설정" "$RC_FILE" 2>/dev/null; then
    log_info "오프라인 설정 이미 존재: $RC_FILE"
  else
    {
      echo ""
      echo "# opencode: 폐쇄망 오프라인 설정 (offline install)"
      for v in $OFFLINE_VARS; do echo "export ${v}=1"; done
      # 셸마다 HOME이 달라도(Git Bash, MobaXterm) 같은 설정 파일을 보게 고정한다.
      echo "export OPENCODE_CONFIG=\"$CONFIG_PATH\""
    } >> "$RC_FILE"
    log_info "오프라인 설정 추가됨: $RC_FILE"
  fi
  for v in $OFFLINE_VARS; do export "$v=1"; done

  log_ok "실행 확인: v$("$BIN_DIR/opencode" --version 2>/dev/null || echo '확인 실패')"
fi

# -----------------------------------------------------------------------------
# 6. opencode.json 구성
# -----------------------------------------------------------------------------

log_step "4/4 opencode.json 구성"

# 이미지의 사내 설정을 기본값으로 둔다. apiKey만 기본값이 없다.
DEF_P_ID="internal"
DEF_P_NAME="Koscom LLM"
DEF_P_NPM="@ai-sdk/openai-compatible"
DEF_P_BASEURL="http://ollama.ai.koscom.co.kr/v1"
DEF_M_ID="Qwen-Coder"
DEF_M_NAME="Qwen-Coder"
DEF_M_CONTEXT="131072"
DEF_M_OUTPUT="40960"

mask_key() {
  local k="$1"
  if [ -z "$k" ]; then echo "(없음)"; return; fi
  if [ ${#k} -le 12 ]; then echo "****"; return; fi
  echo "${k:0:6}...${k: -4}"
}

# apiKey는 opencode.json에 평문으로 두지 않는다. 설정에는 {env:NAME} 참조만
# 쓰고 실제 값은 600 권한 파일에 넣은 뒤 rc에서 source 한다 — rc 자체(보통 644)에
# 비밀값을 적으면 opencode.json에 두는 것과 노출 범위가 같아진다.
env_var_name_for() {
  local upper
  upper="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g')"
  echo "OPENCODE_${upper}_API_KEY"
}

# "{env:NAME}" → NAME, 그 외에는 빈 문자열
env_ref_name() {
  case "$1" in
    "{env:"*"}") printf '%s' "${1#\{env:}" | sed 's/}$//' ;;
    *) echo "" ;;
  esac
}

# $ENV_FILE에서 해당 변수의 현재 값을 읽는다 (없으면 프로세스 환경에서).
read_env_value() {
  local name="$1" line
  if [ -f "$ENV_FILE" ]; then
    line="$(grep -m1 "^export ${name}=" "$ENV_FILE" 2>/dev/null || true)"
    if [ -n "$line" ]; then
      line="${line#export ${name}=}"
      line="${line%\"}"
      line="${line#\"}"
      printf '%s' "$line"
      return
    fi
  fi
  eval "printf '%s' \"\${${name}:-}\""
}

# 같은 변수의 기존 줄은 지우고 다시 쓴다 (재실행 시 중복 방지).
write_env_value() {
  local name="$1" value="$2" tmp
  tmp="${ENV_FILE}.tmp.$$"
  : > "$tmp"
  chmod 600 "$tmp"
  [ -f "$ENV_FILE" ] && grep -v "^export ${name}=" "$ENV_FILE" >> "$tmp" || true
  printf 'export %s="%s"\n' "$name" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# JSON 읽기/병합에는 런타임이 하나 필요하다. 폐쇄망에서 추가 설치가 불가하므로
# 있을 법한 것을 순서대로 찾는다.
json_runtime() {
  local c
  for c in python3 node bun; do
    command -v "$c" &>/dev/null && { echo "$c"; return; }
  done
  echo ""
}

# $1 = read | write. 값은 환경변수로 주고받는다 (따옴표/공백 문제 회피).
json_helper() {
  local mode="$1" rt="$JSON_RT"
  case "$rt" in
    python3)
      CFG_MODE="$mode" python3 - <<'PY'
import json, os
f = os.environ["CFG_FILE"]
try:
    with open(f, encoding="utf-8") as fh:
        cfg = json.load(fh)
    if not isinstance(cfg, dict):
        cfg = {}
except Exception:
    cfg = {}

if os.environ["CFG_MODE"] == "read":
    prov = cfg.get("provider") or {}
    pid = next(iter(prov), "")
    p = prov.get(pid) or {}
    opt = p.get("options") or {}
    models = p.get("models") or {}
    mid = next(iter(models), "")
    m = models.get(mid) or {}
    lim = m.get("limit") or {}
    for k, v in (
        ("P_ID", pid), ("P_NAME", p.get("name", "")), ("P_NPM", p.get("npm", "")),
        ("P_BASEURL", opt.get("baseURL", "")), ("P_APIKEY", opt.get("apiKey", "")),
        ("M_ID", mid), ("M_NAME", m.get("name", "")),
        ("M_CONTEXT", lim.get("context", "")), ("M_OUTPUT", lim.get("output", "")),
    ):
        print(f"{k}={v}")
else:
    e = os.environ
    prov = cfg.setdefault("provider", {})
    # provider id를 바꿨으면 옛 항목을 남기지 않는다.
    old = e.get("OLD_P_ID", "")
    if old and old != e["P_ID"]:
        prov.pop(old, None)
    prov[e["P_ID"]] = {
        "npm": e["P_NPM"],
        "name": e["P_NAME"],
        "options": {"baseURL": e["P_BASEURL"], "apiKey": e["P_APIKEY"]},
        "models": {e["M_ID"]: {"name": e["M_NAME"],
                               "limit": {"context": int(e["M_CONTEXT"]),
                                         "output": int(e["M_OUTPUT"])}}},
    }
    cfg["$schema"] = cfg.get("$schema", "https://opencode.ai/config.json")
    cfg["model"] = f'{e["P_ID"]}/{e["M_ID"]}'
    cfg.setdefault("autoupdate", False)
    cfg.setdefault("plugin", [])
    with open(f, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
PY
      ;;
    node|bun)
      CFG_MODE="$mode" "$rt" -e '
const fs = require("fs"), e = process.env, f = e.CFG_FILE;
let cfg = {};
try { const p = JSON.parse(fs.readFileSync(f, "utf-8")); if (p && typeof p === "object" && !Array.isArray(p)) cfg = p; } catch {}
if (e.CFG_MODE === "read") {
  const prov = cfg.provider || {}, pid = Object.keys(prov)[0] || "", p = prov[pid] || {};
  const opt = p.options || {}, models = p.models || {}, mid = Object.keys(models)[0] || "";
  const m = models[mid] || {}, lim = m.limit || {};
  const out = { P_ID: pid, P_NAME: p.name || "", P_NPM: p.npm || "",
    P_BASEURL: opt.baseURL || "", P_APIKEY: opt.apiKey || "",
    M_ID: mid, M_NAME: m.name || "",
    M_CONTEXT: lim.context ?? "", M_OUTPUT: lim.output ?? "" };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
} else {
  cfg.provider = cfg.provider || {};
  const old = e.OLD_P_ID || "";
  if (old && old !== e.P_ID) delete cfg.provider[old];
  cfg.provider[e.P_ID] = { npm: e.P_NPM, name: e.P_NAME,
    options: { baseURL: e.P_BASEURL, apiKey: e.P_APIKEY },
    models: { [e.M_ID]: { name: e.M_NAME,
      limit: { context: Number(e.M_CONTEXT), output: Number(e.M_OUTPUT) } } } };
  cfg["$schema"] = cfg["$schema"] || "https://opencode.ai/config.json";
  cfg.model = `${e.P_ID}/${e.M_ID}`;
  if (cfg.autoupdate === undefined) cfg.autoupdate = false;
  if (cfg.plugin === undefined) cfg.plugin = [];
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}'
      ;;
  esac
}

# 기본값 위에 기존 설정값을 덮어 프롬프트 기본값을 만든다.
CUR_P_ID="$DEF_P_ID";           CUR_P_NAME="$DEF_P_NAME"
CUR_P_NPM="$DEF_P_NPM";         CUR_P_BASEURL="$DEF_P_BASEURL"
CUR_P_APIKEY="";                CUR_M_ID="$DEF_M_ID"
CUR_M_NAME="$DEF_M_NAME";       CUR_M_CONTEXT="$DEF_M_CONTEXT"
CUR_M_OUTPUT="$DEF_M_OUTPUT";   OLD_P_ID=""
CUR_KEY_VALUE="";               CUR_ENV_VAR=""

ask() { # ask <표시명> <기본값> → 표준출력으로 결정된 값
  local label="$1" default="$2" answer
  read -r -p "    ${label} [${default}]: " answer || true
  echo "${answer:-$default}"
}

if [ "${SKIP_CONFIG:-}" = "1" ]; then
  log_info "SKIP_CONFIG=1 — 건너뜀"
elif [ "$SEL_OS" != "$CURRENT_OS" ]; then
  log_info "다른 OS용 설치라 설정 구성을 건너뜁니다."
else
  JSON_RT="$(json_runtime)"
  ENV_FILE="$(dirname "$CONFIG_PATH")/env"

  log_info "설정 파일: $CONFIG_PATH"
  [ -n "${OPENCODE_CONFIG:-}" ] && log_info "경로 근거: OPENCODE_CONFIG"
  log_info "비밀값 파일: $ENV_FILE (600)"

  if [ -z "$JSON_RT" ]; then
    log_warn "python3 / node / bun 중 아무것도 없어 설정을 읽고 쓸 수 없습니다."
    log_warn "gordian-coder(bun) 설치 후 다시 실행하거나 직접 편집하세요: $CONFIG_PATH"
  else
    # 기존 설정 표시
    if [ -f "$CONFIG_PATH" ]; then
      export CFG_FILE="$CONFIG_PATH"
      while IFS='=' read -r k v; do
        [ -z "$k" ] && continue
        [ -z "$v" ] && continue
        case "$k" in
          P_ID) CUR_P_ID="$v"; OLD_P_ID="$v" ;;
          P_NAME) CUR_P_NAME="$v" ;;
          P_NPM) CUR_P_NPM="$v" ;;
          P_BASEURL) CUR_P_BASEURL="$v" ;;
          P_APIKEY) CUR_P_APIKEY="$v" ;;
          M_ID) CUR_M_ID="$v" ;;
          M_NAME) CUR_M_NAME="$v" ;;
          M_CONTEXT) CUR_M_CONTEXT="$v" ;;
          M_OUTPUT) CUR_M_OUTPUT="$v" ;;
        esac
      done < <(json_helper read)

      echo ""
      # 설정값이 {env:NAME} 참조면 실제 키는 비밀값 파일 쪽에 있다.
      REF_NAME="$(env_ref_name "$CUR_P_APIKEY")"
      if [ -n "$REF_NAME" ]; then
        CUR_ENV_VAR="$REF_NAME"
        CUR_KEY_VALUE="$(read_env_value "$REF_NAME")"
      else
        CUR_KEY_VALUE="$CUR_P_APIKEY"
      fi

      echo "  현재 설정:"
      printf "    %-14s %s\n" "provider id" "$CUR_P_ID"
      printf "    %-14s %s\n" "name"        "$CUR_P_NAME"
      printf "    %-14s %s\n" "npm"         "$CUR_P_NPM"
      printf "    %-14s %s\n" "baseURL"     "$CUR_P_BASEURL"
      if [ -n "$REF_NAME" ]; then
        printf "    %-14s %s\n" "apiKey"    "{env:$REF_NAME}"
        printf "    %-14s %s\n" "└ 실제 값" "$(mask_key "$CUR_KEY_VALUE")"
      else
        printf "    %-14s %s\n" "apiKey"    "$(mask_key "$CUR_KEY_VALUE") (평문)"
      fi
      printf "    %-14s %s\n" "model id"    "$CUR_M_ID"
      printf "    %-14s %s\n" "context"     "$CUR_M_CONTEXT"
      printf "    %-14s %s\n" "output"      "$CUR_M_OUTPUT"
      echo "    → 기본 모델    $CUR_P_ID/$CUR_M_ID"
      echo ""
    else
      log_info "설정 파일이 없습니다. 새로 만듭니다."
      mkdir -p "$(dirname "$CONFIG_PATH")"
    fi

    DO_CONFIGURE=true
    if [ -n "${API_KEY:-}" ]; then
      # API_KEY를 명시했다는 건 설정하겠다는 뜻이다 — FORCE보다 우선한다.
      :
    elif [ -f "$CONFIG_PATH" ] && [ -n "$CUR_KEY_VALUE" ]; then
      # 이미 완성된 설정이 있으면 건드릴지 먼저 묻는다.
      if [ "${FORCE:-}" = "1" ] || ! confirm "설정을 수정하시겠습니까?"; then
        DO_CONFIGURE=false
        log_info "기존 설정을 유지합니다."
      fi
    fi

    if [ "$DO_CONFIGURE" = true ]; then
      echo "  provider 정보를 입력하세요 (엔터 = 기본값)"
      echo ""
      NEW_P_ID="$(ask "provider id" "$CUR_P_ID")"
      NEW_P_NAME="$(ask "name       " "$CUR_P_NAME")"
      NEW_P_NPM="$(ask "npm        " "$CUR_P_NPM")"
      NEW_P_BASEURL="$(ask "baseURL    " "$CUR_P_BASEURL")"

      # apiKey는 기본값을 두지 않는다 — 빈 값이면 OpenCode가 인증에 실패한다.
      # 입력받은 값은 설정이 아니라 비밀값 파일로 간다.
      NEW_KEY_VALUE="${API_KEY:-}"
      while [ -z "$NEW_KEY_VALUE" ]; do
        if [ -n "$CUR_KEY_VALUE" ]; then
          read -r -p "    apiKey      [$(mask_key "$CUR_KEY_VALUE")] (엔터=유지): " NEW_KEY_VALUE || true
          NEW_KEY_VALUE="${NEW_KEY_VALUE:-$CUR_KEY_VALUE}"
        else
          read -r -p "    apiKey      (필수): " NEW_KEY_VALUE || true
          [ -z "$NEW_KEY_VALUE" ] && log_warn "apiKey는 반드시 입력해야 합니다."
        fi
        # 입력이 끊긴(EOF) 상태면 재질문해봐야 무한 루프가 되므로 빠져나온다.
        if [ -z "$NEW_KEY_VALUE" ] && ! tty -s <&0; then
          break
        fi
      done

      NEW_M_ID="$(ask "model id   " "$CUR_M_ID")"
      NEW_M_NAME="$(ask "model name " "$CUR_M_NAME")"
      NEW_M_CONTEXT="$(ask "context    " "$CUR_M_CONTEXT")"
      NEW_M_OUTPUT="$(ask "output     " "$CUR_M_OUTPUT")"

      if [ -z "$NEW_KEY_VALUE" ]; then
        log_error "apiKey 미입력 — 설정을 저장하지 않았습니다."
      else
        # provider id가 바뀌면 변수명도 따라간다. 기존 참조가 있으면 그대로 쓴다.
        if [ -n "$CUR_ENV_VAR" ] && [ "$NEW_P_ID" = "$CUR_P_ID" ]; then
          NEW_ENV_VAR="$CUR_ENV_VAR"
        else
          NEW_ENV_VAR="$(env_var_name_for "$NEW_P_ID")"
        fi

        if [ -f "$CONFIG_PATH" ]; then
          CONFIG_BACKUP="${CONFIG_PATH}.bak-$(date +%Y%m%dT%H%M%S)"
          cp "$CONFIG_PATH" "$CONFIG_BACKUP"
          log_info "백업: $CONFIG_BACKUP"
        fi

        # 비밀값은 600 파일로, 설정에는 참조만.
        write_env_value "$NEW_ENV_VAR" "$NEW_KEY_VALUE"
        log_ok "비밀값 저장: $ENV_FILE ($NEW_ENV_VAR)"

        # rc가 비밀값 파일을 읽도록 한 줄만 추가한다 (키 자체는 rc에 쓰지 않는다).
        if [ -n "${RC_FILE:-}" ]; then
          if grep -q "$ENV_FILE" "$RC_FILE" 2>/dev/null; then
            log_info "rc 연결 이미 존재: $RC_FILE"
          else
            {
              echo ""
              echo "# opencode provider credentials (offline install)"
              echo "[ -f \"$ENV_FILE\" ] && . \"$ENV_FILE\""
            } >> "$RC_FILE"
            log_info "rc 연결 추가됨: $RC_FILE"
          fi
        fi

        export CFG_FILE="$CONFIG_PATH" OLD_P_ID
        export P_ID="$NEW_P_ID" P_NAME="$NEW_P_NAME" P_NPM="$NEW_P_NPM"
        export P_BASEURL="$NEW_P_BASEURL" P_APIKEY="{env:$NEW_ENV_VAR}"
        export M_ID="$NEW_M_ID" M_NAME="$NEW_M_NAME"
        export M_CONTEXT="$NEW_M_CONTEXT" M_OUTPUT="$NEW_M_OUTPUT"
        json_helper write

        log_ok "저장됨: $CONFIG_PATH"
        echo ""
        echo "  적용된 설정:"
        printf "    %-14s %s\n" "provider id" "$NEW_P_ID"
        printf "    %-14s %s\n" "name"        "$NEW_P_NAME"
        printf "    %-14s %s\n" "npm"         "$NEW_P_NPM"
        printf "    %-14s %s\n" "baseURL"     "$NEW_P_BASEURL"
        printf "    %-14s %s\n" "apiKey"      "{env:$NEW_ENV_VAR}"
        printf "    %-14s %s\n" "└ 실제 값"   "$(mask_key "$NEW_KEY_VALUE") → $ENV_FILE"
        printf "    %-14s %s\n" "model id"    "$NEW_M_ID"
        printf "    %-14s %s\n" "context"     "$NEW_M_CONTEXT"
        printf "    %-14s %s\n" "output"      "$NEW_M_OUTPUT"
        echo "    → 기본 모델    $NEW_P_ID/$NEW_M_ID"
        echo ""
      fi
    fi
  fi

  # 플러그인 등록은 이 스크립트가 대신 하지 않는다 — 사용자가 직접 실행한다.
  log_info "플러그인 등록은 아래를 직접 실행하세요:"
  log_info "  gdc --init-opencode --global"
fi

echo ""
echo "============================================"
echo "  OpenCode 설치 완료"
echo "============================================"
echo ""
echo "  플랫폼:    $SEL_PLATFORM"
[ -n "$VERSION" ] && echo "  버전:      v$VERSION"
echo "  설치 경로: $BIN_DIR"
[ -n "${CONFIG_PATH:-}" ] && echo "  설정 파일: $CONFIG_PATH"
echo ""
if [ "$SEL_OS" = "$CURRENT_OS" ]; then
  echo "  새 터미널을 열거나 아래를 실행하세요:"
  echo "    source ${RC_FILE:-~/.bashrc}"
  echo ""
  echo "  플러그인 등록:"
  echo "    gdc --init-opencode --global"
  echo ""
fi
