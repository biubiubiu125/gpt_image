#!/bin/sh
set -eu

# 用环境变量替换前端默认 API URL。显式传入空字符串时保留为空。
if [ "${DEFAULT_API_URL+x}" != "x" ]; then
    DEFAULT_API_URL=${API_URL:-https://api.veridiantech1.com}
fi
DOCKER_LEGACY_API_URL_USED=${DOCKER_LEGACY_API_URL_USED:-false}
if [ -n "${API_URL:-}" ]; then
    DOCKER_LEGACY_API_URL_USED=true
fi

normalize_legacy_api_proxy_url() {
    case "$1" in
        http://*|https://*)
            # 复现旧版客户端的 URL 规则：无尾斜杠时保留已有路径并补 /v1，
            # 已存在 /v1 段时截断到该段；尾斜杠表示直接拼接，不补版本路径。
            # 查询参数和片段只用于前端预置配置，不应成为代理上游的路径。
            legacy_url=${1%%\?*}
            legacy_url=${legacy_url%%\#*}
            legacy_scheme=${legacy_url%%://*}
            legacy_authority_and_path=${legacy_url#*://}
            legacy_authority=${legacy_authority_and_path%%/*}
            legacy_path=${legacy_authority_and_path#"$legacy_authority"}
            legacy_origin="${legacy_scheme}://${legacy_authority}"
            legacy_remaining=${legacy_path#/}
            legacy_normalized_path=
            legacy_has_v1=false

            while [ -n "$legacy_remaining" ]; do
                case "$legacy_remaining" in
                    */*)
                        legacy_segment=${legacy_remaining%%/*}
                        legacy_remaining=${legacy_remaining#*/}
                        ;;
                    *)
                        legacy_segment=$legacy_remaining
                        legacy_remaining=
                        ;;
                esac
                [ -n "$legacy_segment" ] || continue
                if [ -n "$legacy_normalized_path" ]; then
                    legacy_normalized_path="$legacy_normalized_path/$legacy_segment"
                else
                    legacy_normalized_path="/$legacy_segment"
                fi
                if [ "$legacy_segment" = "v1" ]; then
                    legacy_has_v1=true
                    break
                fi
            done

            if [ "$legacy_has_v1" = "true" ]; then
                printf '%s%s' "$legacy_origin" "$legacy_normalized_path"
            else
                case "$legacy_url" in
                    */)
                        printf '%s' "$legacy_url"
                        ;;
                    *)
                        printf '%s%s/v1' "$legacy_origin" "$legacy_path"
                        ;;
                esac
            fi
            ;;
        *)
            printf '%s' "$1"
            ;;
    esac
}

if [ -z "${API_PROXY_URL:-}" ]; then
    API_PROXY_URL=${API_URL:-https://api.veridiantech1.com/v1}
    if [ -n "${API_URL:-}" ]; then
        API_PROXY_URL=$(normalize_legacy_api_proxy_url "$API_PROXY_URL")
    fi
fi

normalize_api_proxy_url() {
    case "$1" in
        http://*|https://*)
            printf '%s' "$1" | sed 's#/*$##'
            ;;
        *)
            printf '%s' "$1"
            ;;
    esac
}

API_PROXY_URL=$(normalize_api_proxy_url "$API_PROXY_URL")
export API_PROXY_URL

API_PROXY_AVAILABLE=false
if [ "${ENABLE_API_PROXY:-false}" = "true" ]; then
    API_PROXY_AVAILABLE=true
fi

API_PROXY_LOCKED=false
if [ "${ENABLE_API_PROXY:-false}" = "true" ] && [ "${LOCK_API_PROXY:-false}" = "true" ]; then
    API_PROXY_LOCKED=true
fi

PRESET_CONFIG_ONLY=false
if [ "${SHOW_PRESET_CONFIG_ONLY:-false}" = "true" ] || [ "${SHOW_DEFAULT_CONFIG_ONLY:-false}" = "true" ]; then
    PRESET_CONFIG_ONLY=true
fi

PRESET_CONFIG_PARAMS_LOCKED=false
if [ "${LOCK_PRESET_CONFIG_PARAMS:-false}" = "true" ]; then
    PRESET_CONFIG_PARAMS_LOCKED=true
fi

PRESET_CONFIG_DELETION_PREVENTED=false
if [ "${PREVENT_PRESET_CONFIG_DELETION:-false}" = "true" ]; then
    PRESET_CONFIG_DELETION_PREVENTED=true
fi

escape_sed_replacement() {
    printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

escape_js_string() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

DEFAULT_API_URL_TRIMMED=$(printf '%s' "$DEFAULT_API_URL" | sed 's/^[[:space:]]*//')
case "$DEFAULT_API_URL_TRIMMED" in
    http://*|https://*)
        DEFAULT_CONFIG_URL_PATH=${DEFAULT_API_URL_TRIMMED%%\?*}
        DEFAULT_CONFIG_URL_PATH=${DEFAULT_CONFIG_URL_PATH%%\#*}
        DEFAULT_CONFIG_URL_PATH_LOWER=$(printf '%s' "$DEFAULT_CONFIG_URL_PATH" | tr '[:upper:]' '[:lower:]')
        case "$DEFAULT_CONFIG_URL_PATH_LOWER" in
            *.json)
                if ! DEFAULT_CONFIG_JSON=$(wget -qO- "$DEFAULT_API_URL_TRIMMED"); then
                    echo "预置配置请求失败：$DEFAULT_API_URL_TRIMMED" >&2
                    exit 1
                fi
                DEFAULT_API_URL="embedded-config:$(printf '%s' "$DEFAULT_CONFIG_JSON" | base64 | tr -d '\n')"
                ;;
        esac
        ;;
    file://*)
        DEFAULT_CONFIG_PATH=${DEFAULT_API_URL_TRIMMED#file://}
        if [ ! -f "$DEFAULT_CONFIG_PATH" ]; then
            echo "预置配置文件不存在：$DEFAULT_CONFIG_PATH" >&2
            exit 1
        fi
        DEFAULT_API_URL="embedded-config:$(base64 < "$DEFAULT_CONFIG_PATH" | tr -d '\n')"
        ;;
    *)
        if [ -f "$DEFAULT_API_URL_TRIMMED" ]; then
            DEFAULT_API_URL="embedded-config:$(base64 < "$DEFAULT_API_URL_TRIMMED" | tr -d '\n')"
        else
            case "$DEFAULT_API_URL_TRIMMED" in
                *.json)
                    echo "预置配置文件不存在：$DEFAULT_API_URL_TRIMMED" >&2
                    exit 1
                    ;;
            esac
        fi
        ;;
esac
DEFAULT_API_URL_ESCAPED=$(escape_sed_replacement "$(escape_js_string "$DEFAULT_API_URL")")

# 查找所有 js 文件并将占位符替换为运行时配置
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DEFAULT_API_URL_PLACEHOLDER__|$DEFAULT_API_URL_ESCAPED|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__|$API_PROXY_AVAILABLE|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_API_PROXY_LOCKED_PLACEHOLDER__|$API_PROXY_LOCKED|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__|true|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__|$DOCKER_LEGACY_API_URL_USED|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_SHOW_PRESET_CONFIG_ONLY_PLACEHOLDER__|$PRESET_CONFIG_ONLY|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_LOCK_PRESET_CONFIG_PARAMS_PLACEHOLDER__|$PRESET_CONFIG_PARAMS_LOCKED|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_PREVENT_PRESET_CONFIG_DELETION_PLACEHOLDER__|$PRESET_CONFIG_DELETION_PREVENTED|g" {} +

# 检查是否启用了 API 代理
if [ "${ENABLE_API_PROXY:-false}" != "true" ]; then
    # 删除代理配置块
    sed -i '/# BEGIN API PROXY/,/# END API PROXY/d' /etc/nginx/conf.d/default.conf
fi

exec "$@"
