# Break-room sheet

`points-and-rules.html` is the source; `points-and-rules.png` is what goes on the
TV. The wording is Andrew's own, from 28 September 2026 and 2 October 2026,
copied exactly, because this is the sheet the crew are held to.

Nineteen rows is close to the limit of the left column. The row height is set by
the number in the pill, not the words beside it, so if another rule is added and
the bottom of the list disappears behind the footer, look at `.r .p` before
touching the text. Serving the folder and measuring is quicker than guessing:

    node -e "require('http').createServer((q,s)=>s.end(require('fs').readFileSync('points-and-rules.html'))).listen(3100)"

then compare `.rows` height against the sum of its children in the console.

To regenerate after a rule changes, edit the HTML and run:

    "C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
      --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
      --window-size=1920,1080 --virtual-time-budget=8000 \
      --screenshot="points-and-rules.png" \
      "file:///E:/Andrew-%20Share%20profit/revenue-share/breakroom/points-and-rules.html"

The page is a fixed 1920x1080 canvas, so the PNG comes out at exactly TV size.
