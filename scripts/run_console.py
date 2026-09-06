#!/usr/bin/env python3
"""One-click PROBE console launcher: starts the server and opens the browser."""
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PORT = 8765
URL = f"http://127.0.0.1:{PORT}"


def main() -> None:
    print(f"🔬 PROBE Console starting at {URL}")
    import uvicorn
    from probe.web.server import app

    def open_browser() -> None:
        time.sleep(1.5)
        webbrowser.open(URL)

    threading.Thread(target=open_browser, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
