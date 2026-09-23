"""Helpers the numbered tools/data scripts share.

The scripts run as `python3 tools/data/NN_*.py`, so this directory's parent is on `sys.path` and
they import these modules as `datalib.<module>`. Nothing here needs a third-party package at
import time: `zstandard`, `onnx` and friends are imported by the caller (and passed in) or inside
the function that needs them, so each script keeps its own "pip install …" message.
"""
