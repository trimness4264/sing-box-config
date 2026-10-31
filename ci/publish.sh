#!/bin/sh
set -eu

root=$1
release=$2
group=$3
shift 3
staged="$root/releases/$release"

test -d "$staged"
test "$#" -gt 0
for file in "$@"; do
    case "$file" in
        ''|.*|*[!A-Za-z0-9._-]*) echo 'Invalid platform filename' >&2; exit 1 ;;
    esac
    case "$file" in
        *.json) ;;
        *) echo 'Platform file must end in .json' >&2; exit 1 ;;
    esac
    test -f "$staged/$file"
done
(
    cd "$staged"
    sha256sum -c SHA256SUMS
)
chgrp "$group" "$staged" "$staged/SHA256SUMS"
chmod 2750 "$staged"
chmod 640 "$staged/SHA256SUMS"
for file in "$@"; do
    chgrp "$group" "$staged/$file"
    chmod 640 "$staged/$file"
done

# Never replace a real directory or regular file at the publication pointer.
if [ -e "$root/current" ] && [ ! -L "$root/current" ]; then
    echo 'current exists and is not a symlink; refusing to replace it' >&2
    exit 1
fi

ln -s "releases/$release" "$root/.current-$release"
# GNU mv performs a single atomic rename instead of following the old symlink.
mv -Tf "$root/.current-$release" "$root/current"
