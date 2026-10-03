#!/bin/sh
set -eu
umask 077

fail() {
    printf '%s\n' "$1" >&2
    exit 1
}

# Restrict interpolated values to scalars, not shell/YAML/config syntax.
case "${TURN_DOMAIN:-}" in
    ''|*[!A-Za-z0-9.-]*|.*|*..*|*.|-*|*-)
        fail 'TURN_DOMAIN must be a DNS hostname without a scheme or port.' ;;
esac

secret_file=${TURN_SHARED_SECRET_PATH:-/run/secrets/turn_shared_secret}
runtime_dir=${TURN_RUNTIME_DIR:-/tmp}
test -f "$secret_file" && test -r "$secret_file" || fail 'TURN shared secret file is missing or unreadable.'
permissions=$(stat -c %a "$secret_file")
test "$permissions" = 600 || fail 'TURN shared secret file must have mode 0600.'
secret=$(cat "$secret_file")
case "$secret" in
    ''|*[!0-9a-fA-F]*) fail 'TURN shared secret must contain 64 hexadecimal characters.' ;;
esac
test "${#secret}" -eq 64 || fail 'TURN shared secret must contain 64 hexadecimal characters.'

case "${1:-}" in
    livekit)
        base_config=${LIVEKIT_BASE_CONFIG:-/etc/livekit.yaml}
        config="$runtime_dir/livekit-turn.yaml"
        # Preserve the actual base config; only insert rtc.turn_servers.
        awk -v host="$TURN_DOMAIN" -v secret_file="$secret_file" '
            { print }
            /^rtc:$/ {
                count++
                print "  turn_servers:"
                print "    - host: " host
                print "      port: 5349"
                print "      protocol: tls"
                print "      secret_file: " secret_file
                print "      ttl: 14400"
            }
            END { if (count != 1) exit 1 }
        ' "$base_config" > "$config" || fail 'Expected one top-level rtc section in the LiveKit base config.'
        unset secret
        if [ "${2:-}" = --check ]; then
            exit 0
        fi
        # Explicit flag prevents embedded TURN (and its hardcoded :443 URL).
        exec /livekit-server --config "$config" --turn.enabled=false
        ;;
    coturn)
        public_ip=${TURN_PUBLIC_IP:-}
        printf '%s\n' "$public_ip" | awk -F. '
            NR != 1 || NF != 4 { exit 1 }
            { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i > 255) exit 1 }
        ' || fail 'TURN_PUBLIC_IP must be the IPv4 address assigned to the host.'
        base_config=${COTURN_BASE_CONFIG:-/etc/coturn/base.conf}
        config="$runtime_dir/coturn.conf"
        cat "$base_config" > "$config"
        # The shared secret goes only into the private tmpfs config, never argv/env.
        # Native public sockets avoid remapping same-host SFU peers onto coturn.
        printf '\nrealm=%s\nserver-name=%s\nlistening-ip=%s\nrelay-ip=%s\nallowed-peer-ip=%s\nstatic-auth-secret=%s\n' \
            "$TURN_DOMAIN" "$TURN_DOMAIN" "$public_ip" "$public_ip" \
            "$public_ip" "$secret" >> "$config"
        unset secret
        if [ "${2:-}" = --check ]; then
            exit 0
        fi
        test -s /etc/coturn/tls/fullchain.pem && test -r /etc/coturn/tls/fullchain.pem || fail 'TURN certificate is missing, empty or unreadable.'
        test -s /etc/coturn/tls/privkey.pem && test -r /etc/coturn/tls/privkey.pem || fail 'TURN private key is missing, empty or unreadable.'
        exec /usr/bin/turnserver -c "$config"
        ;;
    *) fail 'Expected livekit or coturn mode.' ;;
esac
