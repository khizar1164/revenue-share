# Break-room sheet

`points-and-rules.html` is the source; `points-and-rules.png` is what goes on the
TV. The wording is Andrew's own, from 28 September 2026, copied exactly, because
this is the sheet the crew are held to.

To regenerate after a rule changes, edit the HTML and run:

    "C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
      --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
      --window-size=1920,1080 --virtual-time-budget=8000 \
      --screenshot="points-and-rules.png" \
      "file:///E:/Andrew-%20Share%20profit/revenue-share/breakroom/points-and-rules.html"

The page is a fixed 1920x1080 canvas, so the PNG comes out at exactly TV size.
