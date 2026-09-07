#!/bin/sh

DEFAULT_API_FALLBACK=https://api.veridiantech1.com/v1
API_PROXY_FALLBACK=https://api.veridiantech1.com/v1

runtime_normalize_legacy_api_proxy_url() {
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

runtime_normalize_api_proxy_url() {
    value=$1
    case "$value" in
        http://|https://|''|*[[:space:]]*|*\?*|*\#*|*\;*|*\{*|*\}*|*\"*|*\\*|*\$*)
            echo "API_PROXY_URL 必须是无查询参数、无片段、无空白的 HTTP(S) 基础地址" >&2
            return 1
            ;;
        http://*|https://*)
            ;;
        *)
            echo "API_PROXY_URL 必须使用 http:// 或 https://" >&2
            return 1
            ;;
    esac

    normalized=$(printf '%s' "$value" | sed 's#/*$##')
    authority=${normalized#*://}
    case "$authority" in
        ''|/*)
            echo "API_PROXY_URL 缺少有效的主机名" >&2
            return 1
            ;;
    esac
    runtime_validate_api_proxy_authority "${authority%%/*}" || return 1
    printf '%s' "$normalized"
}

runtime_validate_resolver_list() {
    value=$1
    if ! printf '%s\n' "$value" | awk '
        function valid_hex_group(value) {
            return value ~ "^[0-9A-Fa-f][0-9A-Fa-f]?[0-9A-Fa-f]?[0-9A-Fa-f]?$"
        }
        function group_count(value, groups, i, count) {
            if (value == "") return 0
            count = split(value, groups, ":")
            for (i = 1; i <= count; i++) {
                if (!valid_hex_group(groups[i])) return -1
            }
            return count
        }
        function valid_ipv4(value, octets, i, count) {
            if (value !~ "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$") return 0
            count = split(value, octets, ".")
            for (i = 1; i <= count; i++) {
                if (octets[i] > 255) return 0
            }
            return 1
        }
        function valid_ipv6(value, separator, left, right, left_count, right_count) {
            if (value !~ /^[0-9A-Fa-f:]+$/ || value !~ /:/ || value ~ /:::/) return 0
            separator = index(value, "::")
            if (separator > 0) {
                if (index(substr(value, separator + 2), "::") > 0) return 0
                left = substr(value, 1, separator - 1)
                right = substr(value, separator + 2)
                left_count = group_count(left)
                right_count = group_count(right)
                return left_count >= 0 && right_count >= 0 && left_count + right_count < 8
            }
            return group_count(value) == 8
        }
        {
            if (NF == 0) exit 1
            for (i = 1; i <= NF; i++) {
                token = $i
                bracketed = substr(token, 1, 1) == "["
                if ((substr(token, 1, 1) == "[" && substr(token, length(token), 1) != "]") ||
                    (substr(token, 1, 1) != "[" && substr(token, length(token), 1) == "]")) {
                    exit 1
                }
                sub(/^\[/, "", token)
                sub(/\]$/, "", token)
                if (bracketed && index(token, ":") == 0) exit 1
                if (!valid_ipv4(token) && !valid_ipv6(token)) exit 1
            }
        }
    '; then
        echo "NGINX_RESOLVER 必须是一个或多个 DNS IP 地址" >&2
        return 1
    fi
}

runtime_format_resolver_list() {
    printf '%s\n' "$1" | awk '{
        separator = ""
        for (i = 1; i <= NF; i++) {
            token = $i
            if (index(token, ":") > 0 && substr(token, 1, 1) != "[") {
                token = "[" token "]"
            }
            printf "%s%s", separator, token
            separator = " "
        }
    }'
}

runtime_discover_nginx_resolver() {
    if [ -n "${NGINX_RESOLVER:-}" ]; then
        runtime_validate_resolver_list "$NGINX_RESOLVER" || return 1
        runtime_format_resolver_list "$NGINX_RESOLVER"
        return 0
    fi

    resolver_list=$(awk '
        $1 == "nameserver" && $2 != "" {
            if ($2 ~ /:/) printf "[%s] ", $2
            else printf "%s ", $2
        }
    ' /etc/resolv.conf | sed 's/[[:space:]]*$//')
    if [ -z "$resolver_list" ]; then
        echo "无法从 /etc/resolv.conf 获取 Nginx DNS resolver，请设置 NGINX_RESOLVER" >&2
        return 1
    fi
    runtime_validate_resolver_list "$resolver_list" || return 1
    printf '%s' "$resolver_list"
}

runtime_validate_api_proxy_port() {
    port=$1
    case "$port" in
        ''|*[!0-9]*)
            echo "API_PROXY_URL 的端口必须是 1 到 65535 之间的数字" >&2
            return 1
            ;;
    esac
    if ! awk -v port="$port" 'BEGIN { if (port >= 1 && port <= 65535) exit 0; exit 1 }'; then
        echo "API_PROXY_URL 的端口必须是 1 到 65535 之间的数字" >&2
        return 1
    fi
}

runtime_validate_api_proxy_authority() {
    authority=$1
    case "$authority" in
        ''|*@*)
            echo "API_PROXY_URL 的主机部分无效" >&2
            return 1
            ;;
    esac

    case "$authority" in
        \[*\]*)
            api_proxy_host=${authority#\[}
            api_proxy_host=${api_proxy_host%%\]*}
            api_proxy_suffix=${authority#*\]}
            case "$api_proxy_host" in
                *:*) ;;
                *)
                    echo "API_PROXY_URL 的方括号主机必须是 IPv6 地址" >&2
                    return 1
                    ;;
            esac
            if ! runtime_validate_resolver_list "[$api_proxy_host]" >/dev/null 2>&1; then
                echo "API_PROXY_URL 的 IPv6 主机地址无效" >&2
                return 1
            fi
            case "$api_proxy_suffix" in
                '') ;;
                :*) runtime_validate_api_proxy_port "${api_proxy_suffix#:}" || return 1 ;;
                *)
                    echo "API_PROXY_URL 的端口部分无效" >&2
                    return 1
                    ;;
            esac
            ;;
        *'['*|*']'*)
            echo "API_PROXY_URL 的主机方括号不匹配" >&2
            return 1
            ;;
        *:*)
            api_proxy_host=${authority%:*}
            api_proxy_port=${authority##*:}
            case "$api_proxy_host" in
                ''|*:*|*[!A-Za-z0-9._-]*)
                    echo "API_PROXY_URL 的主机部分无效" >&2
                    return 1
                    ;;
            esac
            runtime_validate_api_proxy_port "$api_proxy_port" || return 1
            ;;
        *)
            case "$authority" in
                ''|*[!A-Za-z0-9._-]*)
                    echo "API_PROXY_URL 的主机部分无效" >&2
                    return 1
                    ;;
            esac
            ;;
    esac
}

runtime_prepare_api_environment() {
    DOCKER_LEGACY_API_URL_USED=false
    if [ -n "${API_URL:-}" ]; then
        DOCKER_LEGACY_API_URL_USED=true
    fi

    if [ "${DEFAULT_API_URL+x}" != "x" ]; then
        DEFAULT_API_URL=${API_URL:-$DEFAULT_API_FALLBACK}
    fi

    if [ -z "${API_PROXY_URL:-}" ]; then
        API_PROXY_URL=${API_URL:-$API_PROXY_FALLBACK}
        if [ -n "${API_URL:-}" ]; then
            API_PROXY_URL=$(runtime_normalize_legacy_api_proxy_url "$API_PROXY_URL")
        fi
    fi

    if ! API_PROXY_URL=$(runtime_normalize_api_proxy_url "$API_PROXY_URL"); then
        return 1
    fi
    if ! NGINX_RESOLVER=$(runtime_discover_nginx_resolver); then
        return 1
    fi

    export DEFAULT_API_URL
    export API_PROXY_URL
    export DOCKER_LEGACY_API_URL_USED
    export NGINX_RESOLVER
}
