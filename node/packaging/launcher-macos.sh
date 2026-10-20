#!/bin/sh
# YOLO Annotator — macOS desktop launcher.
#
# Behaviour:
#   * If a dataset is already known (saved choice, or the conventional
#     ~/Documents/YOLO Annotator folder), start immediately.
#   * Otherwise ask for the images folder and the obj.names file with real macOS
#     pickers, remember the answers, and start.
#
# Run with --reset to be asked again.
#
# Placeholders substituted at build time: @MAIN@ @DEFAULT_PORT@
set -e

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RES="$HERE/../Resources"
NODE="$RES/node/bin/node"
APP="$RES/app"
MAIN="$APP/@MAIN@"

CONFIG_DIR="$HOME/Library/Application Support/YOLO Annotator"
CONFIG="$CONFIG_DIR/dataset.conf"
DEFAULT_DATA="$HOME/Documents/YOLO Annotator"

mkdir -p "$CONFIG_DIR" 2>/dev/null || true

# "Forget the dataset" is triggered either by --reset or by a sentinel file,
# because a double-clicked .app cannot be given arguments. The reset shortcut
# writes the sentinel and launches the app.
RESET=0
for arg in "$@"; do
  [ "$arg" = "--reset" ] && RESET=1
done
FORGET="$CONFIG_DIR/forget-dataset"
if [ -f "$FORGET" ]; then
  RESET=1
  rm -f "$FORGET" 2>/dev/null || true
fi

# ---------------------------------------------------------------- preferences

read_pref() {
  # $1 = key
  [ -f "$CONFIG" ] || return 0
  sed -n "s|^$1=||p" "$CONFIG" 2>/dev/null | head -1
}

write_pref() {
  # $1 = images dir, $2 = classes file
  {
    printf 'images=%s\n' "$1"
    printf 'classes=%s\n' "$2"
  } > "$CONFIG" 2>/dev/null || true
}

IMAGES=""
CLASSES=""

if [ "$RESET" -eq 0 ]; then
  SAVED_IMAGES=$(read_pref images)
  SAVED_CLASSES=$(read_pref classes)
  if [ -n "$SAVED_IMAGES" ] && [ -d "$SAVED_IMAGES" ] && [ -n "$SAVED_CLASSES" ] && [ -f "$SAVED_CLASSES" ]; then
    IMAGES="$SAVED_IMAGES"
    CLASSES="$SAVED_CLASSES"
  elif [ -d "$DEFAULT_DATA/images" ] && [ -f "$DEFAULT_DATA/obj.names" ] \
    && [ -n "$(find "$DEFAULT_DATA/images" -type f -iname '*.jpg' -o -type f -iname '*.png' 2>/dev/null | head -1)" ]; then
    # The conventional folder already has images: use it without asking.
    IMAGES="$DEFAULT_DATA/images"
    CLASSES="$DEFAULT_DATA/obj.names"
  fi
fi

# ------------------------------------------------------------------- pickers

if [ -z "$IMAGES" ]; then
  PICKED=$(osascript <<'APPLESCRIPT' 2>/dev/null || true
try
  set imagesFolder to choose folder with prompt "Select the folder that contains your images"
  set classesFile to choose file with prompt "Select your classes file (for example obj.names)"
  return (POSIX path of imagesFolder) & "\n" & (POSIX path of classesFile)
on error number -128
  return "CANCELLED"
end try
APPLESCRIPT
)

  if [ "$PICKED" = "CANCELLED" ] || [ -z "$PICKED" ]; then
    exit 0
  fi

  IMAGES=$(printf '%s' "$PICKED" | sed -n '1p')
  CLASSES=$(printf '%s' "$PICKED" | sed -n '2p')
  # `choose folder` returns a trailing slash; drop it so paths compare cleanly.
  IMAGES=$(printf '%s' "$IMAGES" | sed 's|/$||')

  if [ ! -d "$IMAGES" ] || [ ! -f "$CLASSES" ]; then
    osascript -e 'display dialog "That selection could not be read.\n\nChoose a folder for the images and a text file for the classes." buttons {"OK"} default button 1 with title "YOLO Annotator" with icon caution' >/dev/null 2>&1 || true
    exit 1
  fi

  write_pref "$IMAGES" "$CLASSES"
fi

# -------------------------------------------------------------------- server

DATA="$DEFAULT_DATA"
mkdir -p "$DATA/images" 2>/dev/null || true

# Port 0 asks the OS for a free port, so a second launch never fights the first.
LOG="${TMPDIR:-/tmp}/yolo-annotator.$$.log"
"$NODE" "$MAIN" "$IMAGES" "$CLASSES" --port 0 --print-url "$@" > "$LOG" 2>&1 &
PID=$!

URL=""
i=0
while [ "$i" -lt 240 ]; do
  LINE=$(grep -e '^URL=' "$LOG" 2>/dev/null | head -1 || true)
  if [ -n "$LINE" ]; then
    URL=$(printf '%s' "$LINE" | cut -c5-)
    break
  fi
  kill -0 "$PID" 2>/dev/null || break
  i=$((i + 1))
  sleep 0.25
done

if [ -z "$URL" ]; then
  if curl -sf -m 2 "http://127.0.0.1:@DEFAULT_PORT@/api/images" >/dev/null 2>&1; then
    URL="http://127.0.0.1:@DEFAULT_PORT@/"
  else
    # Started from Finder there is no terminal, so explain in a dialog.
    DETAIL=$(grep -v '^URL=' "$LOG" 2>/dev/null | grep -v '^$' | tail -3)
    [ -z "$DETAIL" ] && DETAIL=$(cat "$LOG" 2>/dev/null)

    COUNT=$(find "$IMAGES" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \
      -o -iname '*.bmp' -o -iname '*.webp' -o -iname '*.tif' -o -iname '*.tiff' \) 2>/dev/null | wc -l | tr -d ' ')

    if [ "${COUNT:-0}" -eq 0 ]; then
      MESSAGE="That images folder has no images in it yet.

Folder:
$IMAGES

Put your images there, then open YOLO Annotator again."
    else
      MESSAGE="YOLO Annotator could not start.

$DETAIL"
    fi

    CHOICE=$(osascript -e "display dialog \"$MESSAGE\" buttons {\"Open images folder\", \"Choose another folder\", \"Close\"} default button \"Open images folder\" with title \"YOLO Annotator\" with icon note" 2>/dev/null || true)
    case "$CHOICE" in
      *"Open images folder"*) open "$IMAGES" 2>/dev/null || true ;;
      *"Choose another folder"*) : > "$FORGET" 2>/dev/null || true ;;
    esac
    rm -f "$LOG" 2>/dev/null || true
    exit 0
  fi
fi

if ! open "$URL" 2>/dev/null; then
  echo "Open $URL in your browser."
fi

wait "$PID"
rm -f "$LOG" 2>/dev/null || true
