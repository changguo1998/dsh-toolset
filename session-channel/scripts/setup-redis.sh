#!/usr/bin/env sh
# session-channel 专用 Redis 实例安装脚本（BACKLOG #30 的路 B）。
#
# 做什么：写 `$DSH_HOME/session-channel/redis.conf`（只开 unix socket、独立数据目录）+
#        写用户级 systemd 服务 `~/.config/systemd/user/dsh-session-channel-redis.service` +
#        `systemctl --user enable --now` + 验证 PING。
# 不做什么：不 sudo、不写系统路径、**不动系统 Redis 实例与其配置**。
# 幂等：重复执行只重写同样内容并确保服务处于启用/运行态；`--uninstall` 可逆。
#
# 用法：session-channel/scripts/setup-redis.sh [选项]
#   --linger     同时 `loginctl enable-linger`（登出后仍常驻）
#   --uninstall  停用并删除用户级服务与 unit 文件（配置文件与数据默认保留）
#   --purge      与 --uninstall 同用：连配置与数据目录一起删除
#   --manual     只写配置文件与 unit 文件，不调 systemctl（无用户管理器/容器内用；
#                之后可手动 `redis-server <conf>` 启动）
#   --dry-run    只打印将执行的动作
#   -h, --help   显示本帮助
set -eu

DSH_HOME=${DSH_HOME:-$HOME/.dsh}
CONF_DIR=$DSH_HOME/session-channel
CONF=$CONF_DIR/redis.conf
DATA_DIR=$CONF_DIR/data
RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
SOCK=$RUNTIME_DIR/dsh-session-channel.sock
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
UNIT=$UNIT_DIR/dsh-session-channel-redis.service

LINGER=0
UNINSTALL=0
PURGE=0
DRY=0
MANUAL=0

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
    printf '[session-channel-redis] 错误：%s\n' "$*" >&2
    exit 1
}

log() { printf '[session-channel-redis] %s\n' "$*"; }

have() { command -v "$1" > /dev/null 2>&1; }

run() {
    if [ "$DRY" = 1 ]; then
        printf '[dry-run] %s\n' "$*"
        return 0
    fi
    "$@"
}

for arg in "$@"; do
    case "$arg" in
        --linger) LINGER=1 ;;
        --uninstall) UNINSTALL=1 ;;
        --purge) PURGE=1 ;;
        --manual) MANUAL=1 ;;
        --dry-run) DRY=1 ;;
        -h | --help)
            usage
            exit 0
            ;;
        *) die "未知参数：$arg（用 --help 看用法）" ;;
    esac
done

[ "$PURGE" = 1 ] && [ "$UNINSTALL" = 0 ] && die "--purge 需与 --uninstall 同用"

if [ "$UNINSTALL" = 1 ]; then
    log "停用并删除用户级服务：$UNIT"
    run systemctl --user disable --now dsh-session-channel-redis.service || true
    run rm -f "$UNIT"
    run systemctl --user daemon-reload || true
    if [ "$PURGE" = 1 ]; then
        log "删除配置与数据目录：$CONF_DIR"
        run rm -rf "$CONF_DIR"
    else
        log "保留配置与数据：$CONF_DIR（要一并删除加 --purge）"
    fi
    log "完成（系统 Redis 未受影响）"
    exit 0
fi

have redis-server || die "未找到 redis-server：先安装（如 apt install redis-server）"
if [ "$MANUAL" = 0 ]; then
    have systemctl || die "未找到 systemctl（用户级服务需要 systemd）；加 --manual 只写文件，或手动启动：redis-server $CONF"
fi

log "配置目录：$CONF_DIR"
run mkdir -p "$CONF_DIR" "$DATA_DIR" "$UNIT_DIR"
# socket 父目录（通常由 systemd 创建；container/临时环境可能缺，缺则自行创建）
[ -d "$RUNTIME_DIR" ] || run mkdir -p "$RUNTIME_DIR"

log "写专用实例配置：$CONF"
if [ "$DRY" = 0 ]; then
    cat > "$CONF" << EOF
# session-channel 专用 Redis 实例（由 session-channel/scripts/setup-redis.sh 生成；勿手工加系统级配置）
# 只开 unix socket：不占端口、不经网络、仅本用户可连
port 0
unixsocket $SOCK
unixsocketperm 700
# 独立数据目录（与系统 Redis 完全隔离）
dir $DATA_DIR
dbfilename dump.rdb
appendonly yes
appendfilename "appendonly.aof"
appenddirname "appendonlydir"
# 不写内存驱逐：消息不得被 maxmemory 策略静默丢弃
maxmemory-policy noeviction
# 快照（appendonly 之外的第二层保险）
save 900 1
EOF
fi

log "写用户级服务：$UNIT"
if [ "$DRY" = 0 ]; then
    cat > "$UNIT" << EOF
[Unit]
Description=dsh-session-channel dedicated Redis (unix socket $SOCK)
Documentation=file://$CONF_DIR/redis.conf

[Service]
Type=simple
ExecStart=$(command -v redis-server) $CONF
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
EOF
fi

if [ "$MANUAL" = 1 ]; then
    log "--manual：跳过 systemctl，手动启动：redis-server $CONF"
else
    log "启用并启动服务（systemctl --user）"
    run systemctl --user daemon-reload
    run systemctl --user enable --now dsh-session-channel-redis.service
    if [ "$LINGER" = 1 ]; then
        log "开启 linger（登出后常驻）"
        run loginctl enable-linger "$(id -un)" || log "linger 设置失败（可忽略：仍在当前会话内可用）"
    fi
fi

if [ "$MANUAL" = 1 ]; then
    log "手动启动后自行验证：redis-server $CONF && redis-cli -s $SOCK ping"
elif [ "$DRY" = 0 ]; then
    # 等服务监听 socket（最多约 5 秒）
    i=0
    while [ ! -S "$SOCK" ]; do
        i=$((i + 1))
        [ "$i" -gt 50 ] && die "等待 socket 超时：$SOCK（看 systemctl --user status dsh-session-channel-redis）"
        sleep 0.1
    done
    if have redis-cli; then
        reply=$(redis-cli -s "$SOCK" ping 2> /dev/null || true)
        [ "$reply" = "PONG" ] || die "PING 失败（回复：${reply:-空}）"
        log "验证通过：redis-cli -s $SOCK ping → PONG"
    else
        log "未找到 redis-cli，跳过 PING 验证"
    fi
fi

log "完成。插件默认连接 $SOCK；如需改地址用 DSH_SESSION_CHANNEL_REDIS_URL 覆盖。"
log "状态：systemctl --user status dsh-session-channel-redis；卸载：$0 --uninstall"
