ROOM IMAGES — a hot folder, like portraits and sprites.

Drop an image here named exactly after a room/location ("Zone 0.png",
"Z0 — Swan Room.png", ...) and it automatically becomes that room's look —
no settings, no manual updates. Click RESCAN in the Jukebox tab (or reload)
to pick up new files without restarting.

- The image is stretched to the room's Size (set in the Location tab).
  The built-in Zone 0 rooms are exactly 1.5x the 320-wide reference art,
  so a 320x1152 map or 320x240 interior scales cleanly.
- The room's floors/structs stop being drawn and become INVISIBLE COLLISION:
  floors = where players can walk, structs/blocks = where they can't.
  Players only ever see your image.
- The GM's CREATE view shows the collision as a translucent overlay on top
  of the image so you can drag it into place.
- png / webp / gif / jpg all work.
