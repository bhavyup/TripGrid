"""Memory measurement: peak RSS of the whole process tree.

DESIGN Traps B: never measure just the main PID — workers and
children count too. A background thread samples every 50 ms so short
peaks between chunks are not missed.
"""
from __future__ import annotations

import threading
import time

import psutil


def tree_rss_mb(proc: psutil.Process | None = None) -> float:
    proc = proc or psutil.Process()
    total = 0
    try:
        total += proc.memory_info().rss
    except psutil.NoSuchProcess:
        pass
    for child in proc.children(recursive=True):
        try:
            total += child.memory_info().rss
        except psutil.NoSuchProcess:
            pass
    return total / (1 << 20)


class PeakSampler:
    """Context manager: samples tree RSS in the background, keeps the max."""

    def __init__(self, interval_s: float = 0.05):
        self.interval_s = interval_s
        self.peak_mb = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _run(self) -> None:
        proc = psutil.Process()
        while not self._stop.is_set():
            self.peak_mb = max(self.peak_mb, tree_rss_mb(proc))
            time.sleep(self.interval_s)

    def __enter__(self) -> "PeakSampler":
        self.peak_mb = max(self.peak_mb, tree_rss_mb())
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)
        self.peak_mb = max(self.peak_mb, tree_rss_mb())
