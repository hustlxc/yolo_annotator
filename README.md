# yolo_annotator

A minimal YOLO bounding-box annotator. Draw boxes on your images, get a darknet
label file next to each one. Two implementations ship in this repository:

| | Language | Location | Needs |
| --- | --- | --- | --- |
| Original | C++ / OpenCV | [`main.cpp`](main.cpp) | OpenCV + a compiler |
| **Cross-platform port** | **TypeScript / Node.js** | **[`node/`](node/README.md)** | **Node.js only** |

Both accept the same two arguments, read the same `obj.names`, and write the same
`image.txt` label format — so you can switch between them on the same dataset.

## Quick start (TypeScript / Node.js — recommended)

```bash
cd node
npm start -- ../images ../obj.names
```

A browser opens at `http://127.0.0.1:7860/`. Press <kbd>Esc</kbd> to save and quit.

See [`node/README.md`](node/README.md) for the full documentation: options, HTTP
API, keyboard reference, security model and design notes.

## Quick start (C++ / OpenCV)

Make sure you have installed OpenCV.

```bash
# 1. Compile it with g++
g++ -o yolo_annotator main.cpp `pkg-config --cflags --libs opencv` -std=c++17 -Wall -O3

# 2. Compile it with cmake and make
mkdir -p build && cd build && cmake .. && make && mv yolo_annotator ../
```

```bash
./yolo_annotator images obj.names
```

## Usage

```bash
./yolo_annotator <images-directory> <classes-file>
node node/src/server/main.ts <images-directory> <classes-file>
```

`obj.names` holds one class name per line:

```
left
right
```

For every `images/photo.jpg` the annotator writes `images/photo.txt`:

```
<class-id> <x-centre> <y-centre> <width> <height>
```

All four numbers are normalised to `0..1` relative to the image size. An empty
box list produces an empty label file.

## Keyboard Shortcuts

Shortcut | Description | Node.js port |
--- | --- | --- |
<kbd>n, N</kbd> | Next image | same |
<kbd>p, P</kbd> | Previous image | same |
<kbd>c, C</kbd> | Change class | same |
<kbd>d, D</kbd> | Delete last box | same |
<kbd>j, J</kbd> | Jump to specific image | dialog instead of terminal input |
<kbd>ESC</kbd> | Close application | saves and stops the server |
— | — | plus: box select/move/nudge, undo (<kbd>Ctrl</kbd>+<kbd>Z</kbd>), zoom, pan (<kbd>Space</kbd>+drag or the ✋ button), fit (<kbd>0</kbd>), per-group progress |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The image is clipped by the window edges | Fixed — the image is fitted to the window on load. Press <kbd>0</kbd> (or the percentage button) to fit at any time |
| Cannot draw while zoomed in | Fixed — dragging always draws. To move around a zoomed image use <kbd>Space</kbd>+drag, the ✋ button, or <kbd>h</kbd> |
| `port 7860 is already in use` | The server tries the next free port automatically; use `--port 8080` to choose one, or `--no-auto-port` to fail loudly |
| `no images found` | Only `.jpg .jpeg .png .bmp .webp .tif .tiff` are indexed |
| Browser did not open | The URL is printed in the terminal — open it manually, or pass `--no-open` |
| Server still running after closing the tab | <kbd>Ctrl</kbd>+<kbd>C</kbd> in the terminal |
