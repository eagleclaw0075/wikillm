#!/bin/bash
# Double-click this file to start WikiLLM and open it in your browser.
cd "$(dirname "$0")"
exec python3 server.py "$@"
